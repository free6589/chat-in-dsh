import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createModelRegistry,
  fromDshEntry,
  mergeDshCatalog,
  modelCatalog,
} from '../src/models.js'
import { listDshModels } from '../src/dsh-models.js'
import { proxyDshDispatch, toGenerateInput } from '../src/dsh-dispatch.js'

const dshGroups = [
  {
    id: 'agent2api',
    name: 'Agent2API',
    models: [
      { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', reasoning: { efforts: [{ id: 'low', name: '低' }], defaultEffort: 'low' } },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
    ],
  },
  { id: 'bifrost', name: 'Bifrost', models: [{ id: 'muse-spark', name: 'Muse Spark' }] },
]

test('fromDshEntry：provider/model 拼 id，api 记为 dsh', () => {
  const entry = fromDshEntry({ id: 'agent2api', name: 'Agent2API' }, { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' })
  assert.equal(entry.id, 'agent2api/glm-5.3-flash')
  assert.equal(entry.api, 'dsh')
  assert.equal(entry.provider, 'agent2api')
  assert.equal(entry.upstreamModel, 'glm-5.3-flash')
  assert.equal(entry.label, 'GLM 5.3 Flash')
})

test('mergeDshCatalog：DSH 全量在前，插件项追加兜底', () => {
  const plugin = modelCatalog({ models: [{ id: 'deepseek-flash', label: 'DeepSeek 网页版' }] })
  const merged = mergeDshCatalog(plugin, dshGroups)
  assert.deepEqual(
    merged.entries.map(entry => entry.id),
    ['agent2api/glm-5.3-flash', 'agent2api/deepseek-v4.1-flash', 'bifrost/muse-spark', 'deepseek-flash'],
  )
  assert.equal(merged.entries[0].api, 'dsh')
  assert.equal(merged.entries.at(-1).api, 'anthropic')
})

test('mergeDshCatalog：DSH 条目携带 provider 分组字段，插件项不带', () => {
  const plugin = modelCatalog({ models: [{ id: 'deepseek-flash' }] })
  const merged = mergeDshCatalog(plugin, dshGroups)
  for (const entry of merged.entries.slice(0, 3)) {
    assert.equal(entry.provider, entry.id.split('/')[0])
    assert.equal(entry.providerName, { agent2api: 'Agent2API', bifrost: 'Bifrost' }[entry.provider])
  }
  const tail = merged.entries.at(-1)
  assert.equal(tail.provider, undefined)
  assert.equal(tail.providerName, undefined)
  // 默认单项（没配 models）同样不带 provider 字段。
  const fallback = mergeDshCatalog(modelCatalog({}), dshGroups)
  assert.equal(fallback.entries.at(-1).provider, undefined)
})

test('registry.list：DSH 条目暴露 provider/providerName，插件项与默认单项保持原状', () => {
  const withDsh = createModelRegistry({ models: [{ id: 'deepseek-flash' }] }, '/tmp/no-such-home', dshGroups)
  const listed = withDsh.list()
  assert.deepEqual(listed[0], { id: 'agent2api/glm-5.3-flash', label: 'GLM 5.3 Flash', api: 'dsh', default: false, provider: 'agent2api', providerName: 'Agent2API' })
  assert.deepEqual(listed.at(-1), { id: 'deepseek-flash', label: 'deepseek-flash', api: 'anthropic', default: true })
  const plain = createModelRegistry({ models: [{ id: 'a' }] }, '/tmp/no-such-home')
  assert.deepEqual(plain.list(), [{ id: 'a', label: 'a', api: 'anthropic', default: true }])
})

test('mergeDshCatalog：插件项与 DSH 项 id 冲突时 DSH 优先', () => {
  const plugin = modelCatalog({ models: [{ id: 'agent2api/glm-5.3-flash', label: '插件的' }] })
  const merged = mergeDshCatalog(plugin, dshGroups)
  assert.equal(merged.entries.filter(entry => entry.id === 'agent2api/glm-5.3-flash').length, 1)
  assert.equal(merged.entries[0].label, 'GLM 5.3 Flash')
})

test('mergeDshCatalog：没有 DSH 分组时退回插件目录', () => {
  const plugin = modelCatalog({ models: [{ id: 'a' }] })
  assert.deepEqual(mergeDshCatalog(plugin, []).entries.map(entry => entry.id), ['a'])
  assert.deepEqual(mergeDshCatalog(plugin).entries.map(entry => entry.id), ['a'])
})

test('createModelRegistry 传 dshGroups：active 走合并目录', () => {
  const models = createModelRegistry({ models: [{ id: 'deepseek-flash' }] }, '/tmp/no-such-home', dshGroups)
  assert.equal(models.catalog.entries.length, 4)
  assert.equal(models.select('bifrost/muse-spark'), true)
  assert.equal(models.active().provider, 'bifrost')
  assert.equal(models.active().upstreamModel, 'muse-spark')
  assert.equal(models.select('不存在'), false)
})

test('listDshModels：宿主无 llm 服务时回退', async () => {
  const result = await listDshModels({ get: () => undefined })
  assert.equal(result.ok, false)
  assert.deepEqual(result.groups, [])
})

test('listDshModels：走 ctx.llm 同一份目录', async () => {
  const ctx = {
    get(name) {
      if (name !== 'llm') return undefined
      return {
        listProviders: () => [{ id: 'p1', name: 'P1' }],
        listModels: async provider => {
          assert.equal(provider, 'p1')
          return [{ id: 'm1', name: 'M1' }]
        },
        resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high', name: '高' }], defaultEffort: 'high' } }),
      }
    },
  }
  const result = await listDshModels(ctx)
  assert.equal(result.ok, true)
  assert.equal(result.groups.length, 1)
  assert.equal(result.groups[0].models[0].id, 'm1')
  assert.equal(result.groups[0].models[0].reasoning.defaultEffort, 'high')
})

test('listDshModels：单个 provider 失败不影响其他', async () => {
  const ctx = {
    get(name) {
      if (name !== 'llm') return undefined
      return {
        listProviders: () => [{ id: 'bad', name: 'Bad' }, { id: 'good', name: 'Good' }],
        listModels: async provider => {
          if (provider === 'bad') throw new Error('挂了')
          return [{ id: 'm', name: 'M' }]
        },
        resolveModelInfo: async () => ({}),
      }
    },
  }
  const result = await listDshModels(ctx)
  assert.equal(result.ok, true)
  assert.deepEqual(result.groups.map(group => group.id), ['good'])
  assert.deepEqual(result.failures.map(failure => failure.id), ['bad'])
})

test('toGenerateInput：assistant 历史压成带前缀的 user 上下文', () => {
  const input = toGenerateInput({
    system: '你是助手',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
      { role: 'assistant', content: [{ type: 'text', text: '在的' }] },
      { role: 'user', content: '再问一句' },
    ],
    max_tokens: 128,
    temperature: 0.7,
    stop_sequences: ['停'],
  })
  assert.equal(input.system, '你是助手')
  assert.equal(input.messages.length, 3)
  assert.equal(input.messages[0].content[0].text, '你好')
  assert.match(input.messages[1].content[0].text, /助手上一轮回复：在的/u)
  assert.equal(input.maxTokens, 128)
  assert.equal(input.temperature, 0.7)
  assert.deepEqual(input.stop, ['停'])
})

test('toGenerateInput：空消息被丢掉，图片块只留文本', () => {
  const input = toGenerateInput({
    messages: [
      { role: 'user', content: [{ type: 'text', text: '' }] },
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
      { role: 'system', content: '不该出现' },
    ],
  })
  assert.deepEqual(input.messages, [])
  assert.equal(input.system, undefined)
})

test('toGenerateInput：system 数组压平，图片块丢掉', () => {
  const input = toGenerateInput({
    system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(input.system, 'A\nB')
})

/** 记录 prepareCall/stream 收到的参数，并用假的响应对象收 SSE 帧。 */
function fakeDispatch(record) {
  const res = {
    status: 0,
    headers: undefined,
    headersSent: false,
    writableEnded: false,
    frames: [],
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    write(chunk) {
      this.frames.push(String(chunk))
    },
    end() {
      this.writableEnded = true
    },
    destroy() {},
    on() {},
  }
  const ctx = {
    llm: {
      async prepareCall(config, signal) {
        record.config = config
        record.signal = signal
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
  return { ctx, res }
}

test('proxyDshDispatch：请求里的 effort 透传到 prepareCall 与 stream', async () => {
  const record = {}
  const { ctx, res } = fakeDispatch(record)
  await proxyDshDispatch(ctx, Buffer.from(JSON.stringify({
    messages: [{ role: 'user', content: 'hi' }],
    effort: 'high',
  })), res, { provider: 'agent2api', model: 'glm-5.3-flash' })
  assert.equal(record.config.provider, 'agent2api')
  assert.equal(record.config.model, 'glm-5.3-flash')
  assert.equal(record.config.reasoningEffort, 'high')
  assert.equal(record.streamOptions.reasoningEffort, 'high')
  assert.match(res.frames.join(''), /event: message_stop/u)
})

test('proxyDshDispatch：thinking.effort 的未知取值原样透传', async () => {
  const record = {}
  const { ctx, res } = fakeDispatch(record)
  await proxyDshDispatch(ctx, Buffer.from(JSON.stringify({
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', effort: 'ultra-thinking' },
  })), res, { provider: 'agent2api', model: 'glm-5.3-flash' })
  assert.equal(record.config.reasoningEffort, 'ultra-thinking')
  assert.equal(record.streamOptions.reasoningEffort, 'ultra-thinking')
})

test('proxyDshDispatch：请求里的 effort 覆盖目录默认值', async () => {
  const record = {}
  const { ctx, res } = fakeDispatch(record)
  await proxyDshDispatch(ctx, Buffer.from(JSON.stringify({
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', effort: 'minimal' },
  })), res, { provider: 'agent2api', model: 'glm-5.3-flash', reasoningEffort: 'low' })
  assert.equal(record.config.reasoningEffort, 'minimal')
})

test('proxyDshDispatch：没有 effort 选择时请求形状与 v1.4.0 一致', async () => {
  const record = {}
  const { ctx, res } = fakeDispatch(record)
  await proxyDshDispatch(ctx, Buffer.from(JSON.stringify({
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 32,
    thinking: { type: 'enabled' },
  })), res, { provider: 'agent2api', model: 'glm-5.3-flash' })
  assert.deepEqual(Object.keys(record.config).sort(), ['maxTokens', 'messages', 'model', 'provider'])
  assert.equal('reasoningEffort' in record.streamOptions, false)
  assert.equal(record.streamOptions.signal instanceof AbortSignal, true)
  assert.match(res.frames.join(''), /event: message_stop/u)
})

test('proxyDshDispatch：只有目录默认值时不带请求级覆盖，仍带 reasoningEffort', async () => {
  const record = {}
  const { ctx, res } = fakeDispatch(record)
  await proxyDshDispatch(ctx, Buffer.from(JSON.stringify({
    messages: [{ role: 'user', content: 'hi' }],
  })), res, { provider: 'agent2api', model: 'glm-5.3-flash', reasoningEffort: 'low' })
  assert.equal(record.config.reasoningEffort, 'low')
  assert.equal(record.streamOptions.reasoningEffort, 'low')
})
