#!/usr/bin/env node
/**
 * 真实上游端到端验证（不打桩：真 HTTP、真 Key、真模型）。
 *
 * 用本机 DSH profile 的真实凭据（先在环境里找，找不到再读 ~/.dsh/bifrost.env，
 * 与 DSH 启动时的加载方式一致）把插件挂在一个随机端口上，然后：
 *   1. GET  /webchat/models            目录是否列出可选模型
 *   2. POST /webchat/api/models        切到非 DeepSeek 官方模型
 *   3. POST /webchat/anthropic/v1/messages  用网页版真实请求形状要一次回答
 *   4. GET  /webchat/api/self-test     自检三项
 *   5. GET  /webchat/settings          设置页可见
 *   6. effort                          选档位 → 落盘 → 真上游请求体里带 reasoning_effort；
 *                                      不选 → 请求体里没有这个字段（记录型代理转发到真网关）
 *   7. 分组/模型切换                    切到另一家 provider 的模型，真上游按新 model 作答
 * 证据写到 --out，同时打印摘要。
 *
 * 上游是真实网关：插件的 baseURL 指向本进程内起的记录型反向代理，代理原样转发到
 * `--base`（默认 http://127.0.0.1:18088/openai/v1），只额外记录请求体，不生成回答。
 *
 * 用法：
 *   node test/live-e2e.mjs --model agent2api/glm-5.3-flash --model2 runanywhere/glm-5.3-flash \
 *     --base http://127.0.0.1:18088/openai/v1 --out docs/evidence/live-e2e.json
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createWebview } from '../src/webview.js'

/** 解析 --key value 形式的参数。 */
function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      index += 1
    }
  }
  return out
}

/** 从 ~/.dsh/bifrost.env 读一个变量（不打印值）。 */
function readEnvFile(file, name) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/u.exec(line)
      if (match === null || match[1] !== name) continue
      return match[2].trim().replace(/^['"]|['"]$/gu, '')
    }
  } catch {
    // 文件不存在就当作没配
  }
  return undefined
}

/** 起插件，返回 { url, close }。 */
async function boot(config, home) {
  const handler = createWebview({ get: () => undefined }, config, home)
  const server = http.createServer((req, res) => handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

/**
 * 记录型反向代理：请求体原样转发给真上游，同时把模型名与 reasoning_effort 记下来。
 *
 * 只做转发和记录，不生成任何内容——回答仍然是 `--base` 上真网关给的。
 * 返回的 `baseURL` 给插件当上游根路径用，`requests` 是已观察到的请求体摘要。
 */
async function startRecorder(targetBase) {
  const target = new URL(targetBase)
  const prefix = target.pathname.replace(/\/+$/u, '')
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      let body
      try {
        body = JSON.parse(raw.toString('utf8'))
      } catch {
        body = undefined
      }
      requests.push({
        method: req.method,
        path: req.url,
        model: body?.model,
        reasoningEffort: body?.reasoning_effort,
      })
      const headers = { ...req.headers, host: target.host }
      delete headers['transfer-encoding']
      headers['content-length'] = String(raw.length)
      const requestPath = req.url ?? '/'
      // 插件的 baseURL 已带 `/openai/v1`，它发来的路径本身就含这段前缀；
      // 已经是完整路径就原样转发，否则补上前缀（兼容只带 `/v1` 的写法）。
      const upstreamPath = requestPath.startsWith(prefix) ? requestPath : `${prefix}${requestPath}`
      const upstream = http.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: upstreamPath,
        method: req.method,
        headers,
      }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      })
      upstream.on('error', (error) => {
        if (res.headersSent) {
          res.end()
          return
        }
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: String(error?.message ?? error) } }))
      })
      upstream.end(raw)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseURL: `http://127.0.0.1:${port}${prefix}`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

/** 读一整条 SSE，顺手把 Anthropic 事件拆出来。 */
async function readStream(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let raw = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    raw += decoder.decode(value, { stream: true })
  }
  const events = []
  for (const block of raw.split('\n\n')) {
    const name = /^event: (.+)$/mu.exec(block)?.[1]
    const data = /^data: (.+)$/mu.exec(block)?.[1]
    if (name === undefined || data === undefined) continue
    try {
      events.push({ name, data: JSON.parse(data) })
    } catch {
      events.push({ name, data })
    }
  }
  return { raw, events }
}

/** 把 text_delta / thinking_delta 拼成正文。 */
function collectText(events) {
  let text = ''
  let thinking = ''
  for (const event of events) {
    if (event.name !== 'content_block_delta') continue
    if (event.data?.delta?.type === 'text_delta') text += event.data.delta.text
    if (event.data?.delta?.type === 'thinking_delta') thinking += event.data.delta.thinking
  }
  return { text, thinking }
}

const args = parseArgs(process.argv.slice(2))
const modelId = String(args.model ?? 'agent2api/glm-5.3-flash')
const labelled = String(args.label ?? modelId)
const modelId2 = String(args.model2 ?? 'runanywhere/glm-5.3-flash')
const labelled2 = String(args.label2 ?? modelId2)
const effort = String(args.effort ?? 'high')
const baseURL = String(args.base ?? 'http://127.0.0.1:18088/openai/v1')
const apiKeyEnv = String(args['key-env'] ?? 'BIFROST_VIRTUAL_KEY')

const key = process.env[apiKeyEnv] ?? readEnvFile(path.join(os.homedir(), '.dsh', 'bifrost.env'), apiKeyEnv)
if (key === undefined || key === '') {
  console.error(`缺少 ${apiKeyEnv}：请在环境里提供，或写进 ~/.dsh/bifrost.env`)
  process.exit(2)
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-in-dsh-e2e-'))
const evidence = {
  startedAt: new Date().toISOString(),
  profile: { home: os.homedir(), credential: apiKeyEnv, credentialSource: process.env[apiKeyEnv] === undefined ? '~/.dsh/bifrost.env' : 'process.env' },
  upstream: { baseURL, model: modelId, model2: modelId2, note: '插件上游指向进程内记录型代理，代理原样转发到 baseURL' },
  steps: [],
}
const record = (name, ok, detail, extra) => {
  evidence.steps.push({ name, ok, detail, ...(extra === undefined ? {} : { extra }) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
}

// ---- 0. 默认目录不变 ----
const defaultSite = await boot({ stateFile: path.join(home, 'default-state.json') }, home)
try {
  const body = await (await fetch(`${defaultSite.url}/webchat/models`)).json()
  record('默认目录未配置 models 时仍是官方单项', body.data.length === 1 && body.data[0].id === 'deepseek-flash', JSON.stringify(body.data))
} finally {
  await defaultSite.close()
}

// ---- 1..7 真上游（插件上游指向记录型代理，代理转发到真网关） ----
const stateFile = path.join(home, 'model-state.json')
const recorder = await startRecorder(baseURL)
const config = {
  stateFile,
  models: [
    { id: 'deepseek-flash', label: 'DeepSeek 网页版' },
    { id: labelled, label: `${labelled}（bifrost）`, api: 'openai', baseURL: recorder.baseURL, apiKeyEnv, upstreamModel: modelId },
    { id: labelled2, label: `${labelled2}（bifrost）`, api: 'openai', baseURL: recorder.baseURL, apiKeyEnv, upstreamModel: modelId2 },
  ],
}
const site = await boot(config, home)

/** 按网页版的真实请求形状发一次对话；extra 里的字段覆盖同名字段。 */
async function ask(extra = {}, prompt = '用一句话说明你是哪家公司训练的哪个模型。') {
  const started = Date.now()
  const response = await fetch(`${site.url}/webchat/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-flash',
      system: '你是一个测试助手，只回答问题本身。',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      thinking: { type: 'enabled' },
      safety_check: { level: 'high' },
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
      title: { enabled: false },
      max_tokens: 512,
      stream: true,
      ...extra,
    }),
    signal: AbortSignal.timeout(180_000),
  })
  const elapsedMs = Date.now() - started
  const stream = await readStream(response)
  const { text, thinking } = collectText(stream.events)
  return { status: response.status, elapsedMs, text, thinking, names: stream.events.map(event => event.name) }
}

/** 最近一次经代理发给上游的 chat.completions 请求体摘要。 */
function lastUpstreamRequest(sinceIndex) {
  return recorder.requests.slice(sinceIndex).filter(item => String(item.path).includes('/chat/completions')).at(-1)
}

try {
  const listed = await (await fetch(`${site.url}/webchat/models`)).json()
  record('可选模型列表', listed.data.some(item => item.id === labelled) && listed.data.some(item => item.id === labelled2), listed.data.map(item => `${item.id}/${item.api}`).join(', '))

  const switched = await (await fetch(`${site.url}/webchat/api/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: labelled }),
  })).json()
  record('切换到非官方模型', switched.ok === true && switched.active === labelled, JSON.stringify(switched))

  // 直接问一次上游：记录到底是哪家 provider / 哪个模型应答的（路由信息在 extra_fields 里）。
  try {
    const probe = await fetch(`${baseURL.replace(/\/+$/u, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }),
      signal: AbortSignal.timeout(120_000),
    })
    const json = await probe.json()
    const routing = json?.extra_fields?.routing_info
    record('上游路由确认（非 DeepSeek 官方）', probe.status === 200 && routing?.provider !== undefined && routing.provider !== 'deepseek', `provider=${routing?.provider} model=${routing?.resolved_model_used ?? routing?.model}`, routing ?? undefined)
  } catch (error) {
    record('上游路由确认（非 DeepSeek 官方）', false, String(error?.message ?? error))
  }

  const confirmed = await (await fetch(`${site.url}/webchat/api/models`)).json()
  record('选择已落盘', confirmed.active === labelled && JSON.parse(fs.readFileSync(stateFile, 'utf8')).model === labelled, `state=${confirmed.active}`)

  const first = await ask()
  record('真实对话 HTTP 200', first.status === 200, `status=${first.status} ${first.elapsedMs}ms`)
  record('Anthropic 事件序列完整', first.names.includes('message_start') && first.names.includes('content_block_delta') && first.names.includes('message_stop'), first.names.join(' → '))
  record('收到真实模型回答', first.text.trim() !== '', `${JSON.stringify(first.text.trim().slice(0, 160))}${first.thinking === '' ? '' : ` (thinking ${first.thinking.length} chars)`}`)

  const selfTest = await (await fetch(`${site.url}/webchat/api/self-test`)).json()
  record('自检三项', selfTest.ok === true, selfTest.checks.map(check => `${check.name}:${check.ok ? 'ok' : 'fail'}`).join(', '))

  const settings = await fetch(`${site.url}/webchat/settings`)
  const html = await settings.text()
  record('设置页可见可选模型', settings.status === 200 && html.includes(`value="${labelled}"`), `${html.length} bytes`)

  // ---- 6. effort：选档位 → 落盘 → 真上游请求体带 reasoning_effort ----
  const withEffort = await (await fetch(`${site.url}/webchat/api/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: labelled, effort }),
  })).json()
  const stateWithEffort = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  record(
    '选 effort：接口回读与状态文件一致',
    withEffort.ok === true && withEffort.active === labelled && withEffort.activeEffort === effort && stateWithEffort.effort === effort,
    `POST→${JSON.stringify(withEffort)} 文件→${JSON.stringify(stateWithEffort)}`,
  )

  const beforeEffortChat = recorder.requests.length
  const effortChat = await ask({ effort })
  const effortSent = lastUpstreamRequest(beforeEffortChat)
  record('带 effort 的真上游对话 200', effortChat.status === 200 && effortChat.text.trim() !== '', `status=${effortChat.status} ${effortChat.elapsedMs}ms ${JSON.stringify(effortChat.text.trim().slice(0, 80))}`)
  record(
    '真上游请求体带 reasoning_effort（effort 生效）',
    effortSent?.reasoningEffort === effort && effortSent?.model === modelId,
    `model=${effortSent?.model} reasoning_effort=${JSON.stringify(effortSent?.reasoningEffort)}`,
  )

  // 只换模型不带 effort：请求体里不能残留上一个档位。
  const cleared = await (await fetch(`${site.url}/webchat/api/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: labelled }),
  })).json()
  const stateCleared = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const beforePlainChat = recorder.requests.length
  const plainChat = await ask({ thinking: { type: 'disabled' } })
  const plainSent = lastUpstreamRequest(beforePlainChat)
  record(
    '不选 effort 时不落盘、请求体也没有 reasoning_effort',
    cleared.ok === true && cleared.activeEffort === undefined && !('effort' in stateCleared)
      && plainChat.status === 200 && plainSent !== undefined && plainSent.reasoningEffort === undefined,
    `POST→${JSON.stringify(cleared)} 文件→${JSON.stringify(stateCleared)} 请求体 reasoning_effort=${JSON.stringify(plainSent?.reasoningEffort)}`,
  )

  // ---- 7. 分组/模型切换：另一家 provider 的模型，真上游按新 model 作答 ----
  const switched2 = await (await fetch(`${site.url}/webchat/api/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: labelled2 }),
  })).json()
  const beforeSecond = recorder.requests.length
  const second = await ask({ thinking: { type: 'disabled' } }, '只回答两个字：收到')
  const secondSent = lastUpstreamRequest(beforeSecond)
  record(
    '切到另一组模型后真上游按新 model 作答',
    switched2.ok === true && switched2.active === labelled2 && second.status === 200
      && secondSent?.model === modelId2 && second.text.trim() !== '',
    `active=${switched2.active} 上游 model=${secondSent?.model} 回答=${JSON.stringify(second.text.trim().slice(0, 60))}`,
  )

  evidence.answer = { text: first.text.trim(), thinkingChars: first.thinking.length, elapsedMs: first.elapsedMs, events: first.names.length }
  evidence.effort = { value: effort, upstream: effortSent?.reasoningEffort ?? null }
} finally {
  await site.close()
  await recorder.close()
}

const ok = evidence.steps.every(step => step.ok)
evidence.ok = ok
evidence.finishedAt = new Date().toISOString()
const out = String(args.out ?? path.join(home, 'e2e-evidence.json'))
fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`)
console.log(`\n证据：${out}`)
console.log(`结论：${ok ? '全部通过' : '有失败项'}`)
process.exit(ok ? 0 : 1)
