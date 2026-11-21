import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  EMPTY_NO_MATCH,
  EMPTY_NO_MODELS,
  filterGroups,
  highlightSegments,
  matchEntry,
  matchText,
  normalizeQuery,
  rankEntries,
} from '../src/model-search.js'

// ---- 查询归一化 ----

test('查询归一化：去空白、转小写，非字符串当空查询', () => {
  assert.equal(normalizeQuery('  GLM  '), 'glm')
  assert.equal(normalizeQuery(''), '')
  assert.equal(normalizeQuery(undefined), '')
  assert.equal(normalizeQuery(null), '')
})

// ---- 匹配：有序子序列 ----

test('匹配：前缀命中记 0 下标，跨字符命中按下标返回', () => {
  const prefix = matchText('GLM 5.3 Flash', 'glm')
  assert.deepEqual(prefix.indices, [0, 1, 2])
  assert.equal(prefix.score, 3)

  const spread = matchText('DeepSeek 网页版', 'dsv')
  assert.equal(spread, undefined)

  const inner = matchText('Qwen3.8 Flash', 'flash')
  assert.deepEqual(inner.indices, [8, 9, 10, 11, 12])
})

test('匹配：大小写不敏感，未命中返回 undefined，空查询命中全部', () => {
  assert.deepEqual(matchText('AGNES-3.0', 'agnes').indices, [0, 1, 2, 3, 4])
  assert.equal(matchText('agnes', 'zz'), undefined)
  assert.deepEqual(matchText('agnes', '  '), { indices: [], score: 0 })
})

test('匹配：前缀命中排在中间命中之前，紧凑命中排在分散命中之前', () => {
  const prefix = matchText('glm-5', 'glm')
  const middle = matchText('agent2api/glm-5', 'glm')
  const compact = matchText('ab-flash', 'flash')
  const scattered = matchText('x-f-l-a-s-h', 'flash')
  assert.ok(prefix.score < middle.score)
  assert.ok(compact.score < scattered.score)
})

// ---- 高亮切段 ----

test('高亮：命中段单独成段，多段命中与未命中混排', () => {
  assert.deepEqual(highlightSegments('GLM 5.3 Flash', [0, 1, 2]), [
    { text: 'GLM', hit: true },
    { text: ' 5.3 Flash', hit: false },
  ])
  assert.deepEqual(highlightSegments('abc', [0, 2]), [
    { text: 'a', hit: true },
    { text: 'b', hit: false },
    { text: 'c', hit: true },
  ])
})

test('高亮：没有命中下标时整段返回，越界下标忽略', () => {
  assert.deepEqual(highlightSegments('abc', []), [{ text: 'abc', hit: false }])
  assert.deepEqual(highlightSegments('abc', [9, -1]), [{ text: 'abc', hit: false }])
  assert.deepEqual(highlightSegments(undefined, [0]), [{ text: '', hit: false }])
})

// ---- 目录项匹配 ----

const entries = [
  { id: 'agent2api/glm-5.3-flash', label: 'GLM 5.3 Flash', provider: 'agent2api', providerName: 'Agent2API' },
  { id: 'agent2api/qwen3.8-flash', label: 'Qwen3.8 Flash', provider: 'agent2api', providerName: 'Agent2API' },
  { id: 'bifrost-completions/agnes-3.0-flash', label: 'Agnes 3.0 Flash', provider: 'bifrost-completions', providerName: 'Bifrost' },
  { id: 'deepseek-flash', label: 'DeepSeek 网页版', api: 'anthropic' },
]

test('目录项匹配：名字优先于 provider，名字没命中才看 id 与 provider', () => {
  assert.equal(matchEntry(entries[0], 'glm').field, 'label')
  assert.equal(matchEntry(entries[0], 'qwen'), undefined)
  assert.equal(matchEntry(entries[0], 'agent2api').field, 'id')
  const providerOnly = { id: 'agnes-3.0-flash', label: 'Agnes 3.0 Flash', provider: 'bifrost-completions', providerName: 'Bifrost Cloud' }
  assert.equal(matchEntry(providerOnly, 'bifrost').field, 'providerName')
  assert.equal(matchEntry(providerOnly, 'completions').field, 'provider')
  assert.equal(matchEntry(entries[3], 'deepseek-flash').field, 'id')
})

test('目录项匹配：空查询命中全部，非对象不命中', () => {
  assert.deepEqual(matchEntry(entries[0], '  '), { field: '', indices: [], score: 0 })
  assert.equal(matchEntry(null, 'glm'), undefined)
})

test('排序过滤：前缀命中在前，同分保持目录顺序，空查询原样返回', () => {
  const ranked = rankEntries(entries, 'flash')
  // 四条都是非前缀命中、跨度相同，于是保持目录顺序（deepseek-flash 命中在 id 上）。
  assert.deepEqual(ranked.map(row => row.entry.id), [
    'agent2api/glm-5.3-flash',
    'agent2api/qwen3.8-flash',
    'bifrost-completions/agnes-3.0-flash',
    'deepseek-flash',
  ])
  assert.deepEqual(rankEntries(entries, '').map(row => row.entry.id), entries.map(entry => entry.id))
  assert.deepEqual(rankEntries(entries, 'nope'), [])
})

test('排序过滤：provider 关键字把同 provider 的项都筛出来', () => {
  assert.deepEqual(rankEntries(entries, 'bifrost').map(row => row.entry.id), ['bifrost-completions/agnes-3.0-flash'])
  assert.deepEqual(rankEntries(entries, 'agent2api').map(row => row.entry.id), [
    'agent2api/glm-5.3-flash',
    'agent2api/qwen3.8-flash',
  ])
})

// ---- 面板菜单的分组过滤 ----

const groups = [
  {
    id: 'agent2api',
    name: 'Agent2API',
    models: [
      { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
      { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash' },
    ],
  },
  {
    id: 'bifrost',
    name: 'Bifrost',
    models: [{ id: 'agnes-3.0-flash', name: 'Agnes 3.0 Flash' }],
  },
]

test('分组过滤：空查询保留全部组与模型，不打高亮', () => {
  const view = filterGroups(groups, '')
  assert.deepEqual(view.map(group => group.id), ['agent2api', 'bifrost'])
  assert.equal(view[0].titleHit, false)
  assert.deepEqual(view[0].models.map(row => row.model.id), ['glm-5.3-flash', 'qwen3.8-flash'])
  assert.deepEqual(view[0].models[0].indices, [])
})

test('分组过滤：组标题命中时整组保留，标题带高亮下标', () => {
  const view = filterGroups(groups, 'bifrost')
  assert.equal(view.length, 1)
  assert.equal(view[0].id, 'bifrost')
  assert.equal(view[0].titleHit, true)
  assert.deepEqual(view[0].titleIndices, [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual(view[0].models.map(row => row.model.id), ['agnes-3.0-flash'])
})

test('分组过滤：模型命中只留命中项，空组消失，命中名字带下标', () => {
  const view = filterGroups(groups, 'glm')
  assert.deepEqual(view.map(group => group.id), ['agent2api'])
  assert.equal(view[0].titleHit, false)
  assert.deepEqual(view[0].models.map(row => row.model.id), ['glm-5.3-flash'])
  assert.deepEqual(view[0].models[0].indices, [0, 1, 2])

  assert.deepEqual(filterGroups(groups, 'zzz'), [])
})

test('分组过滤：模型 id 命中（名字没命中）也能筛出来', () => {
  const view = filterGroups(groups, 'qwen3')
  assert.deepEqual(view[0].models.map(row => row.model.id), ['qwen3.8-flash'])
  assert.equal(view[0].models[0].field, 'label')
})

test('空态文案与 DSH 一致', () => {
  assert.equal(EMPTY_NO_MATCH, '没有匹配的模型。')
  assert.equal(EMPTY_NO_MODELS, '暂无可用模型。')
})
