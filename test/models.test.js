import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_MODEL_ID,
  activeEffortOf,
  activeModelId,
  createModelRegistry,
  filterModels,
  findModelEntry,
  mergeDshCatalog,
  modelCatalog,
  readSelection,
  resolveStateFile,
  writeSelection,
} from '../src/models.js'

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chat-in-dsh-models-'))

test('没配 models 时目录只有官方 DeepSeek，且标记为默认行为', () => {
  const catalog = modelCatalog({})
  assert.equal(catalog.isDefault, true)
  assert.equal(catalog.entries.length, 1)
  assert.equal(catalog.entries[0].id, DEFAULT_MODEL_ID)
  assert.equal(catalog.entries[0].api, 'anthropic')
  assert.equal(catalog.defaultId, DEFAULT_MODEL_ID)
})

test('配了 models 就不再是默认行为，且默认取第一项', () => {
  const catalog = modelCatalog({
    models: [
      { id: 'glm-5.3-flash', api: 'openai', baseURL: 'http://127.0.0.1:18088/openai/v1', apiKeyEnv: 'BIFROST_VIRTUAL_KEY', upstreamModel: 'agent2api/glm-5.3-flash' },
      { id: 'deepseek-flash' },
    ],
  })
  assert.equal(catalog.isDefault, false)
  assert.deepEqual(catalog.entries.map(entry => entry.id), ['glm-5.3-flash', 'deepseek-flash'])
  assert.equal(catalog.defaultId, 'glm-5.3-flash')
  assert.equal(catalog.entries[0].upstreamModel, 'agent2api/glm-5.3-flash')
  assert.equal(catalog.entries[0].apiKeyEnv, 'BIFROST_VIRTUAL_KEY')
  assert.equal(catalog.entries[1].api, 'anthropic')
  assert.equal(catalog.entries[1].baseURL, undefined)
})

test('defaultModel 指向目录里存在的项时用它', () => {
  const catalog = modelCatalog({
    models: [{ id: 'a' }, { id: 'b' }],
    defaultModel: 'b',
  })
  assert.equal(catalog.defaultId, 'b')
})

test('defaultModel 不在目录里时回退第一项', () => {
  const catalog = modelCatalog({ models: [{ id: 'a' }], defaultModel: 'nope' })
  assert.equal(catalog.defaultId, 'a')
})

test('坏目录项被丢弃：缺 id、协议不认识、baseURL 不是 URL', () => {
  const catalog = modelCatalog({
    models: [
      { api: 'openai' },
      { id: '' },
      { id: 'bad-api', api: 'grpc' },
      { id: 'bad-url', baseURL: 'not a url' },
      { id: 'ok' },
    ],
  })
  assert.deepEqual(catalog.entries.map(entry => entry.id), ['ok'])
})

test('重复 id 只保留第一项', () => {
  const catalog = modelCatalog({ models: [{ id: 'x', label: 'first' }, { id: 'x', label: 'second' }] })
  assert.equal(catalog.entries.length, 1)
  assert.equal(catalog.entries[0].label, 'first')
})

test('models 全是坏项时退回默认单项目录', () => {
  const catalog = modelCatalog({ models: [{ id: '' }] })
  assert.equal(catalog.isDefault, true)
  assert.equal(catalog.entries.length, 1)
})

test('选择状态文件可写入可读回，且文件权限收在 0600', () => {
  const dir = tempDir()
  const file = path.join(dir, 'chat-in-dsh', 'model-state.json')
  assert.equal(readSelection(file), undefined)
  writeSelection(file, 'glm-5.3-flash')
  assert.deepEqual(readSelection(file), { model: 'glm-5.3-flash' })
  writeSelection(file, 'glm-5.3-flash', 'high')
  assert.deepEqual(readSelection(file), { model: 'glm-5.3-flash', effort: 'high' })
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  }
})

test('状态文件损坏时按未选择处理', () => {
  const dir = tempDir()
  const file = path.join(dir, 'broken.json')
  fs.writeFileSync(file, '{not json')
  assert.equal(readSelection(file), undefined)
})

test('activeModelId 跳过目录里不存在的选择', () => {
  const catalog = modelCatalog({ models: [{ id: 'a' }, { id: 'b' }] })
  assert.equal(activeModelId(catalog, 'b'), 'b')
  assert.equal(activeModelId(catalog, 'gone'), 'a')
  assert.equal(activeModelId(catalog, undefined), 'a')
})

test('stateFile 可用配置覆盖，默认落在 DSH_HOME 下', () => {
  assert.equal(resolveStateFile('/home/x', {}), path.join('/home/x', 'chat-in-dsh', 'model-state.json'))
  assert.equal(resolveStateFile('/home/x', { stateFile: '/tmp/s.json' }), '/tmp/s.json')
})

test('注册表切换模型后立刻生效，未知模型被拒', () => {
  const dir = tempDir()
  const config = { models: [{ id: 'a' }, { id: 'b' }], stateFile: path.join(dir, 'state.json') }
  const models = createModelRegistry(config, dir)
  assert.equal(models.active().id, 'a')
  assert.equal(models.select('b'), true)
  assert.equal(models.active().id, 'b')
  assert.equal(models.select('nope'), false)
  assert.equal(models.active().id, 'b')
})

test('注册表发现外部改写的状态文件', () => {
  const dir = tempDir()
  const stateFile = path.join(dir, 'state.json')
  const models = createModelRegistry({ models: [{ id: 'a' }, { id: 'b' }], stateFile }, dir)
  assert.equal(models.active().id, 'a')
  fs.writeFileSync(stateFile, JSON.stringify({ model: 'b' }))
  assert.equal(models.active().id, 'b')
})

test('注册表把选中项落到配置的目录项上', () => {
  const dir = tempDir()
  const config = {
    models: [
      { id: 'deepseek-flash' },
      { id: 'glm-5.3-flash', api: 'openai', baseURL: 'http://127.0.0.1:1/v1', upstreamModel: 'agent2api/glm-5.3-flash' },
    ],
    stateFile: path.join(dir, 'state.json'),
  }
  const models = createModelRegistry(config, dir)
  const entry = findModelEntry(models.catalog, 'glm-5.3-flash')
  assert.equal(entry.upstreamModel, 'agent2api/glm-5.3-flash')
  assert.equal(entry.api, 'openai')
})

// ---- filterModels：模型搜索框的过滤逻辑（匹配 id / label / providerName，大小写不敏感）----

/** 面板下拉里的典型条目：DSH 分组项 + 插件兜底项。 */
const searchable = [
  { id: 'agent2api/glm-5.3-flash', label: 'GLM 5.3 Flash', api: 'dsh', provider: 'agent2api', providerName: 'Agent2API' },
  { id: 'agent2api/qwen3.8-flash', label: 'Qwen3.8 Flash', api: 'dsh', provider: 'agent2api', providerName: 'Agent2API' },
  { id: 'bifrost-completions/agnes-3.0-flash', label: 'Agnes 3.0 Flash', api: 'dsh', provider: 'bifrost-completions', providerName: 'Bifrost' },
  { id: 'deepseek-flash', label: 'DeepSeek 网页版', api: 'anthropic' },
]

test('筛选：空串与纯空白 query 原样返回全部，且返回的是新数组', () => {
  for (const query of ['', '   ', '\t\n']) {
    const filtered = filterModels(searchable, query)
    assert.deepEqual(filtered, searchable)
    assert.notEqual(filtered, searchable)
  }
})

test('筛选：缺省 query 与非法 entries 都不抛错', () => {
  assert.deepEqual(filterModels(searchable, undefined), searchable)
  assert.deepEqual(filterModels(searchable, null), searchable)
  assert.deepEqual(filterModels(undefined, 'glm'), [])
  assert.deepEqual(filterModels(null, 'glm'), [])
})

test('筛选：按 id 匹配，大小写不敏感并忽略首尾空白', () => {
  assert.deepEqual(filterModels(searchable, '  AGENT2API/GLM  ').map(entry => entry.id), ['agent2api/glm-5.3-flash'])
  assert.deepEqual(filterModels(searchable, 'deepseek-flash').map(entry => entry.id), ['deepseek-flash'])
})

test('筛选：按 label 匹配（含中文与空格）', () => {
  assert.deepEqual(filterModels(searchable, '网页版').map(entry => entry.id), ['deepseek-flash'])
  assert.deepEqual(filterModels(searchable, 'qwen3.8').map(entry => entry.id), ['agent2api/qwen3.8-flash'])
  assert.deepEqual(filterModels(searchable, 'Agnes 3.0').map(entry => entry.id), ['bifrost-completions/agnes-3.0-flash'])
})

test('筛选：按 providerName 匹配，一个 provider 下的模型整组命中', () => {
  assert.deepEqual(filterModels(searchable, 'agent2api').map(entry => entry.id), ['agent2api/glm-5.3-flash', 'agent2api/qwen3.8-flash'])
  assert.deepEqual(filterModels(searchable, 'bifrost').map(entry => entry.id), ['bifrost-completions/agnes-3.0-flash'])
})

test('筛选：没有命中的 query 返回空数组，不是全部', () => {
  assert.deepEqual(filterModels(searchable, 'no-such-model'), [])
})

test('筛选：不改原数组，也不改条目对象', () => {
  const before = JSON.stringify(searchable)
  const filtered = filterModels(searchable, 'agent2api')
  filtered.pop()
  assert.equal(JSON.stringify(searchable), before)
  assert.equal(searchable.length, 4)
})

test('筛选：合并目录（DSH 分组项 + 插件兜底项）上按 provider 分组搜得准', () => {
  const merged = mergeDshCatalog(modelCatalog({ models: [{ id: 'deepseek-flash' }] }), [
    { id: 'agent2api', name: 'Agent2API', models: [{ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }, { id: 'mimo-v2.6-pro', name: 'MiMo v2.6 Pro' }] },
    { id: 'bifrost-completions', name: 'Bifrost', models: [{ id: 'agnes-3.0-flash', name: 'Agnes 3.0 Flash' }] },
  ])
  assert.deepEqual(filterModels(merged.entries, 'AGENT2API').map(entry => entry.id), ['agent2api/glm-5.3-flash', 'agent2api/mimo-v2.6-pro'])
  assert.deepEqual(filterModels(merged.entries, 'glm').map(entry => entry.id), ['agent2api/glm-5.3-flash'])
  // 插件兜底项没有 providerName，但 id / label 仍参与匹配。
  assert.deepEqual(filterModels(merged.entries, 'DeepSeek').map(entry => entry.id), ['deepseek-flash'])
  assert.equal(filterModels(merged.entries, 'Agent2API').every(entry => entry.provider === 'agent2api'), true)
})

// ---- effort：第二步 UI 的两级菜单把 effort 一起落盘，派发时透传 reasoningEffort ----

test('选择文件：effort 与 model 一起写、一起读；非字符串或无 effort 的老文件按未选', () => {
  const dir = tempDir()
  const file = path.join(dir, 'state.json')
  writeSelection(file, 'glm-5.3-flash', 'max')
  assert.deepEqual(readSelection(file), { model: 'glm-5.3-flash', effort: 'max' })
  // 重新只写 model，effort 不能残留。
  writeSelection(file, 'glm-5.3-flash')
  assert.deepEqual(readSelection(file), { model: 'glm-5.3-flash' })
  fs.writeFileSync(file, JSON.stringify({ model: 'glm-5.3-flash', effort: 3 }))
  assert.deepEqual(readSelection(file), { model: 'glm-5.3-flash' })
  fs.writeFileSync(file, JSON.stringify({ model: 'glm-5.3-flash', effort: '' }))
  assert.deepEqual(readSelection(file), { model: 'glm-5.3-flash' })
})

test('activeEffortOf：只在选中模型仍在目录里时生效，裸 model 字符串没有 effort', () => {
  const catalog = modelCatalog({ models: [{ id: 'a' }, { id: 'b' }] })
  assert.equal(activeEffortOf(catalog, { model: 'a', effort: 'high' }), 'high')
  assert.equal(activeEffortOf(catalog, { model: 'gone', effort: 'high' }), undefined)
  assert.equal(activeEffortOf(catalog, { model: 'a' }), undefined)
  assert.equal(activeEffortOf(catalog, 'a'), undefined)
  assert.equal(activeEffortOf(catalog, undefined), undefined)
  assert.equal(activeEffortOf(catalog, { model: 'a', effort: 7 }), undefined)
})

test('注册表：select(id, effort) 落盘，activeEffort() 与 active().reasoningEffort 同步', () => {
  const dir = tempDir()
  const config = { models: [{ id: 'a' }, { id: 'b' }], stateFile: path.join(dir, 'state.json') }
  const models = createModelRegistry(config, dir)
  assert.equal(models.activeEffort(), undefined)
  assert.equal('reasoningEffort' in models.active(), true)
  assert.equal(models.active().reasoningEffort, undefined)
  assert.equal(models.select('b', 'xhigh'), true)
  assert.equal(models.activeId(), 'b')
  assert.equal(models.activeEffort(), 'xhigh')
  assert.equal(models.active().reasoningEffort, 'xhigh')
  // 只换模型不带 effort：旧档位不能跟着搬过去。
  assert.equal(models.select('a'), true)
  assert.equal(models.activeEffort(), undefined)
  assert.equal(models.active().reasoningEffort, undefined)
})

test('注册表：未知模型带 effort 也不落盘，原选择与档位都不动', () => {
  const dir = tempDir()
  const config = { models: [{ id: 'a' }], stateFile: path.join(dir, 'state.json') }
  const models = createModelRegistry(config, dir)
  assert.equal(models.select('a', 'low'), true)
  assert.equal(models.select('nope', 'high'), false)
  assert.equal(models.activeId(), 'a')
  assert.equal(models.activeEffort(), 'low')
  assert.deepEqual(readSelection(models.file), { model: 'a', effort: 'low' })
})
