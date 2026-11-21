import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createModelRegistry,
  fromDshEntry,
  mergeDshCatalog,
  modelCatalog,
} from '../src/models.js'
import { listDshModels } from '../src/dsh-models.js'
import { toGenerateInput } from '../src/dsh-dispatch.js'

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
