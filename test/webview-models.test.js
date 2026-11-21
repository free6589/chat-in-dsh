import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { createWebview } from '../src/webview.js'

const servers = []

/** 起一个本地 HTTP 服务，返回 { url, port, close }。 */
async function listen(handler) {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}`, port }
}

after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
})

/** 假上游：记录收到的请求，回答固定的 OpenAI 分块流。 */
async function fakeOpenAIUpstream() {
  const seen = []
  const upstream = await listen(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    seen.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '先想' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '收到' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
  return { ...upstream, seen }
}

/** 假 Anthropic 上游：把请求体记下来，回一个最小可用事件流。 */
async function fakeAnthropicUpstream() {
  const seen = []
  const upstream = await listen(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    seen.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n')
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    res.end()
  })
  return { ...upstream, seen }
}

/** 起插件本身。 */
async function plugin(config, home, ctx = { get: () => undefined }) {
  const handler = createWebview(ctx, config, home)
  return listen((req, res) => handler(req, res))
}

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chat-in-dsh-home-'))

test('默认目录：/webchat/models 仍是 deepseek-flash 单项', async () => {
  const home = tempHome()
  const site = await plugin({ stateFile: path.join(home, 'state.json') }, home)
  const response = await fetch(`${site.url}/webchat/models`)
  const body = await response.json()
  assert.equal(body.object, 'list')
  assert.deepEqual(body.data.map(item => item.id), ['deepseek-flash'])
  assert.equal(body.default, 'deepseek-flash')
})

test('配置目录后 /webchat/models 列出全部模型', async () => {
  const home = tempHome()
  const config = {
    stateFile: path.join(home, 'state.json'),
    models: [
      { id: 'deepseek-flash', label: '官方' },
      { id: 'glm-5.3-flash', label: 'GLM', api: 'openai', baseURL: 'http://127.0.0.1:1/openai/v1', apiKeyEnv: 'TEST_KEY' },
    ],
  }
  const site = await plugin(config, home)
  const body = await (await fetch(`${site.url}/webchat/models`)).json()
  assert.deepEqual(body.data.map(item => item.id), ['deepseek-flash', 'glm-5.3-flash'])
  assert.equal(body.data[1].api, 'openai')
  assert.equal(body.data[0].default, true)
})

test('切换模型：POST /webchat/api/models 后 GET 反映新选择', async () => {
  const home = tempHome()
  const stateFile = path.join(home, 'state.json')
  const config = {
    stateFile,
    models: [{ id: 'deepseek-flash' }, { id: 'glm-5.3-flash', api: 'openai', baseURL: 'http://127.0.0.1:1/openai/v1' }],
  }
  const site = await plugin(config, home)
  const before = await (await fetch(`${site.url}/webchat/api/models`)).json()
  assert.equal(before.active, 'deepseek-flash')
  const switched = await fetch(`${site.url}/webchat/api/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'glm-5.3-flash' }),
  })
  assert.equal(switched.status, 200)
  assert.equal((await switched.json()).active, 'glm-5.3-flash')
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).model, 'glm-5.3-flash')
  const after = await (await fetch(`${site.url}/webchat/api/models`)).json()
  assert.equal(after.active, 'glm-5.3-flash')
})

test('切换模型：未知 id 返回 404 且不改状态', async () => {
  const home = tempHome()
  const stateFile = path.join(home, 'state.json')
  const site = await plugin({ stateFile, models: [{ id: 'a' }] }, home)
  const response = await fetch(`${site.url}/webchat/api/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'nope' }),
  })
  assert.equal(response.status, 404)
  assert.equal(fs.existsSync(stateFile), false)
})

test('设置页列出模型并可切换', async () => {
  const home = tempHome()
  const config = { stateFile: path.join(home, 'state.json'), models: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }] }
  const site = await plugin(config, home)
  const response = await fetch(`${site.url}/webchat/settings`)
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /value="a"/u)
  assert.match(html, /value="b"/u)
  assert.match(html, /乙/u)
  assert.match(html, /\/webchat\/api\/models/u)
})

test('选中 OpenAI 协议模型后：请求转发到 chat.completions 并翻回 Anthropic SSE', async () => {
  const home = tempHome()
  const upstream = await fakeOpenAIUpstream()
  const stateFile = path.join(home, 'state.json')
  process.env.TEST_KEY = 'sk-test-openai'
  try {
    const config = {
      stateFile,
      models: [
        { id: 'deepseek-flash' },
        {
          id: 'glm-5.3-flash',
          api: 'openai',
          baseURL: `${upstream.url}/openai/v1`,
          apiKeyEnv: 'TEST_KEY',
          upstreamModel: 'agent2api/glm-5.3-flash',
        },
      ],
    }
    const site = await plugin(config, home)
    await fetch(`${site.url}/webchat/api/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'glm-5.3-flash' }),
    })
    const response = await fetch(`${site.url}/webchat/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash',
        system: '该助手为DeepSeek',
        messages: [{ role: 'user', content: [{ type: 'text', text: '打个招呼' }] }],
        thinking: { type: 'enabled' },
        safety_check: { level: 'high' },
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        title: { enabled: true },
        stream: true,
      }),
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.match(text, /event: message_start/u)
    assert.match(text, /"type":"thinking_delta","thinking":"先想"/u)
    assert.match(text, /"type":"text_delta","text":"收到"/u)
    assert.match(text, /event: message_stop/u)
    // 上游收到的请求：换了模型名、带 Bearer、去掉官方扩展字段。
    assert.equal(upstream.seen.length, 1)
    assert.equal(upstream.seen[0].url, '/openai/v1/chat/completions')
    assert.equal(upstream.seen[0].headers.authorization, 'Bearer sk-test-openai')
    assert.equal(upstream.seen[0].body.model, 'agent2api/glm-5.3-flash')
    assert.equal('safety_check' in upstream.seen[0].body, false)
    assert.equal('tools' in upstream.seen[0].body, false)
    assert.equal('title' in upstream.seen[0].body, false)
    assert.equal(upstream.seen[0].body.messages[0].role, 'system')
  } finally {
    delete process.env.TEST_KEY
  }
})

test('OpenAI 目录项没有 Key 时返回 401 且不请求上游', async () => {
  const home = tempHome()
  const upstream = await fakeOpenAIUpstream()
  const config = {
    stateFile: path.join(home, 'state.json'),
    models: [{ id: 'glm', api: 'openai', baseURL: `${upstream.url}/openai/v1`, apiKeyEnv: 'MISSING_KEY_FOR_TEST' }],
  }
  const site = await plugin(config, home)
  const response = await fetch(`${site.url}/webchat/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
  })
  assert.equal(response.status, 401)
  assert.equal(upstream.seen.length, 0)
})

test('默认目录（没配 models）时请求体原样转发，模型名不被改写', async () => {
  const home = tempHome()
  const upstream = await fakeAnthropicUpstream()
  const ctx = {
    get(name) {
      if (name === 'deepseekAccount') return { resolveToken: async () => 'token-1' }
      return undefined
    },
  }
  const config = { stateFile: path.join(home, 'state.json'), baseURL: `${upstream.url}/anthropic` }
  const site = await plugin(config, home, ctx)
  const response = await fetch(`${site.url}/webchat/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  })
  assert.equal(response.status, 200)
  assert.equal(upstream.seen[0].url, '/anthropic/v1/messages')
  assert.equal(upstream.seen[0].body.model, 'deepseek-flash')
})

test('配置了目录但选中的是 Anthropic 项：仍走直通，只替换模型名', async () => {
  const home = tempHome()
  const upstream = await fakeAnthropicUpstream()
  const ctx = {
    get(name) {
      if (name === 'deepseekAccount') return { resolveToken: async () => 'token-1' }
      return undefined
    },
  }
  const config = {
    stateFile: path.join(home, 'state.json'),
    baseURL: `${upstream.url}/anthropic`,
    models: [{ id: 'deepseek-flash' }, { id: 'deepseek-reasoner', upstreamModel: 'deepseek-reasoner' }],
  }
  const site = await plugin(config, home, ctx)
  await fetch(`${site.url}/webchat/api/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'deepseek-reasoner' }),
  })
  await fetch(`${site.url}/webchat/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  })
  assert.equal(upstream.seen[0].body.model, 'deepseek-reasoner')
})

test('链路透传：OpenAI 协议条目把网页版 effort 翻成 reasoning_effort，没选就不带', async () => {
  const home = tempHome()
  const upstream = await fakeOpenAIUpstream()
  process.env.TEST_KEY = 'sk-test-effort'
  try {
    const config = {
      stateFile: path.join(home, 'state.json'),
      models: [{ id: 'glm-5.3-flash', api: 'openai', baseURL: `${upstream.url}/openai/v1`, apiKeyEnv: 'TEST_KEY', upstreamModel: 'agent2api/glm-5.3-flash' }],
    }
    const site = await plugin(config, home)
    const send = extra => fetch(`${site.url}/webchat/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true, ...extra }),
    })
    assert.equal((await send({ thinking: { type: 'enabled', effort: 'high' } })).status, 200)
    assert.equal(upstream.seen[0].body.reasoning_effort, 'high')
    assert.equal((await send({ thinking: { type: 'enabled' } })).status, 200)
    assert.equal('reasoning_effort' in upstream.seen[1].body, false)
  } finally {
    delete process.env.TEST_KEY
  }
})

test('链路透传：DSH 目录条目把网页版 effort 透传到 prepareCall 与 stream', async () => {
  const home = tempHome()
  const calls = []
  const ctx = {
    get: name => (name === 'llm' ? ctx.llm : undefined),
    llm: {
      listProviders: () => [{ id: 'agent2api', name: 'Agent2API' }],
      listModels: async provider => (provider === 'agent2api' ? [{ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }] : []),
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' } }),
      async prepareCall(config) {
        const record = { config }
        calls.push(record)
        return {
          config,
          stream(options) {
            record.streamOptions = options
            return (async function* () {
              yield { type: 'text-delta', text: '收到' }
              yield { type: 'finish' }
            })()
          },
        }
      },
    },
  }
  const site = await plugin({ stateFile: path.join(home, 'state.json') }, home, ctx)
  const selected = await fetch(`${site.url}/webchat/api/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'agent2api/glm-5.3-flash' }),
  })
  assert.equal(selected.status, 200)
  const send = extra => fetch(`${site.url}/webchat/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true, ...extra }),
  })
  const first = await send({ effort: 'high' })
  assert.equal(first.status, 200)
  assert.match(await first.text(), /event: message_stop/u)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].config.provider, 'agent2api')
  assert.equal(calls[0].config.model, 'glm-5.3-flash')
  assert.equal(calls[0].config.reasoningEffort, 'high')
  assert.equal(calls[0].streamOptions.reasoningEffort, 'high')
  const second = await send({})
  assert.equal(second.status, 200)
  assert.equal('reasoningEffort' in calls[1].config, false)
  assert.equal('reasoningEffort' in calls[1].streamOptions, false)
})

/** 带 llm 服务的 ctx：返回 DSH 同一份目录（一个 provider 一个模型）。 */
function ctxWithLlm() {
  return {
    get(name) {
      if (name !== 'llm') return undefined
      return {
        listProviders: () => [{ id: 'agent2api', name: 'Agent2API' }],
        listModels: async () => [{ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }],
        resolveModelInfo: async () => ({}),
      }
    },
  }
}

test('DSH 目录下 /webchat/models 与 /webchat/api/models 暴露 provider 分组字段', async () => {
  const home = tempHome()
  const site = await plugin({ stateFile: path.join(home, 'state.json') }, home, ctxWithLlm())
  const list = await (await fetch(`${site.url}/webchat/models`)).json()
  assert.deepEqual(list.data.map(item => item.id), ['agent2api/glm-5.3-flash', 'deepseek-flash'])
  assert.deepEqual(list.data[0], { id: 'agent2api/glm-5.3-flash', object: 'model', label: 'GLM 5.3 Flash', api: 'dsh', default: false, provider: 'agent2api', providerName: 'Agent2API' })
  assert.equal('provider' in list.data[1], false)
  const api = await (await fetch(`${site.url}/webchat/api/models`)).json()
  assert.deepEqual(api.models[0], { id: 'agent2api/glm-5.3-flash', label: 'GLM 5.3 Flash', api: 'dsh', default: false, provider: 'agent2api', providerName: 'Agent2API' })
  assert.equal('provider' in api.models[1], false)
})

test('/webchat/api/dsh-models：按 provider 分组返回，组 id/组名供前端两级菜单使用', async () => {
  const home = tempHome()
  const ctx = {
    get(name) {
      if (name !== 'llm') return undefined
      return {
        listProviders: () => [{ id: 'agent2api', name: 'Agent2API' }, { id: 'bifrost', name: 'Bifrost' }],
        listModels: async provider => (provider === 'agent2api'
          ? [{ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }]
          : [{ id: 'muse-spark', name: 'Muse Spark' }]),
        resolveModelInfo: async () => ({}),
      }
    },
  }
  const site = await plugin({ stateFile: path.join(home, 'state.json') }, home, ctx)
  const body = await (await fetch(`${site.url}/webchat/api/dsh-models`)).json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.groups.map(group => [group.id, group.name]), [['agent2api', 'Agent2API'], ['bifrost', 'Bifrost']])
  assert.deepEqual(body.groups.map(group => group.models.map(model => model.id)), [['glm-5.3-flash'], ['muse-spark']])
  // 全部 provider 成功时不带 failures 字段（失败隔离见 dsh-models.test.js）。
  assert.equal('failures' in body, false)
})

test('没有 llm 服务时两个模型接口保持向后兼容（不带 provider 字段）', async () => {
  const home = tempHome()
  const site = await plugin({ stateFile: path.join(home, 'state.json') }, home)
  const list = await (await fetch(`${site.url}/webchat/models`)).json()
  assert.deepEqual(list.data.map(item => item.id), ['deepseek-flash'])
  assert.equal('provider' in list.data[0], false)
  const api = await (await fetch(`${site.url}/webchat/api/models`)).json()
  assert.deepEqual(api.models, [{ id: 'deepseek-flash', label: 'DeepSeek 网页版', api: 'anthropic', default: true }])
})
