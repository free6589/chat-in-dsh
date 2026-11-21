<div align="center">
  <img src="icon.svg" width="88" alt="chat-in-dsh 图标" />
  <h1>chat-in-dsh</h1>
  <p><strong>在 DeepSeek Harness（DSH）里，用原汁原味的网页版对话。</strong></p>
  <p>
    <a href="https://www.npmjs.com/package/chat-in-dsh"><img alt="npm" src="https://img.shields.io/npm/v/chat-in-dsh?style=flat-square" /></a>
    <a href="https://github.com/YinkaiYu/chat-in-dsh/actions/workflows/test.yml"><img alt="Test" src="https://img.shields.io/github/actions/workflow/status/YinkaiYu/chat-in-dsh/test.yml?style=flat-square" /></a>
    <a href="https://github.com/YinkaiYu/chat-in-dsh/releases"><img alt="Release" src="https://img.shields.io/github/v/release/YinkaiYu/chat-in-dsh?style=flat-square" /></a>
    <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/YinkaiYu/chat-in-dsh?style=flat-square" /></a>
    <img alt="基于官方 chat-demo" src="https://img.shields.io/badge/%E5%9F%BA%E4%BA%8E-%E5%AE%98%E6%96%B9%20chat--demo-2F6FEB?style=flat-square" />
    <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="powered by dsh" src="https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white" /></a>
    <a href="https://www.dsh.so/artifact/chat-in-dsh/"><img alt="dsh.so" src="https://cdn.dsh.so/badge/chat-in-dsh.svg" /></a>
  </p>
</div>

<p align="center"><a href="README.en.md">English</a> · 简体中文</p>

## 为什么需要它

2026 年 11 月 16 日，DeepSeek App 和网页端开始限额，不少用户因此转到 DeepSeek Harness。这部分用户需要的是聊天、写作、问答，而 DSH 默认是给开发者准备的形态：每次对话内置了几千字的系统提示词和工具注入，于是，模型变成了一个「老实」的打工人，却失去了原本网页版对话的那种「灵气」。写作和聊天时，这个差别尤为明显。

本插件在 DSH 里加一个独立面板，面板里就是原汁原味的 DeepSeek 网页版本身：官方极简系统提示词、官方的服务端工具、官方界面。在这小小的一方天地，只有 DeepSeek，没有 Harness，它不再被工具束缚，也不再有限额（通过API计费），它与你之间不再有可悲的厚障壁。

## 你能得到什么

- **原汁原味**：界面就是 DeepSeek 官方开源的那份前端，交互、排版、动效都按官网复刻
- **不用填 API Key**：直接用 DSH 里已经登录的 DeepSeek 账户
- **不受官网限额影响**：请求走 API
- **能力齐全**：智能搜索、深度思考、引用角标、公式、图表、深色模式
- **独立面板**：有自己的会话列表，和 DSH 的会话分开管理、互不同步

<img src="docs/assets/webview-reply.png" width="760" alt="对话与思考过程">

## 安装

**1. 打开左侧的「插件」页**

<img src="docs/assets/dsh-1.png" width="760" alt="打开插件页">

**2. 点右上角的「添加插件」**

<img src="docs/assets/dsh-2.png" width="760" alt="点添加插件">

**3. 填包名 `chat-in-dsh`（或粘贴仓库地址），点「安装」**

<img src="docs/assets/dsh-3.png" width="760" alt="填写包名并安装">

**4. 装好后点「立即启用」**

<img src="docs/assets/dsh-4.png" width="760" alt="点立即启用">

之后左侧面板列表里会多出「网页版」。

## 使用

点左侧面板列表里的「网页版」：

<img src="docs/assets/dsh-5.png" width="760" alt="点网页版打开面板">

如果想专心聊天，点左上角这个按钮把 DSH 的会话栏收起来：

<img src="docs/assets/dsh-6.png" width="760" alt="收起 DSH 会话栏">

收起之后就是完整的网页版界面：

<img src="docs/assets/dsh-7.png" width="760" alt="网页版面板">

面板里有自己的会话列表，和 DSH 的会话分开管理。

## 换用其他模型（可选）

默认什么都不用配：面板顶部选择条直接列出 **DSH 聊天框同一份模型目录**（provider 分组，
与 DSH 同源同顺序），选中经 DSH 的 provider 发请求，不需要你再配一遍。

如果 DSH 宿主侧没有模型目录（或你想固定几个入口），才需要在插件配置里给一份
`models` 兜底目录（省略时仍是官方单项）：

```yaml
- id: chat-in-dsh
  name: chat-in-dsh
  config:
    models:
      - id: deepseek-flash          # 面板里显示的模型名
        label: DeepSeek 网页版
        api: anthropic              # Anthropic Messages 协议，直通
        baseURL: https://api.deepseek.com/anthropic
      - id: glm-5.3-flash
        label: GLM 5.3 Flash
        api: openai                 # OpenAI Chat Completions 协议，由宿主翻译
        baseURL: http://127.0.0.1:18088/openai/v1
        apiKeyEnv: BIFROST_VIRTUAL_KEY
        upstreamModel: agent2api/glm-5.3-flash
    defaultModel: deepseek-flash
```

配好之后：

- 面板顶部是模型选择条。点开先看到搜索框和按 provider 分组的模型列表，输入关键词按模型名、模型 id、provider 名过滤；
- 有推理档位的模型行尾有一个「›」，点进去选 effort（档位来自 DSH 目录里该模型的 `reasoning.efforts`）。选完菜单收起，选择条上会显示 `effort: high` 这样的当前档位；
- 选择（模型 + effort）一起落在 `$DSH_HOME/chat-in-dsh/model-state.json`，删掉这个文件就回到 `defaultModel`；`/webchat/settings` 是同一个选择的完整设置页；
- 脚本里用 `GET /webchat/api/models` 看目录、当前模型与 `activeEffort`，`POST /webchat/api/models {"id":"...","effort":"high"}` 一起切。只传 `id` 时不带 effort，上一个档位不会跟着搬过去。

两种协议都支持：`api: anthropic` 的目录项按原样直通（只把请求体里的模型名换成选中的），
`api: openai` 的目录项由宿主把请求翻成 `chat.completions`、再把分块流翻回 Anthropic 事件
（思考内容翻成 thinking 块），所以网页版界面不用改。Key 只从 DSH 凭据或 `apiKeyEnv` 指向的
环境变量里取，浏览器始终不持有它。附件上传仍走官方 Files API，因此换到非官方模型时附件不可用。

effort 的走法：`api: openai` 的目录项把请求体顶层的 `effort`（也认 `thinking.effort`）翻成
`reasoning_effort`；走 DSH 目录的条目透传成 `prepareCall` 的 `reasoningEffort`。没选 effort 时
请求体与 1.4.0 逐字节一致。

### 验证证据

`docs/evidence/` 下是最近一次真上游验证的原始输出：

- [`live-e2e.json`](docs/evidence/live-e2e.json)：插件上游指向进程内的记录型反向代理，代理原样转发到本机
  bifrost 网关。记录里能看到 `reasoning_effort: "high"` 确实发到了上游、不选 effort 时这个字段不出现、
  切到另一家 provider 的模型后上游按新 model 作答。
- [`profile-e2e.json`](docs/evidence/profile-e2e.json)：跑在真实 `dsh web` 实例上，目录来自 profile
  （3 个 provider 分组），跨组切换、effort 落盘与带 effort 的真上游对话都在里面。
- [`ui-e2e.json`](docs/evidence/ui-e2e.json)：真实 Chromium 点开两级菜单、按关键词过滤、选 effort，
  再在面板里发一句话等真实回答；截图见 `settings.png`、`model-menu.png`、`panel-chat.png`。

## 把对话搬进来

**从 DeepSeek 官网搬**

1. 打开 chat.deepseek.com，点「设置 → 数据管理 → 导出所有历史对话」，下载生成的 ZIP（文件名形如 `deepseek_data-2026xxxx.zip`）。
2. 在面板左下角点「设置」→「数据管理」→「导入历史对话」，选中这个 ZIP。

这个入口会覆盖面板里现有的全部对话，建议先把要导入的导完，再开始新的对话。

**从 DSH 搬**

在左侧会话列表里右键任意一条 →「导入到网页版」，那份对话会复制一份进来，之后两边各自独立。

## 关于可靠性

这个插件基于 DeepSeek 官方开源的 [chat-demo](https://github.com/deepseek-ai/chat-demo) 开发。请求发往哪里、左上角的标识、藏起 API Key 输入框是为接入 DSH 所做的改动；其余界面与交互按官网逐项复刻。

官方 chat-demo 只是网页版的骨架：界面在，但网页版里不少已有的交互它没有做。我们在它之上把这些补齐，让它更接近 chat.deepseek.com 本身：

- 会话搜索：按标题、正文、思考过程和附件名检索；命中标题单独成行，消息命中带分支序号
- 右侧轮次进度条：每条提问一根刻度，悬停展开预览，点击跳到对应轮次
- 会话置顶与多选批量管理：置顶、取消置顶、删除，和网页版一致的入口与确认框
- 长文本粘贴转附件：超过 2000 字的纯文本转成附件卡片，可一键还原、支持撤销/重做
- 语音输入与朗读：网页版的录音、转写和朗读路径
- 长回答阅读：代码块工具栏吸顶、回到最新按钮、Mermaid 图表缩放
- 深色模式、公式、图表等界面细节按官网样式对齐

没有二次包装，也没有替你「优化」提示词——模型拿到的就是网页上那一份。
