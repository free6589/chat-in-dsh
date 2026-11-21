/**
 * `/webchat` 的 HTTP 面：
 *   - 静态资源：托管官方 chat-demo 的构建产物（只打了品牌与转发落点的补丁）；
 *   - 接口转发：浏览器不持有 API Key，由宿主用 DSH 的账户凭据代发；
 *   - 自检：把浏览器实际会走的几条路径跑一遍。
 *
 * 网页版有自己的一套存储（上游的 IndexedDB），与 DSH 会话互不相干——
 * 这是产品决定：两边的系统提示词和工具都不同，混合只会让双方都失真。
 *
 * 注意：DSH 的 `resource` 路由只接 GET/HEAD，聊天是 POST，所以用 `handler`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { DEFAULT_BASE_URL, TOKEN_HEADER, apiRoot, isInside } from './protocol.js'
import { ackPending, listPending, readDshSession, stageImport } from './dsh-import.js'
import { createModelRegistry } from './models.js'
import { listDshModels } from './dsh-models.js'
import { proxyDshDispatch, selfTestDshDispatch } from './dsh-dispatch.js'
import { createAnthropicStream, toAnthropicMessage, toOpenAIRequest } from './openai-bridge.js'

/** 构建产物位置（包内自带，安装即可用）。 */
const DIST = fileURLToPath(new URL('../webview/dist/', import.meta.url))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

const MAX_BODY = 64 * 1024 * 1024

/**
 * 页面启动前把"已经登录"的状态铺好：网页版要一个 API Key 才肯进主界面，
 * 这里塞一个占位值，真正的鉴权由宿主转发时完成。
 */
const BOOTSTRAP = `<script>(function(){try{var s=window.localStorage;
if(!s.getItem('chat-demo:api-key'))s.setItem('chat-demo:api-key','dsh');
if(!s.getItem('chat-demo:locale'))s.setItem('chat-demo:locale','zh-CN');
if(!s.getItem('chat-demo:thinking'))s.setItem('chat-demo:thinking','true');
}catch(e){}})();</script>`

/** 统一 JSON 响应。 */
export function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 读取请求体。 */
export async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** 读取并解析 JSON 请求体。 */
async function readJsonBody(req) {
  const raw = await readBody(req)
  if (raw.length === 0) return {}
  return JSON.parse(raw.toString('utf8'))
}
/** 读取入口页并注入引导脚本；每次现读，避免插件升级后仍引用旧的资源名。 */
function readIndex() {
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
  return html.replace(/<head>/iu, `<head>${BOOTSTRAP}`)
}

async function sendFile(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('not found')
    return
  }
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'content-length': fs.statSync(file).size })
  await pipeline(fs.createReadStream(file), res)
}

/** DSH 里模型设置默认使用的凭据名；安装可自定义 apiKeyEnv，优先按设置里的名字取。 */
const DEFAULT_API_KEY_REF = 'DEEPSEEK_API_KEY'

/** 从 DSH 设置描述里找 DeepSeek API Key 提供方配置的凭据名。 */
function findApiKeyRef(ctx) {
  try {
    const descriptors = ctx.get('settings')?.describe?.() ?? []
    const stack = descriptors.map(descriptor => descriptor?.value)
    while (stack.length > 0) {
      const value = stack.pop()
      if (value === null || typeof value !== 'object') continue
      for (const [key, entry] of Object.entries(value)) {
        if (/apikeyenv/iu.test(key) && typeof entry === 'string' && entry.length > 0) return entry
        if (entry !== null && typeof entry === 'object') stack.push(entry)
      }
    }
  } catch {
    // 设置服务不可读时退回约定名
  }
  return DEFAULT_API_KEY_REF
}

/** 取一个 Key：优先目录项自己的 apiKeyEnv，其次 DSH 设置里的名字，最后环境变量。 */
export async function resolveModelKey(ctx, entry) {
  const ref = entry?.apiKeyEnv ?? findApiKeyRef(ctx)
  let key
  try {
    const hit = await ctx.get('credentials')?.resolve(ref)
    key = hit?.value
  } catch {
    key = undefined
  }
  if (key === undefined || key.length === 0) {
    const ambient = process.env[ref]
    if (typeof ambient === 'string' && ambient.length > 0) key = ambient
  }
  return key === undefined || key.length === 0 ? undefined : key
}

/**
 * 解析一次上游请求的鉴权头：账户登录用 x-dsh-auth-token，API Key 路由用 x-api-key。
 * 非官方协议（api: 'openai'）的目录项不走 DeepSeek 账户令牌——那是 DeepSeek 的凭据。
 */
export async function resolveUpstreamAuth(ctx, baseURL, entry) {
  if (entry === undefined || entry.api !== 'openai') {
    const token = await ctx.get('deepseekAccount')?.resolveToken(baseURL)
    if (token !== undefined) return { source: 'account', headers: { [TOKEN_HEADER]: token } }
  }
  const key = await resolveModelKey(ctx, entry)
  if (key === undefined) return undefined
  return { source: 'api-key', headers: { 'x-api-key': key } }
}

/** 上游端点：目录项显式给了就用它，否则沿用插件配置 / 环境变量 / 官方默认。 */
function entryBaseURL(entry, config) {
  return entry?.baseURL || config.baseURL || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL
}

/**
 * 用所选模型替换请求体里的 model。
 * 目录是默认单项目录时不碰请求体——浏览器发什么就转发什么，保持原行为。
 */
function withSelectedModel(body, registry, entry) {
  if (registry.catalog.isDefault) return body
  let parsed
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return body
  }
  if (parsed === null || typeof parsed !== 'object') return body
  parsed.model = entry.upstreamModel ?? entry.id
  return Buffer.from(JSON.stringify(parsed), 'utf8')
}

/** 从上游错误体里挑一句能看的说明。 */
function upstreamErrorMessage(text) {
  try {
    const parsed = JSON.parse(text)
    const message = parsed?.error?.message ?? parsed?.message
    if (typeof message === 'string' && message !== '') return message
  } catch {
    // 非 JSON：用原文
  }
  return text.length > 0 ? text.slice(0, 500) : '上游请求失败'
}

/** 把帧写进响应流。 */
function writeFrames(res, frames) {
  for (const frame of frames) res.write(frame)
}

/**
 * 非 Anthropic 协议的上游（目录项 api: 'openai'）：
 * 请求翻成 chat.completions，再把分块流翻回 Anthropic SSE 交给网页版。
 */
async function proxyOpenAIMessages(ctx, req, res, entry) {
  if (entry.baseURL === undefined) {
    sendJson(res, { error: { message: `模型 ${entry.id} 缺少 baseURL：请在插件配置的 models 里补上` } }, 400)
    return
  }
  const key = await resolveModelKey(ctx, entry)
  if (key === undefined) {
    sendJson(res, { error: { message: `模型 ${entry.id} 没有可用 Key：请配置 ${entry.apiKeyEnv ?? 'DEEPSEEK_API_KEY'}` } }, 401)
    return
  }
  const raw = await readBody(req)
  let body
  try {
    body = JSON.parse(raw.toString('utf8') || '{}')
  } catch {
    sendJson(res, { error: { message: '请求体不是合法 JSON' } }, 400)
    return
  }
  const payload = toOpenAIRequest(body, entry)
  const thinking = body?.thinking?.type !== 'disabled'
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })
  const upstream = await fetch(`${entry.baseURL.replace(/\/+$/u, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: payload.stream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  })
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '')
    res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message: upstreamErrorMessage(text) },
    }))
    return
  }
  if (!payload.stream) {
    const json = await upstream.json().catch(() => undefined)
    if (json === undefined) {
      sendJson(res, { type: 'error', error: { type: 'api_error', message: '上游返回的不是 JSON' } }, 502)
      return
    }
    sendJson(res, toAnthropicMessage(json, { model: payload.model, thinking }))
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const stream = createAnthropicStream({ model: payload.model, thinking })
  writeFrames(res, stream.start())
  const decoder = new TextDecoder()
  let buffer = ''
  let finished = false
  for await (const chunk of Readable.fromWeb(upstream.body)) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith(':') || !trimmed.startsWith('data:')) continue
      const data = trimmed.slice('data:'.length).trim()
      if (data === '[DONE]') {
        finished = true
        break
      }
      let parsed
      try {
        parsed = JSON.parse(data)
      } catch {
        continue
      }
      writeFrames(res, stream.onChunk(parsed))
    }
    if (finished) break
  }
  writeFrames(res, stream.finish('stop'))
  res.end()
}

/**
 * 上游请求原样转发，鉴权换成 DSH 的账户凭据或 API Key；SSE 直接透传。
 * DSH 目录项（api: 'dsh'，与 DSH 聊天框同源）走 live registry 派发；
 * 目录项是 OpenAI 协议时改走桥；否则仍是原来的直通路径，只按选择替换 model。
 */
async function proxyMessages(ctx, config, req, res, registry) {
  const entry = registry.active()
  if (entry.api === 'dsh' && typeof entry.provider === 'string') {
    await proxyDshDispatch(ctx, await readBody(req), res, {
      provider: entry.provider,
      model: entry.upstreamModel ?? entry.id.split('/').slice(1).join('/') ?? entry.id,
      reasoningEffort: entry.reasoningEffort,
    })
    return
  }
  if (entry.api === 'openai') {
    await proxyOpenAIMessages(ctx, req, res, entry)
    return
  }
  const baseURL = entryBaseURL(entry, config)
  const auth = await resolveUpstreamAuth(ctx, baseURL, entry)
  if (auth === undefined) {
    sendJson(res, { error: { message: 'DSH 里没有可用的 DeepSeek 凭据：请登录 DeepSeek 账户，或在模型设置里配置 DeepSeek API Key' } }, 401)
    return
  }
  const body = withSelectedModel(await readBody(req), registry, entry)
  // 带附件的请求要原样带上浏览器发的 anthropic-beta（files-api-…），
  // 少了它上游会直接 400：Missing or invalid anthropic-beta header。
  const beta = req.headers['anthropic-beta']
  const upstream = await fetch(`${apiRoot(baseURL)}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      ...(typeof beta === 'string' && beta.length > 0 ? { 'anthropic-beta': beta } : {}),
      ...auth.headers,
    },
    body,
  })
  if (!upstream.ok || upstream.body === null) {
    const text = await upstream.text().catch(() => '')
    res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(text || JSON.stringify({ error: { message: '上游请求失败' } }))
    return
  }
  res.writeHead(200, {
    'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  await pipeline(Readable.fromWeb(upstream.body), res)
}

/** 附件上传转发：multipart 原样送到官方 Files API。 */
async function proxyFiles(ctx, config, req, res, pathname) {
  const baseURL = config.baseURL || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL
  const auth = await resolveUpstreamAuth(ctx, baseURL)
  if (auth === undefined) {
    sendJson(res, { error: { message: 'DSH 里没有可用的 DeepSeek 凭据：请登录 DeepSeek 账户，或在模型设置里配置 DeepSeek API Key' } }, 401)
    return
  }
  const suffix = pathname.slice('/webchat/anthropic/v1'.length)
  // Anthropic 兼容的 /anthropic/v1/files 网关对 64MiB 以上请求返回 413；
  // 官方 Files API 根路径能接收 100MiB，因此只在已知官方端点改走根 /files。
  // 自定义兼容网关可能只实现 /anthropic/v1/files，必须保留原路径。
  let officialRoot
  try {
    const parsed = new URL(baseURL)
    if (parsed.hostname === 'api.deepseek.com') {
      officialRoot = parsed.origin
    }
  } catch {
    // 非 URL 配置按自定义网关处理。
  }
  const useRootFiles = officialRoot !== undefined && suffix.startsWith('/files')
  const target = useRootFiles ? `${officialRoot}${suffix}` : `${apiRoot(baseURL)}${suffix}`
  // 优先沿用浏览器发来的 beta 版本，没带时才用已知可用的那个。
  const clientBeta = req.headers['anthropic-beta']
  const headers = {
    'anthropic-version': '2023-06-01',
    'anthropic-beta': typeof clientBeta === 'string' && clientBeta.length > 0 ? clientBeta : 'files-api-2025-04-14',
    ...auth.headers,
  }
  if (useRootFiles && auth.source === 'api-key') {
    headers.authorization = `Bearer ${auth.headers['x-api-key']}`
  }
  const init = { method: req.method, headers }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const contentType = req.headers['content-type']
    if (typeof contentType === 'string') headers['content-type'] = contentType
    const contentLength = req.headers['content-length']
    if (typeof contentLength === 'string') headers['content-length'] = contentLength
    // 官方 Files API 根路径支持 100MiB；流式转发，不把整个 multipart 读进内存。
    init.body = Readable.toWeb(req)
    init.duplex = 'half'
  }
  const upstream = await fetch(target, init)
  const text = await upstream.text()
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
  })
  res.end(text)
}

/** 语音接口转发：ASR 收 multipart、TTS 回 PCM 流，浏览器不持有凭据。 */
async function proxyTools(ctx, config, req, res, pathname) {
  const baseURL = config.baseURL || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL
  const auth = await resolveUpstreamAuth(ctx, baseURL)
  if (auth === undefined) {
    sendJson(res, { error: { message: 'DSH 里没有可用的 DeepSeek 凭据：请登录 DeepSeek 账户，或在模型设置里配置 DeepSeek API Key' } }, 401)
    return
  }
  const root = baseURL.replace(/\/+$/u, '').replace(/\/anthropic$/u, '')
  const target = `${root}${pathname.slice('/webchat'.length)}`
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })
  const headers = {
    'anthropic-version': '2023-06-01',
    ...auth.headers,
    ...(req.headers.authorization === undefined ? {} : { authorization: req.headers.authorization }),
  }
  const contentType = req.headers['content-type']
  if (typeof contentType === 'string') headers['content-type'] = contentType
  if (typeof req.headers.accept === 'string') headers.accept = req.headers.accept
  const init = { method: req.method, headers, signal: controller.signal }
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await readBody(req)
  const upstream = await fetch(target, init)
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    'cache-control': 'no-store',
  })
  if (upstream.body === null) {
    res.end()
    return
  }
  await pipeline(Readable.fromWeb(upstream.body), res)
}

/** 自检：入口页、静态资源、一次真实生成（用当前选中的模型）。 */
async function selfTest(ctx, config, registry) {
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })
  try {
    add('index', readIndex().includes('chat-demo:api-key'), `${readIndex().length} bytes`)
  } catch (error) {
    add('index', false, String(error?.message ?? error))
  }
  const main = (() => {
    try {
      return /src="(static\/js\/[^"]+\.js)"/u.exec(readIndex())?.[1]
    } catch {
      return undefined
    }
  })()
  add('static', main !== undefined && fs.existsSync(path.join(DIST, main)), main ?? 'not found')
  const entry = registry.active()
  add('model', true, `${entry.id} · ${entry.api}`)
  try {
    if (entry.api === 'dsh' && typeof entry.provider === 'string') {
      const result = await selfTestDshDispatch(ctx, entry)
      add('messages', result.ok, result.detail)
    } else if (entry.api === 'openai') {
      const result = await selfTestOpenAI(ctx, entry)
      add('messages', result.ok, result.detail)
    } else {
      const baseURL = entryBaseURL(entry, config)
      const auth = await resolveUpstreamAuth(ctx, baseURL, entry)
      if (auth === undefined) throw new Error('没有可用的 DeepSeek 凭据：账户未登录且未配置 API Key')
      // 目录是默认单项时保持原来的模型名推断（账户 → deepseek-flash，API Key → deepseek-chat）。
      const model = registry.catalog.isDefault
        ? (auth.source === 'api-key' ? 'deepseek-chat' : 'deepseek-flash')
        : (entry.upstreamModel ?? entry.id)
      const response = await fetch(`${apiRoot(baseURL)}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'anthropic-version': '2023-06-01',
          ...auth.headers,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: '只回复两个字：收到' }],
          thinking: { type: 'disabled' },
          stream: true,
        }),
        signal: AbortSignal.timeout(60_000),
      })
      const text = await response.text()
      add('messages', response.ok && text.includes('message_stop'), `${response.status} · ${text.length} bytes`)
    }
  } catch (error) {
    add('messages', false, String(error?.message ?? error))
  }
  return { ok: checks.every(check => check.ok), checks }
}

/** 自检的 OpenAI 侧：走一遍桥，确认能拿到正文。 */
async function selfTestOpenAI(ctx, entry) {
  if (entry.baseURL === undefined) return { ok: false, detail: '缺少 baseURL' }
  const key = await resolveModelKey(ctx, entry)
  if (key === undefined) return { ok: false, detail: `没有可用 Key：${entry.apiKeyEnv ?? 'DEEPSEEK_API_KEY'}` }
  const payload = toOpenAIRequest(
    { messages: [{ role: 'user', content: '只回复两个字：收到' }], max_tokens: 64, stream: true, thinking: { type: 'disabled' } },
    entry,
  )
  const response = await fetch(`${entry.baseURL.replace(/\/+$/u, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { ok: false, detail: `${response.status} · ${upstreamErrorMessage(text)}` }
  }
  const text = await response.text()
  const hasText = /"content"\s*:\s*"[^"]+"/u.test(text)
  return { ok: hasText, detail: `${response.status} · ${text.length} bytes` }
}

/**
 * 插件路由不在 DSH 的 /api 信任栅栏内，必须自己调用 Connection 的
 * Host/Origin 校验和浏览器认证；否则任何网页都能借已登录的 DSH 调用转发接口。
 * 桌面 App 自身窗口（dsh-app:）不走浏览器 Cookie，直接放行。
 * @returns {number | undefined} 拒绝状态码，放行时为 undefined
 */
function untrustedRejection(ctx, req) {
  const origin = String(req.headers?.origin ?? '')
  if (origin.startsWith('dsh-app:')) return undefined
  let connection
  try {
    connection = ctx.get('connection')
  } catch {
    return undefined
  }
  if (connection === undefined || typeof connection.requestRejection !== 'function') return undefined
  try {
    return connection.requestRejection(req)
  } catch {
    return 401
  }
}
/** 统一 HTML 响应。 */
export function sendHtml(res, html, status = 200) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
  })
  res.end(html)
}

/** HTML 文本转义。 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

/** 设置页脚本要用的搜索模块（浏览器侧按 ESM 加载同一份源码）。 */
const SEARCH_MODULE = fileURLToPath(new URL('./model-search.js', import.meta.url))

/** 模型设置页：列出目录、按关键字过滤并切换当前模型。 */
export function renderModelSettings(models) {
  const active = models.activeId()
  const rows = models.list().map(item => {
    const provider = typeof item.providerName === 'string' && item.providerName !== ''
      ? item.providerName
      : (typeof item.provider === 'string' && item.provider !== '' ? item.provider : '')
    return `<li class="row${item.id === active ? ' on' : ''}" data-id="${escapeHtml(item.id)}" data-label="${escapeHtml(item.label)}" data-provider-name="${escapeHtml(provider)}" data-provider="${escapeHtml(item.provider ?? '')}" data-api="${escapeHtml(item.api)}">
      <label>
        <input type="radio" name="model" value="${escapeHtml(item.id)}"${item.id === active ? ' checked' : ''}>
        <span class="id">${escapeHtml(item.id)}</span>
        <span class="meta"><span class="label">${escapeHtml(item.label)}</span> · <span class="provider">${escapeHtml(provider === '' ? item.api : provider)}</span>${item.default ? ' · 默认' : ''}</span>
      </label>
    </li>`
  }).join('\n')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>网页版模型</title>
<style>
  body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:24px;color:#1f2328;background:#fff}
  h1{font-size:16px;margin:0 0 4px}
  p.hint{color:#6b7280;margin:0 0 16px;font-size:12px}
  .search{display:flex;gap:6px;align-items:center;margin:0 0 12px}
  .search input{font:inherit;flex:1;max-width:360px;padding:6px 10px;border-radius:6px;border:1px solid #d0d7de}
  .search button{font:inherit;padding:4px 10px;border-radius:6px;border:1px solid #d0d7de;background:#fff;color:#1f2328;cursor:pointer}
  ul{list-style:none;padding:0;margin:0 0 16px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden}
  li.row{border-top:1px solid #f0f0f0}
  li.row:first-child{border-top:none}
  li.on{background:#f5f8ff}
  li[hidden]{display:none}
  label{display:flex;align-items:baseline;gap:8px;padding:10px 12px;cursor:pointer}
  .id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .meta{color:#6b7280;font-size:12px}
  mark{background:#fde68a;color:inherit;border-radius:2px}
  button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid #d0d7de;background:#1f6feb;color:#fff;cursor:pointer}
  #status{margin-left:12px;color:#6b7280;font-size:12px}
  #empty{margin:0 0 16px;color:#6b7280;font-size:12px}
  #empty[hidden]{display:none}
</style></head>
<body>
<h1>网页版使用哪个模型</h1>
<p class="hint">选择后立刻生效，后续对话转发到这个模型；目录来自插件配置的 models。</p>
<div class="search">
  <input id="search" type="search" autocomplete="off" placeholder="搜索模型或 provider…" aria-label="搜索模型">
  <button id="clear" type="button" aria-label="清除搜索" hidden>清除</button>
</div>
<p class="hint" id="active-line">当前：<span id="active-id">${escapeHtml(active)}</span></p>
<ul id="list">
${rows}
</ul>
<p id="empty" role="status" hidden></p>
<button id="save" type="button">保存</button><span id="status"></span>
<script type="module">
import { matchEntry, highlightSegments, EMPTY_NO_MATCH, EMPTY_NO_MODELS } from '/webchat/settings-search.js'

const search = document.getElementById('search')
const clear = document.getElementById('clear')
const empty = document.getElementById('empty')
const list = document.getElementById('list')
const save = document.getElementById('save')
const status = document.getElementById('status')
const items = Array.from(list.querySelectorAll('li.row')).map(node => ({
  node,
  input: node.querySelector('input[name=model]'),
  id: node.querySelector('.id'),
  label: node.querySelector('.label'),
  provider: node.querySelector('.provider'),
  entry: {
    id: node.dataset.id || '',
    label: node.dataset.label || '',
    providerName: node.dataset.providerName || '',
    provider: node.dataset.provider || '',
    api: node.dataset.api || '',
  },
}))

/** 把一段文本按命中下标重画，命中部分包 <mark>；纯文本用 textContent 落地，不拼 HTML。 */
function paint(node, text, indices) {
  node.replaceChildren(...highlightSegments(text, indices).map(segment => {
    if (!segment.hit) return document.createTextNode(segment.text)
    const mark = document.createElement('mark')
    mark.textContent = segment.text
    return mark
  }))
}

/** 按当前查询过滤：命中的行按匹配度排前，没命中的隐藏；选中项只隐藏，不重建、不改选中状态。 */
function render() {
  const query = search.value
  clear.hidden = query === ''
  const ranked = []
  for (const item of items) {
    const hit = matchEntry(item.entry, query, ['label', 'id', 'providerName', 'provider', 'api'])
    paint(item.id, item.entry.id, hit?.field === 'id' ? hit.indices : [])
    paint(item.label, item.entry.label, hit?.field === 'label' ? hit.indices : [])
    paint(item.provider, item.provider.textContent, hit && ['provider', 'providerName', 'api'].includes(hit.field) ? hit.indices : [])
    item.node.hidden = hit === undefined
    if (hit !== undefined) ranked.push({ item, hit })
  }
  ranked.sort((left, right) => left.hit.score - right.hit.score)
  for (const { item } of ranked) list.append(item.node)
  for (const item of items) if (item.node.hidden) list.append(item.node)
  empty.hidden = ranked.length > 0
  empty.textContent = ranked.length > 0 ? '' : (items.length === 0 ? EMPTY_NO_MODELS : EMPTY_NO_MATCH)
  const checked = document.querySelector('input[name=model]:checked')
  document.getElementById('active-id').textContent = checked === null ? '未选择' : checked.value
  status.textContent = ranked.length === items.length ? '' : ('显示 ' + ranked.length + ' / ' + items.length)
}

/** 上下键在可见行之间挪选中项，回车直接保存。 */
function move(step) {
  const visible = items.filter(item => !item.node.hidden)
  if (visible.length === 0) return
  const current = visible.findIndex(item => item.input.checked)
  const next = visible[(current + step + visible.length) % visible.length]
  next.input.checked = true
  next.node.scrollIntoView({ block: 'nearest' })
  render()
}

search.addEventListener('input', render)
search.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
  else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
  else if (event.key === 'Enter') { event.preventDefault(); save.click() }
  else if (event.key === 'Escape') { search.value = ''; render() }
})
clear.addEventListener('click', () => { search.value = ''; render(); search.focus() })
list.addEventListener('change', render)
render()
document.body.dataset.search = 'ready'

save.addEventListener('click', async function () {
  var picked = document.querySelector('input[name=model]:checked')
  if (!picked) { status.textContent = '先选一个模型'; return }
  status.textContent = '保存中…'
  try {
    var response = await fetch('/webchat/api/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: picked.value })
    })
    var body = await response.json()
    status.textContent = body.ok ? '已切换到 ' + body.active : ('失败：' + (body.error || response.status))
  } catch (error) {
    status.textContent = '失败：' + error.message
  }
})
</script>
</body></html>`
}

/**
 * 建立请求处理器（Node 原生 req/res）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ baseURL?: string }} config
 * @param {string} home DSH_HOME，用来读 DSH 会话与存放待导入暂存
 */
export function createWebview(ctx, config, home) {
  const models = createModelRegistry(config, home)
  // 每次请求现取 DSH 同一份目录并合并：DSH 聊天框侧增删模型，面板下拉下一次请求就跟上。
  const registryFor = async () => {
    try {
      const live = await listDshModels(ctx)
      if (live?.ok && Array.isArray(live.groups) && live.groups.length > 0) {
        return createModelRegistry(config, home, live.groups)
      }
    } catch {
      // 取不到就用插件目录（models.js 兜底行为）
    }
    return models
  }
  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const { pathname } = url
    const method = (req.method ?? 'GET').toUpperCase()
    const isGet = method === 'GET' || method === 'HEAD'

    // 与 DSH 自己的 /api 一样要求可信 Host/Origin 与已登录浏览器凭据。
    const rejection = untrustedRejection(ctx, req)
    if (rejection !== undefined) {
      sendJson(res, { error: { message: rejection === 403 ? '请求来源不受信任' : '需要 DSH 登录' } }, rejection)
      return
    }

    // ---- 从 DSH 一次性导入 ----
    if (pathname === '/webchat/api/import/stage' && method === 'POST') {
      const body = await readJsonBody(req)
      const sessionId = String(body.sessionId ?? '')
      const session = readDshSession(home, sessionId)
      if (session === undefined) {
        sendJson(res, { ok: false, error: '找不到这条会话，或它没有可导入的内容' }, 404)
        return
      }
      const staged = stageImport(home, session)
      sendJson(res, { ok: true, id: session.id, title: session.title, messages: session.messages.length, importId: staged.importId })
      return
    }
    if (pathname === '/webchat/api/import/pending' && isGet) {
      sendJson(res, listPending(home))
      return
    }
    if (pathname === '/webchat/api/import/ack' && method === 'POST') {
      const body = await readJsonBody(req)
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : []
      // 新前端带 imports（含 importId）；兼容旧版只有 ids 的确认请求。
      const imports = Array.isArray(body.imports)
        ? body.imports
        : ids.map(id => ({ id }))
      sendJson(res, { removed: ackPending(home, imports) })
      return
    }
    if (pathname === '/webchat/api/self-test' && isGet) {
      try {
        sendJson(res, await selfTest(ctx, config, await registryFor()))
      } catch (error) {
        sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
      }
      return
    }

    // 模型列表：网页版用它做入口校验；同时暴露目录，方便脚本查看可选模型。
    if (pathname === '/webchat/models' && isGet) {
      const registry = await registryFor()
      sendJson(res, {
        object: 'list',
        // provider/providerName 只随 DSH 分组条目出现；插件项与默认单项不带，保持向后兼容。
        data: registry.list().map(item => ({
          id: item.id,
          object: 'model',
          label: item.label,
          api: item.api,
          default: item.default,
          ...(item.provider === undefined ? {} : { provider: item.provider, providerName: item.providerName }),
        })),
        default: registry.activeId(),
      })
      return
    }

    // DSH 同一份模型目录：宿主经 ctx.llm 取全量 provider/model（与 DSH 聊天框同源）。
    // 面板下拉数据源；失败时回退插件 models 配置（见 models.js）。
    if (pathname === '/webchat/api/dsh-models' && isGet) {
      try {
        sendJson(res, await listDshModels(ctx))
      } catch (error) {
        sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
      }
      return
    }

    // 模型选择：GET 看可选模型与当前选择（含 effort），POST { id, effort? } 切换
    // （落在 DSH_HOME 的状态文件里；effort 随选择落盘，派发时透传 reasoningEffort）。
    if (pathname === '/webchat/api/models') {
      const registry = await registryFor()
      if (isGet) {
        sendJson(res, {
          ok: true,
          models: registry.list(),
          active: registry.activeId(),
          activeEffort: registry.activeEffort(),
          stateFile: registry.file,
        })
        return
      }
      if (method === 'POST') {
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id.trim() : ''
        const effort = typeof body?.effort === 'string' && body.effort.trim() !== ''
          ? body.effort.trim()
          : undefined
        if (!registry.select(id, effort)) {
          sendJson(res, { ok: false, error: `没有这个模型：${id}` }, 404)
          return
        }
        sendJson(res, { ok: true, active: registry.activeId(), activeEffort: registry.activeEffort() })
        return
      }
    }

    // 设置页：模型列表 + 单选切换（网页版前端产物不好重建，选择界面放在宿主这边）。
    if (pathname === '/webchat/settings' && isGet) {
      sendHtml(res, renderModelSettings(await registryFor()))
      return
    }

    // 设置页的搜索模块：浏览器按 ESM 加载这一份源码，和面板菜单共用同一套匹配规则。
    if (pathname === '/webchat/settings-search.js' && isGet) {
      const source = fs.readFileSync(SEARCH_MODULE, 'utf8')
      res.writeHead(200, {
        'content-type': MIME['.js'],
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(source),
      })
      res.end(method === 'HEAD' ? undefined : source)
      return
    }

    if (pathname === '/webchat/anthropic/v1/messages' && method === 'POST') {
      try {
        await proxyMessages(ctx, config, req, res, await registryFor())
      } catch (error) {
        if (!res.headersSent) sendJson(res, { error: { message: String(error?.message ?? error) } }, 502)
        else res.destroy()
      }
      return
    }

    if (pathname.startsWith('/webchat/anthropic/v1/files')) {
      try {
        await proxyFiles(ctx, config, req, res, pathname)
      } catch (error) {
        if (!res.headersSent) sendJson(res, { error: { message: String(error?.message ?? error) } }, 502)
        else res.destroy()
      }
      return
    }

    // 语音输入 / 回答朗读：/webchat/v1/tools/asr、/webchat/v1/tools/tts
    if (pathname.startsWith('/webchat/v1/tools/') && method === 'POST') {
      try {
        await proxyTools(ctx, config, req, res, pathname)
      } catch (error) {
        if (!res.headersSent) sendJson(res, { error: { message: String(error?.message ?? error) } }, 502)
        else res.destroy()
      }
      return
    }

    if (pathname === '/webchat' || pathname === '/webchat/') {
      const html = readIndex()
      res.writeHead(200, {
        'content-type': MIME['.html'],
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(html),
      })
      res.end(method === 'HEAD' ? undefined : html)
      return
    }

    if (pathname === '/webchat/brand-mark.svg') {
      await sendFile(res, path.join(DIST, '..', 'brand-mark.svg'))
      return
    }

    if (pathname.startsWith('/webchat/')) {
      const target = path.resolve(DIST, pathname.slice('/webchat/'.length))
      if (!isInside(path.resolve(DIST), target)) {
        res.writeHead(403).end('forbidden')
        return
      }
      await sendFile(res, target)
      return
    }

    res.writeHead(404).end('not found')
  }
}



