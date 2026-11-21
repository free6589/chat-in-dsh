#!/usr/bin/env node
/**
 * 设置页搜索过滤的真实浏览器验证：起一个只带模型目录的插件实例，
 * 用本机 Chromium 的 CDP 真的敲键盘、真的点鼠标，读 DOM 断言过滤/高亮/空态/选中状态。
 *
 * 用法：node test/settings-search-e2e.mjs [--out-dir docs/evidence] [--port 9341]
 * 产物：<out-dir>/settings-search-*.png、<out-dir>/settings-search.json
 */
import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createWebview } from '../src/webview.js'

function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      index += 1
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const outDir = String(args['out-dir'] ?? 'docs/evidence')
const debugPort = Number(args.port ?? 9341)
const chromePath = process.env.CHROME_PATH ?? '/usr/bin/chromium'
if (!fs.existsSync(chromePath)) {
  console.error(`找不到 Chromium：${chromePath}（用 CHROME_PATH 指定）`)
  process.exit(2)
}
fs.mkdirSync(outDir, { recursive: true })
const profileDir = path.join(outDir, '.chromium-settings-search')
fs.rmSync(profileDir, { recursive: true, force: true })

const CONFIG = {
  models: [
    { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash', api: 'openai', baseURL: 'http://127.0.0.1:1/openai/v1', apiKeyEnv: 'GLM_KEY' },
    { id: 'deepseek-flash', label: 'DeepSeek 网页版' },
    { id: 'agnes-3.0-flash', label: 'Agnes 3.0 Flash', api: 'openai', baseURL: 'http://127.0.0.1:1/openai/v1', apiKeyEnv: 'AGNES_KEY' },
  ],
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-in-dsh-settings-e2e-'))
const handler = createWebview({ get: () => undefined }, CONFIG, home)
const server = http.createServer((req, res) => handler(req, res))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const evidence = { startedAt: new Date().toISOString(), base, steps: [] }
const record = (name, ok, detail) => {
  evidence.steps.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

try {
  execSync(`pkill -9 -f "remote-debugging-port=${debugPort}" 2>/dev/null || true`)
} catch { /* 没有残留 */ }
await sleep(800)
const chrome = spawn(chromePath, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDir}`,
  'about:blank',
], { stdio: 'ignore' })

async function targetList() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      if (list.length > 0) return list
    } catch { /* 浏览器还没起来 */ }
    await sleep(250)
  }
  throw new Error('CDP 没有起来')
}

const list = await targetList()
const page = list.find(item => item.type === 'page') ?? list[0]
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
  else entry.resolve(message.result)
})
const send = (method, params = {}) => {
  const id = nextId
  nextId += 1
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400))
  return result.result.value
}
async function shot(file) {
  const image = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(file, Buffer.from(image.data, 'base64'))
}

/** 真实鼠标点一个选择器（取矩形中心，发按下/抬起）。 */
async function click(selector) {
  const rect = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (el === null) return null
    const box = el.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  })()`)
  if (rect === null) throw new Error(`点不到 ${selector}`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
}

/** 真实键盘输入：焦点在搜索框里时逐字插入。 */
async function typeText(text) {
  await evaluate(`document.getElementById('search').focus()`)
  await send('Input.insertText', { text })
  await sleep(120)
}

async function pressKey(key, code, keyCode) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode })
  await sleep(120)
}

const state = () => evaluate(`(() => {
  const rows = [...document.querySelectorAll('li.row')]
  return {
    visible: rows.filter(row => !row.hidden).map(row => row.dataset.id),
    total: rows.length,
    checked: document.querySelector('input[name=model]:checked')?.value ?? null,
    marks: [...document.querySelectorAll('mark')].map(mark => mark.textContent),
    empty: document.getElementById('empty').hidden ? null : document.getElementById('empty').textContent,
    status: document.getElementById('status').textContent,
    active: document.getElementById('active-id').textContent,
    ready: document.body.dataset.search === 'ready',
  }
})()`)

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: `${base}/webchat/settings` })
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const current = await state()
    if (current.ready === true) break
  } catch { /* 页面还没加载完 */ }
  await sleep(200)
}

// 1. 初始：全部模型可见，没有高亮，没有空态
const initial = await state()
record('初始状态：三行全部可见、无高亮、无空态',
  initial.total === 3 && initial.visible.length === 3 && initial.marks.length === 0 && initial.empty === null,
  initial)

// 2. 真实鼠标换一个选中项，后面验证过滤不会把它弄丢
await click('li.row[data-id="deepseek-flash"] label')
await sleep(120)
const picked = await state()
record('点选第二行：选中状态切到 deepseek-flash', picked.checked === 'deepseek-flash', { checked: picked.checked })

// 3. 关键字即时过滤 + 命中高亮
await typeText('glm')
const filtered = await state()
record('输入 glm：只剩命中的模型，名字高亮，选中项不变',
  JSON.stringify(filtered.visible) === JSON.stringify(['glm-5.3-flash'])
  && filtered.marks.includes('GLM')
  && filtered.checked === 'deepseek-flash'
  && filtered.status === '显示 1 / 3',
  filtered)
await shot(path.join(outDir, 'settings-search-hit.png'))

// 4. provider / 协议关键字
await click('#clear')
await typeText('openai')
const byProvider = await state()
record('输入 openai：两个 OpenAI 协议条目命中，provider 列高亮',
  JSON.stringify(byProvider.visible) === JSON.stringify(['glm-5.3-flash', 'agnes-3.0-flash'])
  && byProvider.marks.filter(mark => mark.toLowerCase() === 'openai').length === 2,
  byProvider)

// 5. 无命中：明确空态，选中项仍然保留
await click('#clear')
await typeText('zzz')
const noHit = await state()
record('输入 zzz：空态文案明确，选中项与当前选择行不动',
  noHit.visible.length === 0 && noHit.empty === '没有匹配的模型。'
  && noHit.checked === 'deepseek-flash' && noHit.active === 'deepseek-flash',
  noHit)
await shot(path.join(outDir, 'settings-search-empty.png'))

// 6. 清除搜索：列表恢复
await click('#clear')
const cleared = await state()
record('点清除：三行恢复、高亮清空', cleared.visible.length === 3 && cleared.marks.length === 0, cleared)

// 7. 键盘：下键在可见行里挪选中项
await evaluate(`document.getElementById('search').focus()`)
const beforeKey = await state()
await pressKey('ArrowDown', 'ArrowDown', 40)
const afterKey = await state()
record('搜索框里按下键：选中项挪到下一行',
  afterKey.checked !== beforeKey.checked && afterKey.active === afterKey.checked,
  { before: beforeKey.checked, after: afterKey.checked })

// 8. 保存：过滤状态下保存的仍是选中项
await click('#save')
await sleep(300)
const saved = await (await fetch(`${base}/webchat/api/models`)).json()
record('点保存：落盘的是选中项，不受过滤影响', saved.active === afterKey.checked, { active: saved.active, checked: afterKey.checked })

const failed = evidence.steps.filter(step => step.ok !== true)
evidence.finishedAt = new Date().toISOString()
evidence.ok = failed.length === 0
fs.writeFileSync(path.join(outDir, 'settings-search.json'), `${JSON.stringify(evidence, null, 2)}\n`)
console.log(failed.length === 0 ? 'SETTINGS_SEARCH_E2E_OK' : `SETTINGS_SEARCH_E2E_FAILED (${failed.length})`)
socket.close()
chrome.kill('SIGKILL')
server.close()
process.exit(failed.length === 0 ? 0 : 1)
