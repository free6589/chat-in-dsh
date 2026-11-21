# DSH 原生两款模型菜单行为规格

本文逆向本机 DSH 安装（`@deepseek-ai/dsh`，model-selection 包版本 `0.2.2-rc.3`）原生两款模型菜单的交互与数据行为，供 `chat-in-dsh` 的 `ModelBar` 第二步 UI 对齐。所有行为均标注源码位置；无源码佐证的条目标「待确认」。

**两款菜单：**

| | A：聊天框模型菜单（composer model seat） | B：`/model` popupSelect 弹层 |
|---|---|---|
| 入口 | 输入框工具行的模型 chip（`conversation.input.model` 插槽） | 斜杠命令面板里输入 `/model` |
| 注册处 | `ModelSelect.tsx`（经 `slots.inject('conversation.input.model')`） | `index.ts` 里 `command.register({ name: 'model', ui: { kind: 'popupSelect' } })` |
| 源码根 | `node_modules/@deepseek-ai/dsh-client-ui-model-selection/src/client/` | 同上 `index.ts` + `dsh-client-ui-commands/src/client/` |

下文源码路径省略前缀
`/home/fish/.local/share/mise/installs/node/26.8.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`。

---

## 1. 共享数据层（两款菜单同源，规格基线）

两款菜单渲染同一个 per-session `ModelDirectory` store，提交走同一个 `session.selectModel` RPC。任一入口切换，另一入口下次渲染即同步。

### 1.1 目录结构（Host 生成，一次加载共享）

- Host 端 `catalog.ts` 的 `buildModelCatalog`：遍历 `ctx.llm.listProviders()`，每个 provider 取 `listModels` + `resolveModelInfo`，产出 `{ default, routableProviders, groups, failures }`。单个 provider 加载失败进 `failures`，不拖垮其它组。
- `ModelCatalogModel = { id, name, description?, reasoning?, badge? }`；`ModelReasoning = { efforts: [{id, name, description?}], defaultEffort? }`（`dsh-api-session-controller/src/types.ts`）。
- 客户端 `catalog.ts` 的 `ModelCatalogDirectory`：每次 Host generation 只加载一次（共享 in-flight），并缓存 reasoning 元数据（`reasoningFor`，含当前不可用模型的）；Host 侧模型配置变更触发 `refresh()`，重连触发 `resetGeneration()`。

### 1.2 选择状态与持久化（持久化的权威定义）

- `directory.ts` 的 `ModelDirectoryState`：`current`（`ModelSelection = { provider, model, reasoningEffort? }`，即使 provider/model 已从目录消失也保留显示）、`retainedEffort`、`routable`、`groups`、`failures`、`status`、`pending`、`error`。
- 持久化是**会话事件投影**，不是浏览器 localStorage：
  - `dsh-agent/src/model-selection.ts` 的 `modelSelectionProjectionDefinition`：`model/selection` 事件写入 `pending`，`request/header` 事件把匹配的 `pending` 结转为 `lastUsed`；wire 视图暴露 `next = pending ?? lastUsed`。effort 若由 adapter 默认（`adapterDefaults.reasoningEffort === true`）则不记为显式选择，下次仍按默认解析。
  - Host 端 `dsh-api-session-controller/src/commands.ts` 的 `selectModel`：校验 `requireModel` + `resolveCallConfig`（不支持的 effort 在 I/O 前拒绝，`dsh-llm/src/index.ts` 抛 `UNSUPPORTED_REASONING_EFFORT`，不做 clamp/别名），成功后 `agent.model.select()` 写会话事件，并后台 `agentDefaultModel.saveSelection()` 把该选择写为**部署默认**（写 profile 配置，`dsh-agent-default-model/src/index.ts`；保存失败只 warn，不影响会话内已生效的选择）。未配置过的会话取 `catalog.default`。
  - 切换 provider/model 时 Agent 在下一步前插入 `[model changed: ...]` 系统提示（`installModelSelection`）；纯 effort 变化不插入提示。
- 遥测：同路由换 effort 上报 `thinking_level_switch`，换路由上报 `model_switch`（`directory.ts` 的 `select`）。

---

## 2. 菜单 A：聊天框模型菜单（ModelSelect）

源码：`dsh-client-ui-model-selection/src/client/ModelSelect.tsx` + `ModelSelect.module.css`。

### 2.1 触发器（trigger）

- 28px 高的圆角 chip（与同排 Plan / 只读选择器一致），内容：`IconDataOutlineRegular` 图标（CSS 变量 `--dsh-composer-model-icon-display` 控制，composer 放不下时隐藏）+ 模型名 + `·` 分隔的 effort 值 + 下箭头 chevron；最大宽 360px，13px/20px/400 次级标签色，effort 段 caption 色、`flex-shrink: 1000`（空间不足时先牺牲 effort 文本，再截断模型名，chevron 不动）。
- 文案：未选模型显示「请选择模型」，目录加载中显示「正在加载模型…」；aria 为「选择模型，当前 {model}，推理等级 {effort}」。`title` 属性带完整「模型 · effort」标签。
- 悬停显 hover 背景；focus-visible 显 focus ring（选择关闭回填焦点后的一瞬不显 ring，`data-selection-focus` 控制）。
- busy（selection pending）时 chevron 换成 spinner（`StateDot state="ongoing"`），trigger `aria-busy`、`disabled = locked`。

### 2.2 根面板（pane = root）

打开后先显示两行式根面板（`ModelSelect.tsx` L489-513）：

1. **模型行**：`menu.model`（「模型」）+ 当前模型名（可带 badge Tag）+ 右箭头，点击钻入模型列表。
2. **推理等级行**：仅当当前模型带 `reasoning` 元数据时渲染（`reasoning !== undefined` 才出），`menu.effort`（「推理等级」/「Effort」）+ 当前 effort 标签 + 右箭头。
3. **插件选项槽**：`conversation.input.model.options` list slot 追加在两行之后（本文档两款菜单均不依赖它，仅记录存在）。

当前值标签（`effortLabel`）解析顺序：模型无 reasoning → 显示 `retainedEffort`；effort 未设 → 「Default」（`effort.providerDefault`）；否则 efforts 里按 id 找 `name`，找不到回显原始 id。

### 2.3 provider 分组规则

- 分组 = Host 目录的 provider group（`group.id` / `group.name`），组内模型顺序 = 目录顺序，**客户端不重排模型**。
- 组排序：`provider-order.ts` 的 `orderModelProviders`——`deepseek-account`（显示名「DeepSeek 账号」，来自 locale `provider.account`，Host 侧 displayName 也是 `DeepSeek Account`）排第一，`deepseek-official` 第二，其余保持目录相对顺序（稳定 sort，id 三档 0/1/2）。
- 组标题用 `MenuGroup`（sticky 组头，滚到时该组被 scroll pin 才绘制背景：`observeStickyMenuGroups`，`ModelSelect.tsx` L205-209）。
- 加载失败的 provider 不显示组，而是在列表上方出黄色 warning 条「{name} 加载失败：{message}」+ Retry（整列表重载 `reload()`）；已成功组照常可用。整目录失败显示红色 error 条 + Retry。

### 2.4 搜索行为

- **阈值**：`choices.length > 4` 才显示搜索框（`showSearch`，L115）；≤4 个模型时无搜索框，行用 roving focus（Tab 键进入，行间 ArrowUp/Down）。阈值变化时清空 query 与高亮。
- **过滤算法**：`rankByName`（`dsh-client-ui-primitives`，bundle 反编译见附录 A）——
  - 大小写不敏感；在**每个 provider 组内独立**做「有序子序列」匹配（不跨组混排，组序保持）。
  - 打分：`prefix`（模型名以 query 开头）优先 → 对齐分（连续字符奖励 +4，间隔惩罚，gap 越近越好）→ 目录顺序。组内非匹配项被剔除，空组隐藏。
  - 空查询恢复全列表。无结果时列表区显示「没有匹配的模型。」（`search.empty`）；目录本身为空显示「暂无可用模型」（`empty.models`）。
- **搜索框交互**：placeholder「搜索模型…」；query 非空出现 24px 圆形清除按钮（点击清空并回焦搜索框）。搜索框 `readOnly = busy`。
- **键盘**：搜索框持焦，↑/↓ 在结果间循环移动高亮（`aria-activedescendant` 指向高亮行）；Enter 与 Tab 接受高亮项；Esc/Shift+Tab 先退出钻入面板，再关闭菜单；高亮行自动 `scrollIntoView({block:'nearest'})`；mousemove 也更新高亮（搜索模式下）。移动端：搜索框只在用户显式输入后才拿焦点。

### 2.5 effort 面板（pane = effort）

- 行清单（L138-149）：若该模型 `reasoning.defaultEffort === undefined`，**最顶加一行「Default」（provider 默认，`effort: undefined`）**；随后按目录 `efforts` 数组顺序列出各档（`{id, name}`；DeepSeek 官方适配器顺序为 Off → Low → High → Max，`dsh-llm-deepseek/src/model-info.ts`；`thinking: 'disabled'` 连接只有 Off 一档且默认 Off）。
- 选中判定 `aria-checked`：`effectiveEffort === level.effort`，其中 `effectiveEffort = current.reasoningEffort ?? defaultEffort`——即「Default」行只在既无显式选择又无 adapter 默认时勾选。
- 行右侧：pending 中该 effort 显示 spinner，否则当前项 ✓。
- 选择：`chooseEffort(effort)` 组装 `{provider, model, reasoningEffort?}` 提交（选 Default 提交时不带 effort 字段）；与当前值相同则仅关闭。
- 空档位显示「当前模型未提供推理等级。」（`empty.efforts`；理论上因根面板 gating 不可达，属于防御渲染）。

### 2.6 选择提交与 pending 表现

- `submit` → `directory.select()` 单飞（`pending` 占位）；期间所有 option 行 `disabled`、trigger 显示 spinner、trigger 拿焦点避免行焦点残留。
- pending 中，**值匹配 pending 选择的每一行**（模型行与 effort 行各自）把 ✓ 换成 spinner（L601-605 / L644-649）。
- 成功：关菜单、焦点回 trigger（无 ring）；失败：**菜单内不显示错误条**，改用锚定 composer 卡片的瞬时 Toast（`session/writer-held` 显示专门的会话占用文案）。
- 点同一当前项：仅关闭，不发请求。

### 2.7 键盘状态机（摘要）

- 打开：trigger Enter/Space；打开时若目录里无当前模型直接落在 model 面板（`show()`），否则 root。
- root：↑/↓/Tab 在两行（及插件行）间移动；Enter/点击钻入；返回（Esc/Shift+Tab）把焦点交还来源 cell。
- model：有搜索时搜索框持焦、↑/↓ 移高亮、Enter/Tab 接受；无搜索时行 roving focus。
- effort：行 roving focus，Enter/点击选择。
- Esc：先回 root，再关菜单并回焦 trigger；焦点离开整个卡片（onBlur relatedTarget 出界）也关闭。
- 状态机（pane 层）：`root ⇄ model`、`root ⇄ effort`（`reasoning === undefined` 时无 effort 行即不可达），`model/effort → 关闭`。搜索模式切换（模型数跨过 4 的阈值）会强制 model 面板 focus 落到搜索框（`changedSearchMode` intent）。

### 2.8 线框（菜单 A）

```
┌──────────────────────────────────────────┐
│ [◫] deepseek-chat · High        ▾        │  ← trigger chip 28px，360px max
└──────────────────────────────────────────┘
        ▲ portal 到 body，CSS anchor 定位在 trigger 上方
┌─ MenuSurface（min 240 / max 420 宽，max-height 360px，padding 4）─┐
│  模型        deepseek-chat · High           › │ ← root 两行（34px 高 .cell）
│  推理等级    High                             › │ ← 仅当前模型有 reasoning 时
│  ┄┄┄ 插件槽 conversation.input.model.options ┄┄┄│
└──────────────────────────────────────────────────┘
        │ 钻入模型                    │ 钻入 effort
┌─ model pane ────────────────────────────┐  ┌─ effort pane ──────────┐
│ [搜索模型…                        ✕]    │  │ ○ Default              │ ← defaultEffort 未设才有
│ ▼ DeepSeek 账号          ← sticky 组头  │  │ ○ Off                  │
│   deepseek-chat                ✓        │  │ ● Low                  │
│   deepseek-reasoner            ◌        │  │ ○ High                 │
│ ▼ bifrost                               │  │ ○ Max                  │
│   agnes-image-2.5-flash                 │  └────────────────────────┘
│   …                                     │
│ ⚠ {provider} 加载失败：…        [Retry] │
└─────────────────────────────────────────┘
```

---

## 3. 菜单 B：`/model` popupSelect 弹层

源码：`dsh-client-ui-model-selection/src/client/index.ts`（注册）+ `dsh-client-ui-commands/src/client/popup.ts`（控制器）、`PopupSelectView.tsx/.module.css`（外壳）。

### 3.1 打开与定位

- 斜杠面板 `/model` 候选行（label「模型」，icon 数据图标，`available: 非被寻址 subagent 会话`）或直接键入 `/model` + Enter 打开。外壳自注册进 `conversation.input.overlay`。
- 卡片绝对定位在 composer 卡上方（`bottom: calc(100% + 4px)`，左右贴 overlay anchor），宽随 composer（min 220px，max 100%），高 cap 320px 且运行时 clamp 到 composer 上方剩余空间（`useAnchoredMaxHeight`）。
- 打开即 fetch 一次 options（`PopupSelectController.open`）；重新打开会 abort 上一次的 fetch 并作废旧 settlement。桌面端打开自动聚焦搜索输入框；移动端需要显式操作。

### 3.2 行数据（扁平 + 分组信息）

- `optionsOf`（index.ts）：把目录拍平成行 `id = "{providerId}/{modelId}"`，`label = model.name`，`group = { name: group.id, label: 组显示名 }`；当前值行 `active: true`。
- 组顺序同 A：`orderModelProviders` 先 account、official，其余按目录序；`groupOptions`（option-groups.ts）按组名**首现顺序**分块，不排序不合并乱序。
- 加载失败的 provider **不生成可选行**，而是追加一行 `id = "failure/{id}"`、`label = 组名`、`detail = "目录加载失败：{message}"`——仅可见、不可选（`selectionOf` 返回 undefined，选择时抛「该 provider 目录加载失败」）。

### 3.3 搜索行为

- `searchMode: 'fuzzy-label'`；外壳搜索输入框常显（无阈值——与 A 不同，A 是 >4 才显示）。
- 过滤：空查询显示全部（组序保持）；非空时在**每个组内**用 `rankByName` 对 label 排序（同 2.4 打分：前缀 → 对齐分 → 目录序），组内不匹配项剔除、组保留原序。组结构在过滤时保留。
- 高亮：加载完成时落在 `active` 行（当前使用中的值，防止盲按 Enter 改配置）；每次输入 `setSearch` 把高亮重置到过滤结果顶部（active=0）。
- 空态区分：目录空「暂无可用模型」，过滤无结果「没有匹配的模型。」。

### 3.4 键盘与关闭

- ↑/↓ 循环移动高亮（`move`，过滤行内 wrap），自动滚 `aria-selected` 行进视口；Enter/Tab 接受高亮（Tab 在非 ready 或空结果时放行给浏览器，保证 Retry 按钮可达）；←/→ 不拦截（搜索框光标）；Esc/Shift+Tab 关闭并回焦 composer。
- 点击卡片外任意处（pointerdown capture）关闭；点击目标自然接管焦点。
- 无 effort 面板——这是与 A 的最大行为差异：popupSelect 只提交路由，effort 在选择同路由时保留（`selectionOf` 对当前路由沿用 `current.reasoningEffort ?? defaultEffort`，换路由则取新模型 `defaultEffort`）。

### 3.5 提交、失败与确认

- 单飞 `submitting`：期间 select/search/highlight 全部 no-op，显示「正在应用…」。
- 成功：consume 打开时的 token 段、关闭、composer 回焦。失败：外壳保持打开，error 条显示错误信息，搜索文本/高亮/未消费 token 全保留，select 重新武装（相当于重试入口）。
- options 加载失败：`status: 'failed'`，error 条 + Retry 按钮（沿用同一 binding 重拉）。options 一次打开只拉一次，不随键入重查。
- 该外壳支持可选的 risk confirmation（checkbox 门），`/model` 未使用。

### 3.6 线框（菜单 B）

```
┌─ composer 输入框 ────────────────────────────┐
│ /model█                                      │
└──────────────────────────────────────────────┘
┌─ popupSelect 卡（贴 composer 宽，max-h 320）──┐ ← bottom: composer 顶 + 4px
│ [搜索…                          ]            │ ← 常显
│ ▼ DeepSeek 账号                              │
│   deepseek-chat                     ✓  ← active
│ ▼ bifrost                                    │
│   agent2api/glm-5.3-flash                    │
│   agnes-image-2.5-flash                      │
│ ⚠ agnes-cn  目录加载失败：…（不可选，灰色行） │
└──────────────────────────────────────────────┘
```

---

## 4. 两款差异速查表

| 维度 | A：composer seat | B：/model popup |
|---|---|---|
| 层级 | 两级（root 两行 → model / effort 钻入） | 单层扁平列表（无 effort 面板） |
| 搜索框 | 目录 >4 项才显示 | 常显 |
| 搜索范围 | 组内 `rankByName`（model.name） | 组内 `rankByName`（label） |
| 高亮初值 | 当前可见项（无则首行） | `active` 行（当前值） |
| effort | 独立面板，显式提交 | 随路由隐式保留/取默认 |
| 失败呈现 | 目录错误条 + Retry（加载）；选择失败走 Toast | 同一 error 条 + Retry；提交失败保留现场 |
| pending 视觉 | trigger 与匹配行换 spinner | 「正在应用…」状态行 |
| 分组顺序 | account → official → 其余（同） | 同 |
| 持久化 | `session.selectModel` → 会话事件投影 + 后台写部署默认 | 同（同一 directory.select） |

---

## 5. ModelBar 现状对照（第一步实现 vs 本规格）

`client.js` 的 ModelBar（L104 起）已实现：DSH 目录读取（`/webchat/api/dsh-models`）、provider 分组渲染、子串搜索（对 model.name/id/group.name，未做 rankByName 打分排序）、effort 二级面板（行内 › 按钮进入）、选择 POST `/webchat/api/models`。

与本规格的差距（第二步 UI 的输入）：

1. 搜索未实现前缀/对齐分排序（规格 2.4），仅 includes 过滤。
2. 无「>4 才显示搜索框」阈值（规格 A 为始终显示；可按 A 或 B 任取，需在 UI 决策中明确）。
3. provider 组排序未实现 account→official 置顶（规格 2.3）。
4. effort 面板无「Default（provider 默认）」行；选中判定未考虑 `defaultEffort`。
5. 目录无 reasoning 的模型行没有根面板 gating 概念（ModelBar 直接在列表行挂 › 按钮，与 A 的两级 root 不同；与 B 的单层结构部分一致）。
6. 失败/加载/pending 状态呈现远简于规格（无 per-provider warning 条、无 pending spinner、无 Toast）。

---

## 附录 A：rankByName 反编译（证据）

`dsh-web-frontend/dist/assets/index-Ciz7DZxv.js`（`@deepseek-ai/dsh-client-ui-primitives` 的产物 chunk）中 `rankByName = fB`、对齐打分 `dB`、连续奖励 `E7`：

```js
function dB(e, t) { /* 子序列对齐打分：首字符出现处 1+后缀连续奖励；
  后续字符延续时 +4（连续），断开后 +1 且随 gap 变小加分；返回最大分，不可达为 undefined */ }
function fB(e, t) { // rankByName(items, query)
  const r = t.toLowerCase();
  if (r === "") return e;
  const i = [];
  e.forEach((n, o) => {
    const l = n.label === undefined ? [n.name] : [n.name, n.label];
    let c = false, d;
    for (const f of l) {
      const h = f.toLowerCase(), v = dB(h, r);
      v !== undefined && (c ||= h.startsWith(r), d = d === undefined ? v : Math.max(d, v));
    }
    d !== undefined && i.push({ item: n, index: o, prefix: c, score: d });
  });
  return i.sort((n, o) =>
    Number(o.prefix) - Number(n.prefix) || o.score - n.score || n.index - o.index
  ).map(n => n.item);
}
```

结论：前缀命中 > 对齐分（高者胜，连续段每字符 +4 奖励、gap 有近距奖励）> 目录顺序；`name` 与可选 `label` 都参与，取最大分。

## 附录 B：主要源码位置索引

- ModelSelect 组件：`dsh-client-ui-model-selection/src/client/ModelSelect.tsx`
- 菜单 A CSS（尺寸/吸附/搜索行）：`.../ModelSelect.module.css`
- 共享目录 store：`.../client/directory.ts`；catalog 缓存：`.../client/catalog.ts`
- provider 排序：`.../client/provider-order.ts`；locale 文案：`.../src/client/locales.ts`（zh 为 key 集 truth）
- `/model` 注册：`.../client/index.ts`（optionsOf / selectionOf）
- popupSelect 控制器：`dsh-client-ui-commands/src/client/popup.ts`；外壳：`.../PopupSelectView.tsx` + `.module.css`；分组：`.../option-groups.ts`；契约：`.../contract.ts`
- Host 目录组装：`dsh-api-session-controller/src/catalog.ts`；类型：`.../src/types.ts`；selectModel 命令：`.../src/commands.ts`（L166 起）
- 选择投影：`dsh-agent/src/model-selection.ts`；部署默认落盘：`dsh-agent-default-model/src/index.ts`
- effort 校验与默认解析：`dsh-llm/src/index.ts`（L850-960）；DeepSeek 档位：`dsh-llm-deepseek/src/model-info.ts`；pi-ai 自定义档位 schema：`dsh-llm-pi-ai/src/config.ts`（`reasoningEfforts` dict，off/low/medium/high 常用三档 + off）
- rankByName 产物证据：`dsh-web-frontend/dist/assets/index-Ciz7DZxv.js`

## 附录 C：待确认项

- `E7`（连续后缀奖励）的精确公式：产物里已确认存在并被 `dB` 引用，但语义「每个字符到串尾的步数」是从调用形态推断的，未逐符号还原（附录 A 中 dB 的中文注释为行为描述，非逐行反编译）。
- 菜单 A 在真实浏览器中的像素级视觉（sticky 组头动画、spinner 尺寸等）未做截图比对；本文全部尺寸取自 CSS 源码，静态可信、动态渲染未实测。
- 插件槽 `conversation.input.model.options` 的实际消费方（本机安装中未发现贡献者）不影响两款菜单核心行为。
