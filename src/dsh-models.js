/**
 * DSH 同一份模型目录。
 *
 * DSH 聊天框的模型选择器读的是 `ctx.llm` 这个 live registry
 *（`dsh-api-session-controller` 的 `buildModelCatalog` 也是从它生成目录）。
 * 面板之前自建了一份 `models` 配置目录，与 DSH 聊天框各说各话；
 * 这里直接读同一份 registry，面板下拉和 DSH 聊天框看到的是同一批 provider/model。
 *
 * 失败时（宿主没挂 llm 服务等）返回 ok:false，调用方回退插件 models 配置。
 */

/**
 * 列出 DSH 全量 provider/model（与 DSH 聊天框同源）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<{ ok: boolean, groups: Array<object>, default?: object, failures?: Array<object> }>}
 */
export async function listDshModels(ctx) {
  const llm = ctx.get('llm')
  if (llm === undefined || llm === null) {
    return { ok: false, error: '宿主没有 llm 服务', groups: [] }
  }
  const providers = llm.listProviders()
  const groups = []
  const failures = []
  for (const provider of providers) {
    try {
      const models = await llm.listModels(provider.id)
      const entries = []
      for (const model of models) {
        let reasoning
        try {
          const resolved = await llm.resolveModelInfo(provider.id, model.id)
          if (resolved?.reasoning !== undefined) {
            reasoning = {
              efforts: (resolved.reasoning.efforts ?? []).map(effort => ({
                id: effort.id,
                name: effort.name,
                ...(effort.description === undefined ? {} : { description: effort.description }),
              })),
              ...(resolved.reasoning.defaultEffort === undefined
                ? {}
                : { defaultEffort: resolved.reasoning.defaultEffort }),
            }
          }
        } catch {
          // 单个模型元数据失败不影响整个 provider
        }
        entries.push({
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(model.badge === undefined ? {} : { badge: model.badge }),
        })
      }
      if (entries.length > 0) {
        groups.push({ id: provider.id, name: provider.name, models: entries })
      }
    } catch (error) {
      failures.push({
        id: provider.id,
        name: provider.name,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  let fallback
  try {
    fallback = ctx.agentDefaultModel?.currentSelection?.()
  } catch {
    fallback = undefined
  }
  return {
    ok: true,
    groups,
    ...(fallback === undefined ? {} : { default: { ...fallback } }),
    ...(failures.length === 0 ? {} : { failures }),
  }
}
