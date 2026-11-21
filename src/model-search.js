/**
 * 模型搜索：面板菜单与设置页共用的一套纯函数。
 *
 * 规则对齐 DSH 自己的模型菜单（`rankByName`）：
 *   - 名字按大小写不敏感的有序子序列匹配，`glm` 能命中 `GLM 5.3 Flash`，`flash` 也能；
 *   - 排序先看是否前缀命中，再看命中是否紧凑，最后才是目录顺序；
 *   - 分组标题只在组内还有命中模型时出现，标题本身不参与模型匹配。
 *
 * 与本文件同源的浏览器副本在 `client.js` 的 ModelBar 里（客户端插件拿不到 ESM
 * 模块系统）。两边行为由 `test/client-model-menu.test.js` 的一致性用例盯着。
 */

/** 目录非空但筛不出东西时的文案（对齐 DSH `search.empty`）。 */
export const EMPTY_NO_MATCH = '没有匹配的模型。'

/** 目录本来就是空时的文案（对齐 DSH `empty.models`）。 */
export const EMPTY_NO_MODELS = '暂无可用模型。'

/** 目录项里参与搜索的字段，按优先级排列：先名字，再 id，最后 provider。 */
export const MODEL_SEARCH_FIELDS = ['label', 'id', 'providerName', 'provider']

/** query 归一化：去首尾空白、转小写；非字符串一律当空查询。 */
export function normalizeQuery(query) {
  return typeof query === 'string' ? query.trim().toLowerCase() : ''
}

/**
 * 有序子序列匹配。
 * @param {string} text 被搜索的文本
 * @param {string} query 原始查询串
 * @returns {{ indices: number[], score: number } | undefined} 命中下标与评分；不命中为 undefined
 */
export function matchText(text, query) {
  const q = normalizeQuery(query)
  const source = typeof text === 'string' ? text : ''
  if (q === '') return { indices: [], score: 0 }
  const haystack = source.toLowerCase()
  const indices = []
  let from = 0
  for (const character of q) {
    const found = haystack.indexOf(character, from)
    if (found < 0) return undefined
    indices.push(found)
    from = found + 1
  }
  // 评分：前缀命中排最前；同组内比命中跨度（越紧凑越靠前）。
  const span = indices[indices.length - 1] - indices[0] + 1
  return { indices, score: (indices[0] === 0 ? 0 : 1000) + span }
}

/**
 * 把命中下标切成「普通段 / 命中段」，供渲染 `<mark>` 用。
 * @param {string} text 原文本
 * @param {number[]} indices 命中下标（升序，来自 matchText）
 * @returns {Array<{ text: string, hit: boolean }>}
 */
export function highlightSegments(text, indices) {
  const source = typeof text === 'string' ? text : String(text ?? '')
  const hits = new Set((Array.isArray(indices) ? indices : []).filter(index => index >= 0 && index < source.length))
  if (hits.size === 0) return [{ text: source, hit: false }]
  const segments = []
  for (let index = 0; index < source.length; index += 1) {
    const hit = hits.has(index)
    const last = segments[segments.length - 1]
    if (last !== undefined && last.hit === hit) last.text += source[index]
    else segments.push({ text: source[index], hit })
  }
  return segments
}

/**
 * 在一条目录项上找最佳命中字段。
 * @param {object} entry 目录项（label/id/providerName/provider 任一可缺）
 * @param {string} query 原始查询串
 * @param {string[]} fields 参与匹配的字段，按优先级
 * @returns {{ field: string, indices: number[], score: number } | undefined}
 */
export function matchEntry(entry, query, fields = MODEL_SEARCH_FIELDS) {
  if (normalizeQuery(query) === '') return { field: '', indices: [], score: 0 }
  if (entry === null || typeof entry !== 'object') return undefined
  let best
  for (const field of fields) {
    const hit = matchText(entry[field], query)
    if (hit === undefined) continue
    // 字段优先级高于评分：label 命中就压过 provider 命中。
    if (best === undefined) best = { field, indices: hit.indices, score: hit.score }
    else if (hit.score < best.score) best = { field, indices: hit.indices, score: hit.score }
  }
  return best
}

/**
 * 按查询给目录项排序过滤。
 * @param {Array<object>} entries 目录项
 * @param {string} query 原始查询串
 * @param {string[]} fields 参与匹配的字段
 * @returns {Array<{ entry: object, field: string, indices: number[], score: number }>}
 */
export function rankEntries(entries, query, fields = MODEL_SEARCH_FIELDS) {
  const list = Array.isArray(entries) ? entries : []
  const empty = normalizeQuery(query) === ''
  const rows = []
  list.forEach((entry, order) => {
    if (entry === null || typeof entry !== 'object') return
    if (empty) {
      rows.push({ entry, field: '', indices: [], score: 0, order })
      return
    }
    const hit = matchEntry(entry, query, fields)
    if (hit !== undefined) rows.push({ entry, ...hit, order })
  })
  if (!empty) rows.sort((left, right) => left.score - right.score || left.order - right.order)
  return rows.map(({ order: _order, ...row }) => row)
}

/**
 * 过滤 provider 分组目录（面板菜单的形状）。
 *
 * 组标题命中时整组保留（标题高亮），组内模型不逐个过滤；否则只留命中的模型。
 * 组内一个都不剩的组直接消失，和 DSH 的分组标题行为一致。
 *
 * @param {Array<{ id: string, name?: string, models?: Array<object> }>} groups
 * @param {string} query 原始查询串
 * @returns {Array<{ id: string, name: string, titleHit: boolean, titleIndices: number[],
 *   models: Array<{ model: object, indices: number[], field: string }> }>}
 */
export function filterGroups(groups, query) {
  const list = Array.isArray(groups) ? groups : []
  const empty = normalizeQuery(query) === ''
  const result = []
  for (const group of list) {
    if (group === null || typeof group !== 'object') continue
    const models = Array.isArray(group.models) ? group.models : []
    const title = empty ? undefined : (matchText(group.name, query) ?? matchText(group.id, query))
    if (empty) {
      result.push({
        id: group.id,
        name: group.name ?? group.id,
        titleHit: false,
        titleIndices: [],
        models: models.map(model => ({ model, indices: [], field: '' })),
      })
      continue
    }
    if (title !== undefined) {
      result.push({
        id: group.id,
        name: group.name ?? group.id,
        titleHit: true,
        titleIndices: title.indices,
        models: models.map(model => ({ model, indices: [], field: '' })),
      })
      continue
    }
    const ranked = rankEntries(models.map(model => ({
      id: model?.id,
      label: model?.name,
      model,
    })), query, ['label', 'id'])
    if (ranked.length === 0) continue
    result.push({
      id: group.id,
      name: group.name ?? group.id,
      titleHit: false,
      titleIndices: [],
      models: ranked.map(row => ({ model: row.entry.model, indices: row.indices, field: row.field })),
    })
  }
  return result
}
