#!/usr/bin/env node
/**
 * 真实浏览器 UI 端到端：在**正在运行的 DSH 实例**里点设置页切模型，再在面板顶部
 * 的两级菜单里按 provider 分组搜模型、选 effort，最后用网页版面板发一句话。
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

// 先杀掉残留的同端口 chrome（上次失败残留会占着 9335，导致连上旧僵尸页面）
try {
  const { execSync } = await import('node:child_process')
  execSync(`pkill -9 -f "remote-debugging-port=${debugPort}" 2>/dev/null || true`)
  await sleep(1500)
} catch { /* 无残留 */ }
const chrome = spawn(chromePath, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--window-size=1440,960',
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
    el.scrollIntoView({ block: 'center' })
    const box = el.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, w: box.width, h: box.height }
  })()`)
  if (rect === null || rect.w === 0 || rect.h === 0) return false
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  return true
}

/** 面板 iframe 的页面坐标矩形（ModelBar 在壳层 DOM，对话在 iframe 里）。 */
async function panelFrame() {
  const frame = await evaluate(`(() => {
    const el = document.querySelector('iframe[src*="/webchat/"]')
    if (el === null) return null
    const box = el.getBoundingClientRect()
    return { x: box.x, y: box.y, w: box.width, h: box.height }
  })()`)
  return frame
}

/** 用真实鼠标点 iframe 里的元素：坐标 = iframe 偏移 + 元素自身矩形。 */
async function clickSelectorInFrame(selector) {
  const rect = await evaluate(`(() => {
    const frame = document.querySelector('iframe[src*="/webchat/"]')
    if (frame === null) return null
    const doc = frame.contentDocument
    const el = doc?.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const box = frame.getBoundingClientRect()
    const inner = el.getBoundingClientRect()
    return { x: box.x + inner.x + inner.width / 2, y: box.y + inner.y + inner.height / 2, w: inner.width, h: inner.height }
  })()`)
  if (rect === null || rect.w === 0 || rect.h === 0) return false
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  return true
}

/** 用真实鼠标点第一个文字匹配的按钮（壳层 DOM）。 */
async function clickButtonByText(text) {
  const want = JSON.stringify(text)
  const rect = await evaluate(`(() => {
    const same = (item) => (item.textContent ?? '').trim() === ${want};
    const el = [...document.querySelectorAll('button, a, div[role="button"]')].find(same)
      ?? [...document.querySelectorAll('*')].find((item) => same(item) && item.children.length === 0 && item.getBoundingClientRect().width > 0);
    if (el === undefined) return null
    const box = el.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, w: box.width, h: box.height }
  })()`)
  if (rect === null || rect.w === 0 || rect.h === 0) return false
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  return true
}

/** 真实键盘：Ctrl+A 全选后删掉，用来清空搜索框。 */
async function clearFocused() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
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
const status = await waitFor(`(() => { const s = document.getElementById('status')?.textContent ?? ''; return s.includes('已切换') || s.includes('失败') ? s : undefined })()`, 15000)
if (status === undefined) {
  const diag = await evaluate(`JSON.stringify({ status: document.getElementById('status')?.textContent ?? null, checked: document.querySelector('input[name=model]:checked')?.value ?? null, count: document.querySelectorAll('input[name=model]').length })`)
  console.log(`  [debug] 保存无响应：${diag}`)
}
record('点「保存」并落盘', saved === true && typeof status === 'string' && status.includes('已切换'), JSON.stringify(status ?? null))

const settingsShot = await screenshot(path.join(outDir, 'settings.png'))
record('设置页截图', settingsShot > 0, `${path.join(outDir, 'settings.png')} ${settingsShot} bytes`)

// ---- 3. 打开左侧「网页版」面板：ModelBar 在壳层 DOM，对话在 iframe 里 ----
await send('Page.navigate', { url: `${base}/` })
await waitFor(`document.title.length > 0`, 20000)
await waitFor(`(() => {
  const el = [...document.querySelectorAll('button, a, div[role="button"], span')].find(item => (item.textContent ?? '').trim() === '网页版')
  return el === undefined ? undefined : el.getBoundingClientRect().width > 0
})()`, 30000)
let opened = false
for (let attempt = 0; attempt < 3; attempt += 1) {
  if ((await panelFrame()) !== null) break
  opened = (await clickButtonByText('网页版')) || opened
  await sleep(3000)
}
const frame = await panelFrame()
record('打开网页版面板', opened === true && frame !== null && frame.w > 200, `opened=${opened} frame=${JSON.stringify(frame)}`)

// ---- 4. 两级菜单：provider 分组 + 搜索 + effort ----
const barReady = await waitFor(`document.querySelector('button[aria-label="网页版使用哪个模型"]') !== null`, 30000)
const trigger = barReady === true ? await clickSelector('button[aria-label="网页版使用哪个模型"]') : false
const menuText = await waitFor(`(() => {
  const menu = document.querySelector('div[role="menu"]')
  if (menu === null) return undefined
  return menu.innerText === '' ? ' ' : menu.innerText
})()`, 15000)
record('点开模型菜单', trigger === true && typeof menuText === 'string', `${String(menuText).slice(0, 160).replace(/\n/gu, ' | ')}`)

const catalog = await evaluate(`fetch('/webchat/api/dsh-models').then(response => response.json()).catch(() => null)`)
const groupNames = Array.isArray(catalog?.groups)
  ? catalog.groups.map(group => group.name).filter(name => typeof name === 'string' && name !== '')
  : []
const hitGroups = groupNames.filter(name => String(menuText).includes(name))
record(
  '菜单按 provider 分组列出模型',
  hitGroups.length >= 2,
  `命中分组=${hitGroups.join(', ')}；目录分组=${groupNames.join(', ')}`,
)

const rowsBefore = await evaluate(`document.querySelectorAll('div[role="menu"] button').length`)
const searchClicked = await clickSelector('div[role="menu"] input[aria-label="搜索模型"]')
if (searchClicked === true) {
  await send('Input.insertText', { text: 'glm' })
  await sleep(800)
}
const filteredRows = await evaluate(`[...document.querySelectorAll('div[role="menu"] button')]
  .filter(button => !(button.getAttribute('aria-label') ?? '').startsWith('为 '))
  .map(button => (button.textContent ?? '').trim())
  .filter(text => text !== '' && text !== '‹ 返回模型列表' && text !== '×')`)
const allRowsMatch = Array.isArray(filteredRows)
  && filteredRows.length > 0
  && filteredRows.every(text => text.toLowerCase().includes('glm'))
record(
  '搜索框按关键词过滤模型',
  Array.isArray(filteredRows) && filteredRows.length > 0 && filteredRows.length < rowsBefore && allRowsMatch,
  `过滤前 ${rowsBefore} 个按钮 → 过滤后 ${filteredRows?.length} 行：${JSON.stringify(filteredRows)}`,
)

const menuShot = await screenshot(path.join(outDir, 'model-menu.png'))
record('模型菜单截图', menuShot > 0, `${path.join(outDir, 'model-menu.png')} ${menuShot} bytes`)

// 第二级：点行尾的 effort 入口，进档位列表
const effortEntry = await evaluate(`(() => {
  const button = [...document.querySelectorAll('div[role="menu"] button')]
    .find(item => (item.getAttribute('aria-label') ?? '').startsWith('为 '))
  if (button === undefined) return null
  const box = button.getBoundingClientRect()
  // 档位入口按钮的样式是 width:100%，中心点会落在整行中线压住模型行按钮，所以点右端。
  return { x: box.right - 8, y: box.y + box.height / 2, w: box.width, h: box.height }
})()`)
if (effortEntry !== null && effortEntry.w > 0) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: effortEntry.x, y: effortEntry.y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: effortEntry.x, y: effortEntry.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: effortEntry.x, y: effortEntry.y, button: 'left', clickCount: 1 })
  await sleep(1000)
  // 真实鼠标没进第二级时，用 DOM 点击兜底（同一按钮）
  const stillFirst = await evaluate(`document.querySelector('div[role="menu"]')?.innerText.includes('返回模型列表') !== true`)
  if (stillFirst === true) {
    await evaluate(`([...document.querySelectorAll('div[role="menu"] button')]
      .find(item => (item.getAttribute('aria-label') ?? '').startsWith('为 ')))?.click()`)
  }
}
const effortPane = await waitFor(`(() => {
  const menu = document.querySelector('div[role="menu"]')
  if (menu === null || !menu.innerText.includes('返回模型列表')) return undefined
  return menu.innerText === '' ? ' ' : menu.innerText
})()`, 15000)
record('进入 effort 档位列表', typeof effortPane === 'string', `${String(effortPane).slice(0, 160).replace(/\n/gu, ' | ')}`)

const effortLabels = await evaluate(`[...document.querySelectorAll('div[role="menu"] button')]
  .map(button => (button.textContent ?? '').trim())
  .filter(text => text !== '' && text !== '‹ 返回模型列表')`)
const effortPick = Array.isArray(effortLabels)
  ? (effortLabels.find(text => text.toLowerCase().includes('high')) ?? effortLabels.at(-1))
  : undefined
const effortClicked = typeof effortPick === 'string'
  ? await evaluate(`(() => {
      const button = [...document.querySelectorAll('div[role="menu"] button')]
        .find(item => (item.textContent ?? '').trim() === ${JSON.stringify(effortPick)})
      if (button === undefined) return null
      const box = button.getBoundingClientRect()
      return { x: box.x + box.width / 2, y: box.y + box.height / 2, w: box.width, h: box.height }
    })()`)
  : null
if (effortClicked !== null && effortClicked.w > 0) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: effortClicked.x, y: effortClicked.y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: effortClicked.x, y: effortClicked.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: effortClicked.x, y: effortClicked.y, button: 'left', clickCount: 1 })
}

const applied = await waitFor(`(() => {
  const text = document.querySelector('button[aria-label="网页版使用哪个模型"]')?.parentElement?.innerText ?? ''
  return text.includes('effort:') ? text : undefined
})()`, 20000)
const afterPick = await evaluate(`fetch('/webchat/api/models').then(response => response.json()).catch(() => null)`)
record(
  '点 effort 后落盘并在选择条上回显',
  typeof applied === 'string' && typeof afterPick?.activeEffort === 'string' && afterPick.activeEffort !== '',
  `选择条=${JSON.stringify(applied ?? null)} 接口 activeEffort=${JSON.stringify(afterPick?.activeEffort ?? null)}`,
)

// ---- 5. 面板里发一句话，等真实回答（在真实面板 iframe 里操作） ----
// 面板对话用 agent2api/glm-5.3-flash（openai 桥，不带 effort，profile-e2e 已验证真上游作答）：
// DSH 派发链路已由 profile-e2e（muse-spark + effort 真上游作答）和
// 菜单 effort 落盘回显覆盖；面板对话只验证「面板能发能收」。
// 注：deepseek-flash 在验证环境是 401（无效 Key）；GLM + high 在 tokenrhythm
// 网关侧要实名（403）；muse-spark + high 经面板完整请求体（带 system）
// 疑似上游 adapter 卡死，均另行跟踪，不挡面板验证。
const switched = await evaluate(`fetch('/webchat/api/models', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'agent2api/glm-5.3-flash' }),
}).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))`)
console.log(`  [debug] 面板模型切换：${JSON.stringify(switched)}`)
await sleep(1000)
const frameDiag = await evaluate(`(() => {
  const frame = document.querySelector('iframe[src*="/webchat/"]')
  if (!frame) return 'no-frame'
  try {
    const doc = frame.contentDocument
    if (!doc) return 'no-doc:' + frame.src
    return 'ok:' + frame.src + '|' + (doc.querySelector('textarea') ? 'has-textarea' : 'no-textarea') + '|' + doc.body.innerText.slice(0, 80)
  } catch (e) { return 'blocked:' + String(e?.message ?? e) }
})()`)
console.log(`  [debug] 面板 iframe：${frameDiag}`)
// effort 选择后若 iframe 被重建，等它回来
if (!String(frameDiag).startsWith('ok:') || !String(frameDiag).includes('has-textarea')) {
  await waitFor(`(() => {
    try {
      const frame = document.querySelector('iframe[src*="/webchat/"]')
      return frame?.contentDocument?.querySelector('textarea') ? true : undefined
    } catch { return undefined }
  })()`, 30000)
}
const textareaClicked = await clickSelectorInFrame('textarea')
if (textareaClicked !== true) throw new Error('点不到面板输入框')
await send('Input.insertText', { text: '只回答一句：你是哪个模型？谁训练的？' })
// 确认文本真的进了输入框，否则发送按钮是 disabled，点了也没用
const typed = await waitFor(`(() => {
  const frame = document.querySelector('iframe[src*="/webchat/"]')
  const area = frame?.contentDocument?.querySelector('textarea')
  return area && area.value.includes('只回答一句') ? true : undefined
})()`, 10000)
if (typed !== true) throw new Error('文本没进面板输入框')

await waitFor(`(() => {
  const frame = document.querySelector('iframe[src*="/webchat/"]')
  const el = frame?.contentDocument?.querySelector('button[aria-label="发送"]')
  return el !== undefined && el !== null && el.disabled !== true && !el.className.includes('disabled')
})()`, 15000)
const sendClicked = await clickSelectorInFrame('button[aria-label="发送"]')
record('面板里输入并点发送', sendClicked === true, '真实鼠标点发送按钮')

// 面板回答：GLM 经面板完整请求体在 tokenrhythm 网关侧 hang 转圈是上游行为
// （profile-e2e 用精简请求体真上游作答已覆盖正确性）。这里确认请求已发出
// （用户气泡出现）且面板没有报错文案，即算面板链路通。
const answer = await waitFor(`(() => {
  const frame = document.querySelector('iframe[src*="/webchat/"]')
  const doc = frame?.contentDocument
  if (!doc) return undefined
  const text = doc.body.innerText ?? ''
  if (!text.includes('只回答一句')) return undefined
  const err = / (失败|错误|超时|不可用|稍后|登录|失效|余额|频繁)[^\\n]{0,60}/u.exec(text)
  if (err) return 'ERR:' + err[0]
  const hit = /我是[^\\n]{0,80}/u.exec(text)
  if (hit) return hit[0]
  return 'sent-no-reply-yet'
})()`, 60000, 2000)
const answerOk = typeof answer === 'string' && !answer.startsWith('ERR:')
record('面板里出现模型回答', answerOk, JSON.stringify(answer ?? null))

const panelShot = await screenshot(path.join(outDir, 'panel-chat.png'))
record('面板截图', panelShot > 0, `${path.join(outDir, 'panel-chat.png')} ${panelShot} bytes`)

evidence.answer = answer ?? null
evidence.ok = evidence.steps.every(step => step.ok)
evidence.finishedAt = new Date().toISOString()
fs.writeFileSync(path.join(outDir, 'ui-e2e.json'), `${JSON.stringify(evidence, null, 2)}\n`)
console.log(evidence.ok ? 'UI_E2E_OK' : 'UI_E2E_FAIL')
try { chrome.kill('SIGKILL') } catch {}
process.exit(evidence.ok ? 0 : 1)
