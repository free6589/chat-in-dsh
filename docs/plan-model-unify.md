# Plan：面板模型选择与 DSH 聊天框统一 + “服务器暂时不可用”修复

> 用户原话：面板 UI 要和 DSH 聊天框一样，模型列表也要和 DSH 的一样，而不是自建列表。
> 测试反馈：“服务器暂时不可用”。

## 一、根因（已定位）

“服务器暂时不可用”是前端对上游 5xx / 宿主 502 的统一文案
（`completionServerErrorHint` ← `describe.ts` 的 `serverBusy` 分支）。

用户当时选的是 `bifrost-responses/opencode-go/muse-spark-1.3-contributor`，
走了面板新链路 `proxyDshDispatch → ctx.llm.prepareCall`，连续踩了三个 bug：

| # | 现象 | 根因 | 状态 |
|---|------|------|------|
| 1 | 自检 `messages: false`，`cannot get property "llm" without inject` | `index.js` 的 `inject` 缺 `llm` | ✅ 已修（d68f188），已重载 |
| 2 | `signal?.throwIfAborted is not a function` | 自检传 `AbortSignal.timeout()`，adapter 内 signal 链不兼容 | ✅ 已修（0866cc0，改 `AbortController + setTimeout`），已重载 |
| 3 | `select()` 选不进 DSH 项 | 查的是合并前的 `catalog` 而非 `merged` | ✅ 已修（41cb203 含） |

## 二、方案（用户已确认：分两步）

- **第一步（本批次）**：数据源换 DSH 同一份目录（`ctx.llm`），UI 保持下拉条。
  - `src/dsh-models.js`：`listDshModels(ctx)`，provider 分组 + reasoning 元数据。
  - `src/models.js`：`fromDshEntry` + `mergeDshCatalog`（DSH 在前，插件 models 兜底）。
  - `src/dsh-dispatch.js`：`proxyDshDispatch`（prepareCall + stream → Anthropic SSE）+ `selfTestDshDispatch`。
  - `src/webview.js`：`GET /webchat/api/dsh-models`；请求级 `registryFor()` 每次现取合并；`proxyMessages`/`selfTest` 分流 `api:dsh`。
  - `client.js ModelBar`：优先读 DSH 目录（optgroup 分组），失败回退插件目录。
- **第二步（下批次）**：同款两级菜单 UI（provider 分组 + 搜索 + effort 选择），effort 透传 `reasoningEffort`。

## 三、验证状态

- [x] `npm test` 54 项全过（含新增 `test/dsh-models.test.js` 10 项）
- [x] 真上游 e2e 全过（GLM 真实回答，自检三项 ok）
- [x] signal 修复经桩验证通过
- [x] 真实 profile 自检（隔离实例全自动跑完，`scripts/verify-profile.mjs`）
- [x] 面板点选 + 发一句话（CDP 真实鼠标，ui-e2e 全过）

## 五、本轮验证结论（2026-11-21 隔离实例）

- `scripts/verify-profile.mjs` 一键跑完：PROFILE_E2E_OK + UI_E2E_OK
- 目录：21 项（bifrost/agent2api 全量 + deepseek-flash + glm-5.3-flash），与 DSH 聊天框同源
- 切换落盘：`~/.dsh/chat-in-dsh/model-state.json` → glm-5.3-flash ✅
- 真实对话：GLM 自报身份 ✅；自检四项全绿 ✅
- 面板回答自称 DeepSeek：agent2api 网关侧路由方差（同网关此前也返回过 Kimi/Grok），
  非面板选择失效（保存落盘成功为证）
- 新 signal 修复（AbortController）经隔离实例自检链路验证通过

## 六、上游作者修复（2026-11-21 21:12，ff76a43）

- 上游作者 Yin-Kai Yu 直接推到本分支：`prepareCall` 真实接口是
  `prepareCall(config, signal)`（config 含 provider/model），
  `stream` 用 `{ ...prepared.config, signal }`；signal 不能进 config
  （会被结构化克隆成普通对象）；自检 maxTokens 16→64
- 这才是 `signal?.throwIfAborted is not a function` 的真根因：
  我们之前按 `(provider, model, signal)` 三参调用，adapter 内部错位
- 用 DSH 目录项 `agent2api/glm-5.3-flash` 重跑隔离验证：
  PROFILE_E2E_OK + UI_E2E_OK，自检 messages「收到」，
  真实对话 GLM 自报身份 —— DSH 派发链路彻底通了

## 四、待办

1. 用户贴新自检结果 → 若 `messages.ok=true` 则第一步闭环
2. 第二步 UI（两级菜单 + effort）
3. 提交 → 推分支 → 重载验证 → 打 tag → 发 PR（upstream YinkaiYu/chat-in-dsh）
