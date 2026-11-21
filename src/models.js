/**
 * 模型目录与当前选择。
 *
 * 网页版前端把 model 写死成 `deepseek-flash`（`webview/dist` 里的 ek 常量），
 * 所以"换模型"只能在宿主做：目录由插件配置给出，选择落在 DSH_HOME 下的一个
 * 小状态文件里；请求转发前用所选模型替换请求体里的 model。
 *
 * 不配置 `models` 时目录只有官方 DeepSeek 一项，行为与之前完全一致：
 * 请求体原样转发，不替换、不改写。
 */
import fs from 'node:fs'
import path from 'node:path'
import { rankEntries } from './model-search.js'

/** 官方网页版使用的模型名；前端请求体里写死的就是它。 */
export const DEFAULT_MODEL_ID = 'deepseek-flash'

/** 支持的两种上游协议。 */
const APIS = new Set(['anthropic', 'openai'])

/** 未配置模型目录时的唯一一项。 */
function defaultEntry() {
  return {
    id: DEFAULT_MODEL_ID,
    label: 'DeepSeek 网页版',
    api: 'anthropic',
    baseURL: undefined,
    upstreamModel: undefined,
    apiKeyEnv: undefined,
  }
}

/** 把配置里的一项规范化；id 缺失或协议不认识时返回 undefined（整项丢弃）。 */
function normalizeEntry(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id === '') return undefined
  const api = typeof raw.api === 'string' ? raw.api.trim().toLowerCase() : 'anthropic'
  if (!APIS.has(api)) return undefined
  let baseURL
  if (typeof raw.baseURL === 'string' && raw.baseURL.trim() !== '') {
    baseURL = raw.baseURL.trim()
    try {
      new URL(baseURL)
    } catch {
      return undefined
    }
  }
  const upstreamModel = typeof raw.upstreamModel === 'string' && raw.upstreamModel.trim() !== ''
    ? raw.upstreamModel.trim()
    : undefined
  const apiKeyEnv = typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv.trim() !== ''
    ? raw.apiKeyEnv.trim()
    : undefined
  const label = typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : id
  return { id, label, api, baseURL, upstreamModel, apiKeyEnv }
}

/**
 * 解析插件配置里的模型目录。
 * @returns {{ entries: Array<object>, isDefault: boolean, defaultId: string }}
 *   `isDefault` 为 true 表示用户没配目录，此时不替换请求体里的 model。
 */
export function modelCatalog(config = {}) {
  const raw = Array.isArray(config?.models) ? config.models : []
  const entries = []
  const seen = new Set()
  for (const item of raw) {
    const entry = normalizeEntry(item)
    if (entry === undefined || seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }
  if (entries.length === 0) {
    const only = defaultEntry()
    return { entries: [only], isDefault: true, defaultId: only.id }
  }
  const configuredDefault = typeof config?.defaultModel === 'string' ? config.defaultModel.trim() : ''
  const defaultId = seen.has(configuredDefault) ? configuredDefault : entries[0].id
  return { entries, isDefault: false, defaultId }
}

/** DSH 目录项 → 面板目录项：provider/model 拼成唯一 id（`provider/model`）。
 * 与 DSH 聊天框同源的条目经这个函数进入面板下拉；选中后宿主走对应 provider 发请求。
 */
export function fromDshEntry(provider, model) {
  return {
    id: `${provider.id}/${model.id}`,
    label: model.name,
    api: 'dsh',
    provider: provider.id,
    providerName: provider.name,
    upstreamModel: model.id,
    reasoning: model.reasoning,
  }
}

/**
 * DSH 目录 + 插件目录合并：DSH 全量在前（与 DSH 聊天框同源、同顺序），
 * 插件 models 里 id 不冲突的项追加在后作兜底（含官方 deepseek-flash 直通项）。
 */
export function mergeDshCatalog(pluginCatalog, dshGroups = []) {
  const entries = []
  const seen = new Set()
  if (Array.isArray(dshGroups)) {
    for (const group of dshGroups) {
      if (group === null || typeof group !== 'object') continue
      for (const model of Array.isArray(group.models) ? group.models : []) {
        const entry = fromDshEntry(
          { id: group.id, name: group.name },
          model,
        )
        if (seen.has(entry.id)) continue
        seen.add(entry.id)
        entries.push(entry)
      }
    }
  }
  for (const entry of pluginCatalog.entries) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }
  if (entries.length === 0) return pluginCatalog
  const defaultId = seen.has(pluginCatalog.defaultId) ? pluginCatalog.defaultId : entries[0].id
  return { entries, isDefault: false, defaultId }
}

/** 按 query 过滤目录项：规则见 `model-search.js`（名字优先、provider 兜底、前缀优先排序），
 * 与设置页搜索框和面板菜单共用一套实现。
 * 空串或空白 query 原样返回；返回新数组，不改原数组。
 */
export function filterModels(entries, query) {
  return rankEntries(entries, query).map(row => row.entry)
}

/** 按 id 找目录项。 */
export function findModelEntry(catalog, id) {
  if (typeof id !== 'string' || id === '') return undefined
  return catalog.entries.find(entry => entry.id === id)
}

/** 模型选择状态文件：默认 DSH_HOME/chat-in-dsh/model-state.json，可用 config.stateFile 覆盖。 */
export function resolveStateFile(home, config = {}) {
  if (typeof config?.stateFile === 'string' && config.stateFile.trim() !== '') return config.stateFile.trim()
  return path.join(home, 'chat-in-dsh', 'model-state.json')
}

/** 读选择；文件缺失或内容损坏时返回 undefined（回退默认模型）。
 * 返回 { model, effort? }：effort 是第二步 UI 两级菜单选的推理档位，
 * 派发时透传 reasoningEffort。老文件只有 model 时 effort 为 undefined。
 */
export function readSelection(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof parsed?.model !== 'string' || parsed.model === '') return undefined
    const effort = typeof parsed?.effort === 'string' && parsed.effort !== '' ? parsed.effort : undefined
    return { model: parsed.model, ...(effort === undefined ? {} : { effort }) }
  } catch {
    return undefined
  }
}

/** 写选择：先写同目录临时文件再改名，避免写到一半留下坏 JSON。 */
export function writeSelection(file, id, effort) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  const payload = { model: id, ...(effort === undefined ? {} : { effort }) }
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

/** 当前生效的模型 id：状态文件 → 配置默认 → 目录第一项。
 * selection 是 readSelection 的返回值（{ model, effort? }）或裸 model 字符串（兼容）。
 */
export function activeModelId(catalog, selection) {
  const id = typeof selection === 'string' ? selection : selection?.model
  if (typeof id === 'string' && findModelEntry(catalog, id) !== undefined) return id
  return catalog.defaultId
}

/** 当前生效的 effort：只有状态文件里的模型仍在目录里时才有效，否则 undefined。 */
export function activeEffortOf(catalog, selection) {
  const id = typeof selection === 'string' ? undefined : selection?.model
  const effort = typeof selection === 'string' ? undefined : selection?.effort
  if (typeof id !== 'string' || typeof effort !== 'string') return undefined
  return findModelEntry(catalog, id) === undefined ? undefined : effort
}

/**
 * 模型注册表：目录 + 选择文件。
 * 每次 active() 都重读状态文件，所以外部改文件（或用设置页切换）都能立刻生效。
 *
 * `dshGroups` 是宿主经 ctx.llm 取到的 DSH 同一份目录（与 DSH 聊天框同源）：
 * 传了它，目录 = DSH 全量 provider/model（api: 'dsh'）+ 插件 models 配置合并
 * （插件项 id 不与 DSH 项冲突时追加，作兜底）；不传时退回纯插件目录行为。
 */
export function createModelRegistry(config, home, dshGroups = []) {
  const catalog = modelCatalog(config)
  const merged = mergeDshCatalog(catalog, dshGroups)
  const file = resolveStateFile(home, config)
  return {
    catalog: merged,
    file,
    list() {
      return merged.entries.map(entry => ({
        id: entry.id,
        label: entry.label,
        api: entry.api,
        default: entry.id === merged.defaultId,
        // provider 分组字段只随 DSH 条目出现；插件项与默认单项保持原样（向后兼容）。
        ...(entry.provider === undefined ? {} : { provider: entry.provider, providerName: entry.providerName }),
      }))
    },
    activeId() {
      return activeModelId(merged, readSelection(file))
    },
    activeEffort() {
      return activeEffortOf(merged, readSelection(file))
    },
    active() {
      const id = activeModelId(merged, readSelection(file))
      const entry = findModelEntry(merged, id) ?? merged.entries[0]
      return entry === undefined
        ? undefined
        : { ...entry, reasoningEffort: activeEffortOf(merged, readSelection(file)) }
    },
    select(id, effort) {
      if (findModelEntry(merged, id) === undefined) return false
      writeSelection(file, id, effort)
      return true
    },
  }
}
