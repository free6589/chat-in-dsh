# AGENTS.md — 面向开发 Agent

这个文件写给在本仓库里干活的 Agent 和开发者。人类读者请看 [README.md](README.md)。

## 这个仓库是什么

一个 DeepSeek Harness 插件：在左侧面板托管 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 的构建产物，并用 DSH 的账户凭据替浏览器转发请求。

## 结构

| 块 | 文件 | 作用 |
|---|---|---|
| 宿主 | `index.js` | 注册 `/webchat` 前缀路由（**必须用 `handler`，`resource` 只接 GET/HEAD**） |
| 路由 | `src/webview.js` | 静态产物、`/webchat/api/*` 自检与导入接口、Messages / Files 转发 |
| 约定 | `src/protocol.js` | 端点根、令牌头、路径越界判断（纯函数，有测试） |
| 导入 | `src/dsh-import.js` | 只读解析 DSH 会话日志 → chat-demo 格式；暂存与确认（纯函数，有测试） |
| 模型目录 | `src/models.js` | 插件配置里的模型目录、当前选择与状态文件 + DSH 目录合并（`fromDshEntry`/`mergeDshCatalog`）；搜索过滤 `filterModels`、推理档位 `activeEffortOf`（纯逻辑，有测试） |
| 模型搜索 | `src/model-search.js` | 关键字过滤的一套纯函数：有序子序列匹配、前缀优先排序、命中下标（给 `<mark>` 高亮）、分组标题命中整组保留。设置页按 ESM 加载同一份源码，面板菜单是 `client.js` 里的同源副本（有测试盯着两边一致） |
| DSH 目录 | `src/dsh-models.js` | 经 `ctx.llm` 取 DSH 同一份目录（与 DSH 聊天框同源；无 llm 服务时回退插件目录） |
| DSH 派发 | `src/dsh-dispatch.js` | 网页版请求 → DSH `prepareCall` + `stream`，块流翻回 Anthropic SSE（`provider/model` 选择） |
| 协议桥 | `src/openai-bridge.js` | Anthropic 请求 → `chat.completions`，分块流翻回 Anthropic SSE（纯函数，有测试） |
| 界面 | `client.js` | 左侧面板两个槽位（`main` + `sidebar.panellist`）、面板顶部模型菜单（`ModelBar`：第一级搜索框 + provider 分组列表，第二级 effort 档位）与会话右键菜单贡献（`contextMenus`） |
| 前端 | `webview/dist` | 官方 chat-demo 构建产物，随仓库分发 |

上游基准：`8ad7b56e196b87d8a3215dc09476d6d146ad3f0e`（chat-demo v0.1.3，MIT）。补丁在
`webview/patches/0001-dsh-integration.patch`：请求落点、品牌字标、隐藏 API Key 输入、启动时取走导入、
会话搜索（侧栏与收起态都有入口，按标题与正文/思考检索，标题命中单独成行，见 `src/components/sider/SessionSearch.tsx`）、
右侧轮次进度条（每条提问一根刻度，悬停预览、点击跳转，见 `src/components/messages/TurnRail.tsx`）、
会话置顶（`Session.pinned`，列表顶部单独分组；菜单入口见 `src/components/sider/SessionItem.tsx`）。

改前端要跑 `pwsh scripts/build-webview.ps1`：它会先 fetch 上游、`reset --hard`、`clean -fd`、再 `git apply` 补丁，
所以**不要在 vendor 里直接留改动**——改完先 `git add -A` 生成新补丁，再跑构建，否则改动会被重置掉。

## 命令

```bash
node --test test/protocol.test.js test/dsh-import.test.js test/webview-auth.test.js \
  test/models.test.js test/openai-bridge.test.js test/webview-models.test.js test/dsh-models.test.js \
  test/model-search.test.js test/settings-search.test.js test/client-model-menu.test.js
node test/live-e2e.mjs             # 真上游端到端：需要 BIFROST_VIRTUAL_KEY（做法见下），覆盖 effort 与模型切换
node test/profile-e2e.mjs          # 真实 profile 验证：跑在运行中的 dsh web 上，需要 DSH_WEB_TOKEN，覆盖分组切换与 effort
node test/ui-e2e.mjs               # 真实浏览器验证：CDP 点两级模型菜单（分组/搜索/effort）再在面板里对话，需要 DSH_WEB_TOKEN
node test/settings-search-e2e.mjs  # 真实浏览器验证：CDP 在设置页搜索框里敲字，验过滤/高亮/空态/选中项，不需要令牌
pwsh scripts/build-webview.ps1     # 克隆上游、打补丁、构建、同步 webview/dist
```

安装：`plugin_manager` 装仓库根目录。宿主代码改动后要 `remove_bundle` 再 `install_bundle` 才重新加载；
只改 `client.js` / `webview/dist` 时刷新页面即可。

## 硬约束

1. **一个入口**：只有左侧面板。不要在面板里加 DSH 的模型路由、不要加 `conversation.view`、不要做会话双向同步——这是产品决定，不是待办。
   例外是「面板自己用哪个上游模型」：见下面「模型目录」一节，那是宿主转发层的选择，与 DSH 的模型路由无关。
2. **网页版独立存储**：用上游自带的本地存储；只有「导入」这一次性复制会从 DSH 读数据。
3. **不发明提示词**：浏览器构造请求体，宿主只转发。
4. **密钥不出宿主**：浏览器不持有 API Key；`BOOTSTRAP` 注入的只是让上游放行的占位值。
5. **许可证合规**：`webview/dist/LICENSE` 是上游 MIT 原文，不要删。

## 验证

- `GET /webchat/api/self-test`：入口页、静态资源、当前模型、一次真实生成，四项全绿（第三项 detail 里带选中模型）。
- 模型目录：没配 `models` 时 `/webchat/models` 必须还是 `deepseek-flash` 单项，请求体原样转发（`test/webview-models.test.js` 里
  有「默认目录不改写模型名」一条盯着）。配了目录后：`/webchat/settings` 能选、`/webchat/api/models` 能切、状态文件落在
  `$DSH_HOME/chat-in-dsh/model-state.json`；`api: openai` 的目录项走 `src/openai-bridge.js`，思考内容要变成 thinking 块。
- 真上游端到端：`node test/live-e2e.mjs --model agent2api/glm-5.3-flash --model2 runanywhere/glm-5.3-flash \
  --base http://127.0.0.1:18088/openai/v1 --out docs/evidence/live-e2e.json`，
  它会用 profile 里的 `BIFROST_VIRTUAL_KEY`（环境变量或 `~/.dsh/bifrost.env`）起一个临时端口，验证列表/切换/真实回答/自检/设置页，
  并把插件上游指到一个进程内的记录型反向代理——代理原样转发到 `--base`，只额外记下请求体，所以
  「`reasoning_effort` 真的发到了上游」「不选 effort 时没有这个字段」「切到另一家 provider 后上游按新 model 作答」
  都是真网关给的证据。没有真 Key 时不要用打桩结果冒充验证。
- 分组与 effort（真实 profile）：`node scripts/verify-profile.mjs --model glm-5.3-flash` 复制 `~/.dsh/profiles/web`
  起一个隔离实例（3199），自动跑 profile-e2e 与 ui-e2e，证据写到 `docs/evidence/profile-e2e.json`、
  `docs/evidence/ui-e2e.json`（截图 `settings.png`、`model-menu.png`、`panel-chat.png`）。
  profile-e2e 里除了原有的目录/切换/对话/自检，还验：目录带 `provider`/`providerName` 分组字段（真 DSH 目录 ≥2 组）、
  跨 provider 组切换后真上游仍作答、`POST /webchat/api/models {id,effort}` 的 `activeEffort` 与状态文件一致、
  带 effort 的对话 HTTP 200、只传 `id` 时档位不残留。
- 分级菜单（真实浏览器）：ui-e2e 用真实鼠标点开 `button[aria-label="网页版使用哪个模型"]`，检查菜单里出现
  `dsh-models` 的真实分组名，输入 `glm` 后列表只剩命中的模型行，点行尾 `为 … 选择 effort`（按钮宽度是 100%，
  要点右端）进档位列表，点 `high` 后由 `/webchat/api/models` 回读 `activeEffort`，再在面板 iframe 里发一句话等回答。
- 搜索过滤：规则在 `src/model-search.js`（`test/model-search.test.js`）——名字优先于 provider、大小写不敏感的有序
  子序列、前缀与紧凑命中排前，空查询原样返回。设置页 `/webchat/settings` 顶部搜索框与面板菜单用同一套规则：
  即时过滤、命中处 `<mark>` 高亮、无命中显示「没有匹配的模型。」、目录为空显示「暂无可用模型。」；
  过滤只切 `hidden`、不重建行，所以选中项（含被隐藏的当前模型）不会被弄丢，保存仍提交选中项。
  面板菜单里标题（provider）命中时整组保留并高亮标题，否则只留命中的模型、空组标题消失（与 DSH 一致），
  搜索框里 ↑/↓ 移高亮、回车选中、Esc 清空，全部在组件内完成，不发请求。
  设置页的浏览器验证是 `test/settings-search-e2e.mjs`，菜单的渲染级验证是 `test/client-model-menu.test.js`
  （最小 React 运行时把 `client.js` 真渲染出来，并和 `src/model-search.js` 逐条比对）。
- 槽位：`main` / `sidebar.panellist` 有 `chat-demo`；会话菜单走 `contextMenus` 贡献，所以旧插槽 `sidebar.workspaces.session.menu.item` 应当是空的；`conversation.view` 里**不应**出现。
- 菜单样式：会话右键菜单里的「导入到网页版」必须和置顶、重命名等原生条目等高同字号——新加菜单项一律用 `ctx.contextMenus.register`，不要往旧插槽塞自定义按钮。
- 导入：右键任意会话 →「导入到网页版」→ `GET /webchat/api/import/pending` 返回该会话 → 网页版启动时写入并 `ack`。
  每次主动导入带 `importId`，宿主重送沿用；确认按 `importId` 精确匹配，旧/无标识确认不会删掉新暂存。
  已处理的 `importId` 另存到独立 IndexedDB `chat-demo-import-receipts` 回执（不升级 chat-demo 主库）；
  回执分 pending/done，先记 pending、会话保存成功后才 done，因此中断后 pending+本地无会话会重试，
  done 后删除会话也不会被旧快照复活。已有本地会话时只有
  本地消息序列是快照前缀才更新：同一回答的思考/正文块只允许末尾续写，新轮次追加尾部并接好选中链；
  本地续聊/分支/删除/改正文一律保留，标题与置顶始终保留本地；
  ZIP 导入/导出/清空与待导入共用 Web Locks 串行，避免两个同源面板同时提交暂存把正式记录清空。
- 本地保存：连接被系统关闭时先自动重开并补存一次；手动「重试」也会先丢弃失效句柄，不再复用已关闭的连接。
  未打开会话的重命名失败会登记到待重试队列，点「重试」可补存并清除错误。
- 置顶：会话「…」菜单 →置顶 → 列表顶部出现「置顶」分组；菜单变「取消置顶」；刷新后仍保持。
  导出 ZIP 后 `chat_sessions/*.json` 与 `chat_session_index.json` 的 `pinned` 都必须为 true，导入回来仍置顶。
- 搜索：命中旧分支的消息时，点击会先切回该分支再滚到消息（`[data-message-id]` 存在）；标题命中单独成行，关键词多处命中都要加粗。
- 轮次导航：长对话里当前项若在导航窗口外，只滚动导航自身；只有真溢出的那侧才显示渐隐遮罩。
  几何对齐官网 scrollNav：右侧 16px、34px 毛玻璃胶囊，悬停时内部 fit-content 容器展开（最宽 240px），
  短标题右对齐、长标题右侧截断。
- 思考标题吸顶：长思考滚动到中段时，标题停在滚动容器顶部（top 与滚动容器一致）、背景不透明、
  点击可收起；滚过思考区进入回答后标题随区块离开。宽窄两种布局各验一次。
- 凭据：`resolveUpstreamAuth` 先取 `deepseekAccount.resolveToken`（账户登录，头 `x-dsh-auth-token`）；
  没有账户登录时读 DSH 模型设置里的 `apiKeyEnv`（默认 `DEEPSEEK_API_KEY`，经 `credentials.resolve` 或环境变量），
  用 `x-api-key` 发往官方 Messages/Files。两条路由都要覆盖，401 表示两者都没有。
- 大附件/长文本：请求里的 `safety_check` / `tools` / `title` 任一存在都会进入扩展模式，单次输入上限 32k tokens；
  命中 400 `user input too long ... max 32768` 时前端去掉扩展字段用普通模式重发。降级成功后单独补一次标题：
  提问（≤1000 字符）+ 文件名 + 粘贴原文截断（≤3000）+ 主回复摘要（≤1000），标题落盘；普通短消息不降级。
- 附件上限：按官方网页版，PDF/Word/PPT 100MB、图片 64MB、文本/表格/电子书 32MB；草稿与单个对话累计
  最多 20 个附件，超出显示官方文案；切分支后发送前还会按发送当时的可见分支再校验一次。
- 附件上传：仅官方端点（hostname `api.deepseek.com`）把 `/webchat/anthropic/v1/files` 的 POST/DELETE
  转发到 Files API 根路径 `/files`（Anthropic 兼容路径网关对 64MiB 以上请求返回 413）；自定义兼容网关
  保留 `/anthropic/v1/files` 原路径。请求体流式转发，实测 93MB PDF 上传成功；图片也带 `purpose=user_data`
  （仍先预缩放），否则官方根路径会拒绝。
- 8MiB 文档文字：上传阶段文本文件超限显示「文件内容过长」；发送阶段
  `Documents are too large ... exceeds 8 MiB` 用消息级 hint「文件内容过长」。
- 语音：`POST /webchat/v1/tools/tts` 返回 `audio/pcm`（24kHz/16bit/单声道），`/asr` 返回 `{text,duration_ms}`；
  两条都必须经宿主转发，浏览器不带凭据。
  麦克风：DSH 桌面只给主框架授权（`lib/main.js` 的 `installMicrophonePermissions` 检查 `isMainFrame`），
  iframe 直接调用会被拒绝。`client.js` 在主框架挂 `window.__dshPanelMic`，面板 `recorder.ts` 优先通过同源 
  `window.top` 取流，取不到才回退自身 getUserMedia。
- 工具栏/思考标题/菜单（按官网实测 JSON 对齐）：输入框 776×124、工具栏高 58、开关 92×34（padding 10、行高 24）、
  发送 34 圆形；思考标题 752×34、sticky top 0/z 7、片段间距 4；会话菜单 4 项 124×168、行高 40；
  确认框宽 380（置顶高 136、批量删除高约 180），按钮 72×36，主按钮品牌蓝。
- 头像：DSH 壳层账号头像由 client.js 按位置找到后写入 localStorage（dsh:user-avatar），
  搜索结果用户行读它显示 40px 圆头像；取不到时回退人物图标。
- 多选：顶栏「多选」图标进入；选择模式顶栏换成「选择对话 / 已选择 N 项」+ 圆形关闭按钮；
  行前复选框不切换当前会话；底部 62px 操作条提供置顶/取消置顶与删除，均先弹确认框；
  置顶与删除只影响选中项，刷新后状态正确。
- 长回答阅读：长代码块滚动到中段时工具栏（`.md-code-block-banner`）吸顶在滚动容器顶部；
  上翻超过 52px 出现「回到最新」圆形按钮，点击到达回答末尾并恢复跟随、按钮消失；
  Mermaid 图表有放大/缩小/还原按钮，缩放只影响该图且容器可滚动查看边缘。

