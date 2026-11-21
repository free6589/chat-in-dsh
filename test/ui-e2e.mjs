#!/usr/bin/env node
/**
 * 真实浏览器 UI 端到端：在**正在运行的 DSH 实例**里点设置页切模型，再用网页版面板发一句话。
 *
 * 用本机 Chromium 的 CDP，所有交互都是真实鼠标/键盘事件（Input.dispatchMouseEvent /
 * Input.insertText），不是 page.evaluate 里调 click() 冒充。
 *
 * 用法（令牌只从环境变量读）：
 *   DSH_WEB_TOKEN=<token> node test/ui-e2e.mjs --base http://127.0.0.1:3199 \
 *     --model glm-5.3-flash --out-dir docs/evidence
 *
 * 产物：<out-dir>/settings.png、<out-dir>/panel-chat.png、<out-dir>/ui-e2e.json
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

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
const base = String(args.base ?? 'http://127.0.0.1:3199').replace(/\/+$/u, '')
const targetModel = String(args.model ?? 'glm-5.3-flash')
const outDir = String(args['out-dir'] ?? 'docs/evidence')
const token = process.env.DSH_WEB_TOKEN
const chromePath = process.env.CHROME_PATH ?? '/home/fish/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'
const debugPort = Number(args.port ?? 9335)

if (token === undefined || token === '') {
  console.error('缺少 DSH_WEB_TOKEN')
  process.exit(2)
}
if (!fs.existsSync(chromePath)) {
  console.error(`找不到 Chromium：${chromePath}（用 CHROME_PATH 指定）`)
  process.exit(2)
}

fs.mkdirSync(outDir, { recursive: true })
const profileDir = path.join(outDir, '.chromium-ui-e2e')
fs.rmSync(profileDir, { recursive: true, force: true })

const evidence = { startedAt: new Date().toISOString(), base, model: targetModel, steps: [] }
const record = (name, ok, detail) => {
  evidence.steps.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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
    } catch {
      // 浏览器还没起来
    }
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

function send(method, params = {}) {
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

async function screenshot(file) {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
  return fs.statSync(file).size
}

/** 用真实鼠标事件点一个元素：先取矩形中心，再 mousePressed/mouseReleased。 */
async function clickSelector(selector) {
  const rect = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (el === null) return null
    const box = el.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, w: box.width, h: box.height }
  })()`)
  if (rect === null || rect.w === 0 || rect.h === 0) return false
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  return true
}

async function waitFor(expression, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await evaluate(expression)
    if (value) return value
    await sleep(intervalMs)
  }
  return undefined
}

await send('Page.enable')
await send('Runtime.enable')

// ---- 1. 登录真实 DSH（页面令牌换 cookie） ----
await send('Page.navigate', { url: `${base}/?token=${encodeURIComponent(token)}` })
await sleep(2500)
const rootTitle = await evaluate('document.title')
record('打开真实 DSH Web UI', typeof rootTitle === 'string' && rootTitle.length > 0, JSON.stringify(rootTitle))

// ---- 2. 设置页：点选模型 → 点保存 ----
await send('Page.navigate', { url: `${base}/webchat/settings` })
await waitFor(`document.querySelectorAll('input[name=model]').length > 0`, 10000)
const radios = await evaluate(`[...document.querySelectorAll('input[name=model]')].map(el => el.value)`)
record('设置页列出可选模型', Array.isArray(radios) && radios.includes(targetModel), JSON.stringify(radios))

const clicked = await clickSelector(`input[name=model][value="${targetModel}"]`)
const checked = await evaluate(`document.querySelector('input[name=model]:checked')?.value ?? null`)
record('真实鼠标点选目标模型', clicked === true && checked === targetModel, `checked=${checked}`)

await evaluate(`document.querySelector('#save')?.scrollIntoView({ block: 'center' })`)
await sleep(500)
const saved = await clickSelector('#save')
const status = await waitFor(`(() => { const s = document.getElementById('status')?.textContent ?? ''; return s.includes('已切换') ? s : undefined })()`, 10000)
record('点「保存」并落盘', saved === true && typeof status === 'string', JSON.stringify(status ?? null))

const settingsShot = await screenshot(path.join(outDir, 'settings.png'))
record('设置页截图', settingsShot > 0, `${path.join(outDir, 'settings.png')} ${settingsShot} bytes`)

// ---- 3. 面板里发一句话，等真实回答 ----
await send('Page.navigate', { url: `${base}/webchat/` })
await waitFor(`document.querySelector('textarea') !== null`, 20000)
const before = await evaluate('document.body.innerText.length')

await clickSelector('textarea')
await send('Input.insertText', { text: '只回答一句：你是哪个模型？谁训练的？' })
await waitFor(`(() => {
  const el = document.querySelector('button[aria-label="发送"]')
  return el !== null && el.disabled !== true && !el.className.includes('disabled')
})()`, 10000)
const sendClicked = await clickSelector('button[aria-label="发送"]')
record('面板里输入并点发送', sendClicked === true, `bodyText 增长前 ${before} 字符`)

const answer = await waitFor(`(() => {
  const text = document.body.innerText
  const hit = /我是[^\\n]{0,60}(GLM|智谱|DeepSeek)[^\\n]{0,40}/u.exec(text)
  return hit === null ? undefined : hit[0]
})()`, 120000, 1000)
record('面板里出现模型回答', typeof answer === 'string', JSON.stringify(answer ?? null))

const panelShot = await screenshot(path.join(outDir, 'panel-chat.png'))
record('面板截图', panelShot > 0, `${path.join(outDir, 'panel-chat.png')} ${panelShot} bytes`)

evidence.answer = answer ?? null
evidence.ok = evidence.steps.every(step => step.ok)
evidence.finishedAt = new Date().toISOString()
fs.writeFileSync(path.join(outDir, 'ui-e2e.json'), `${JSON.stringify(evidence, null, 2)}\n`)
console.log(evidence.ok ? 'UI_E2E_OK' : 'UI_E2E_FAIL')

chrome.kill('SIGKILL')
process.exit(evidence.ok ? 0 : 1)
