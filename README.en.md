<div align="center">
  <img src="icon.svg" width="88" alt="chat-in-dsh icon" />
  <h1>chat-in-dsh</h1>
  <p><strong>The authentic DeepSeek web chat, inside DeepSeek Harness (DSH).</strong></p>
  <p>
    <a href="https://www.npmjs.com/package/chat-in-dsh"><img alt="npm" src="https://img.shields.io/npm/v/chat-in-dsh?style=flat-square" /></a>
    <a href="https://github.com/YinkaiYu/chat-in-dsh/actions/workflows/test.yml"><img alt="Test" src="https://img.shields.io/github/actions/workflow/status/YinkaiYu/chat-in-dsh/test.yml?style=flat-square" /></a>
    <a href="https://github.com/YinkaiYu/chat-in-dsh/releases"><img alt="Release" src="https://img.shields.io/github/v/release/YinkaiYu/chat-in-dsh?style=flat-square" /></a>
    <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/YinkaiYu/chat-in-dsh?style=flat-square" /></a>
    <img alt="Based on official chat-demo" src="https://img.shields.io/badge/based_on-official%20chat--demo-2F6FEB?style=flat-square" />
    <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="powered by dsh" src="https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white" /></a>
    <a href="https://www.dsh.so/artifact/chat-in-dsh/"><img alt="dsh.so" src="https://cdn.dsh.so/badge/chat-in-dsh.svg" /></a>
  </p>
  <p><a href="README.md">简体中文</a> · English</p>
</div>

## Why it exists

On November 16, 2026, the DeepSeek app and web chat introduced usage limits, pushing many users to DeepSeek Harness. Those users just want chat, writing, and Q&A, but DSH is built for developers: every conversation carries thousands of characters of system prompt and tool injection, which turns the model into an "honest worker" and loses the spark of the original web chat. The difference is especially visible in writing and casual conversation.

This plugin adds a standalone panel to DSH that hosts the DeepSeek web frontend itself: the official lightweight system prompt, the official server-side tools, the official UI. Inside that small world there is only DeepSeek, no Harness — no tool scaffolding, no web limits (requests are billed through the API), and no wall between you and the model.

## What you get

- **Authentic**: the UI is the frontend DeepSeek open-sourced; interactions, layout, and animations are replicated from the official site
- **No API Key needed**: reuse the DeepSeek account already signed in on DSH
- **Not affected by official web limits**: requests go through the API
- **Full features**: web search, deep thinking, citation markers, formulas, charts, dark mode
- **Separate panel**: its own conversation list, managed independently from DSH sessions

<img src="docs/assets/webview-reply.png" width="760" alt="Conversation and thinking process">

## Install

**1. Open the "Plugins" page in the left sidebar**

<img src="docs/assets/dsh-1.png" width="760" alt="Open the plugins page">

**2. Click "Add plugin" in the top right**

<img src="docs/assets/dsh-2.png" width="760" alt="Click add plugin">

**3. Enter the package name `chat-in-dsh` (or paste the repository URL) and click "Install"**

<img src="docs/assets/dsh-3.png" width="760" alt="Enter the package name and install">

**4. After installation, click "Enable now"**

<img src="docs/assets/dsh-4.png" width="760" alt="Click enable now">

A "Web" entry then appears in the left panel list.

## Usage

Click "Web" in the left panel list:

<img src="docs/assets/dsh-5.png" width="760" alt="Open the web panel">

If you want to focus on chatting, click the button in the top left to collapse the DSH session sidebar:

<img src="docs/assets/dsh-6.png" width="760" alt="Collapse the DSH sidebar">

After collapsing, you get the full web experience:

<img src="docs/assets/dsh-7.png" width="760" alt="The web panel">

The panel has its own conversation list, separate from DSH sessions.

## Use another model (optional)

Defaults are untouched: the panel header lists the **same model catalog as the DSH composer**
(provider groups, same source and order), and the selection dispatches through DSH providers —
no extra configuration needed.

Only when the host has no model catalog (or you want a few pinned entries) do you need a fallback
`models` catalog in the plugin config (omit `models` and you are back to the official single entry):

```yaml
- id: chat-in-dsh
  name: chat-in-dsh
  config:
    models:
      - id: deepseek-flash          # the model id the panel shows
        label: DeepSeek web
        api: anthropic              # Anthropic Messages protocol, passed through
        baseURL: https://api.deepseek.com/anthropic
      - id: glm-5.3-flash
        label: GLM 5.3 Flash
        api: openai                 # OpenAI Chat Completions, translated by the host
        baseURL: http://127.0.0.1:18088/openai/v1
        apiKeyEnv: BIFROST_VIRTUAL_KEY
        upstreamModel: agent2api/glm-5.3-flash
    defaultModel: deepseek-flash
```

The panel header has a model picker. Opening it shows a search box and the models grouped by provider;
typing filters by model name, model id, or provider name. Rows for models with reasoning levels carry a
`›` on the right that opens a second level listing the efforts from `reasoning.efforts` of that model.
The picker collapses on selection and the bar then shows the current level, e.g. `effort: high`.

The selection (model plus effort) lives in `$DSH_HOME/chat-in-dsh/model-state.json`; delete that file to
fall back to `defaultModel`. `/webchat/settings` is the full settings page for the same selection. Scripts can
use `GET /webchat/api/models` for the catalog, the active model and `activeEffort`, and
`POST /webchat/api/models {"id":"...","effort":"high"}` to switch both at once. Sending only `id` clears the
level instead of carrying the previous one over.

Both protocols work: `api: anthropic` entries are proxied verbatim (only the model id in the request body is
replaced), `api: openai` entries are translated to `chat.completions` and the chunk stream is translated back
into Anthropic events (reasoning becomes a thinking block), so the bundled UI needs no rebuild. Keys are only
read from DSH credentials or the environment variable named by `apiKeyEnv`; the browser never holds one.
Attachments still go through the official Files API, so they are unavailable while a non-official model is selected.

How effort travels: `api: openai` entries turn the top-level `effort` (or `thinking.effort`) into
`reasoning_effort` in the upstream body; DSH catalog entries pass it on as `reasoningEffort` to `prepareCall`.
With no effort selected the request body is byte-identical to 1.4.0.

### Verification evidence

`docs/evidence/` holds the raw output of the latest real-upstream run:

- [`live-e2e.json`](docs/evidence/live-e2e.json): the plugin's upstream points at an in-process recording reverse
  proxy that forwards verbatim to the local bifrost gateway. The record shows `reasoning_effort: "high"` reaching
  the upstream, the field being absent when no level is selected, and the upstream answering with the new model id
  after switching to a different provider.
- [`profile-e2e.json`](docs/evidence/profile-e2e.json): runs against a real `dsh web` instance whose catalog comes
  from the profile (three provider groups); cross-group switching, effort persistence, and a real upstream chat
  with effort are all recorded there.
- [`ui-e2e.json`](docs/evidence/ui-e2e.json): real Chromium opens the two-level menu, filters by keyword, picks an
  effort, then sends a message in the panel and waits for the real answer. Screenshots: `settings.png`,
  `model-menu.png`, `panel-chat.png`.

## Bring conversations in

**From the DeepSeek website**

1. Open chat.deepseek.com, go to "Settings → Data management → Export all chats", and download the generated ZIP (file name like `deepseek_data-2026xxxx.zip`).
2. In the panel, click "Settings" at the bottom left → "Data management" → "Import chat history" and select that ZIP.

This import replaces every conversation currently in the panel, so finish any imports before starting new conversations.

**From DSH**

Right-click any session in the left session list → "Import to web chat". The conversation is copied in, and the two sides stay independent afterwards.

## Reliability

This plugin is built on DeepSeek's open-source [chat-demo](https://github.com/deepseek-ai/chat-demo). Where requests go, the logo in the top left, and hiding the API Key input are the changes needed to fit into DSH; every other UI detail is replicated from the official site.

The official chat-demo is only the skeleton of the web chat: the UI is there, but many interactions the web version already has are missing. We filled those in to get closer to chat.deepseek.com itself:

- Conversation search: search titles, message bodies, thinking content, and attachment names; title hits get their own row, message hits carry a branch index
- Turn rail on the right: one tick per user turn, hover to preview, click to jump
- Pinning and multi-select batch management: pin, unpin, delete, with the same entry points and confirmation dialogs as the web version
- Long text paste to attachment: plain text over 2000 characters becomes an attachment card, restorable in one click, with undo/redo
- Voice input and read-aloud: the web version's recording, transcription, and playback paths
- Reading long answers: sticky code-block toolbar, back-to-latest button, Mermaid chart zoom
- Dark mode, formulas, charts, and other UI details aligned with the official styles

No repackaging, and no "optimizing" of the prompt for you — the model receives exactly what the web version sends.
