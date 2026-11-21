#!/usr/bin/env node
/**
 * 一键真实 profile 验证（隔离实例，全自动）。
 *
 * 流程：
 *   1. 复制 ~/.dsh/profiles/web → ~/.dsh/profiles/web-verify（隔离，主实例不动）
 *   2. 起 dsh --profile web-verify --port 3199，抓启动 token
 *   3. 跑 test/profile-e2e.mjs（目录/设置页/切换/真实对话/自检/落盘）
 *   4. 跑 test/ui-e2e.mjs（CDP 真实浏览器点选 + 对话）
 *   5. 停实例，删副本，输出证据
 *
 * 用法：node scripts/verify-profile.mjs [--keep] [--model glm-5.3-flash] [--port 3199]
 *
 * `--port` 换宿主端口（同一台机器上并行跑时用），CDP 调试端口固定为端口 + 1000。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const keep = process.argv.includes('--keep')
const modelArg = process.argv.find((arg, i) => process.argv[i - 1] === '--model')
const targetModel = modelArg ?? 'glm-5.3-flash'
const home = os.homedir()
const src = path.join(home, '.dsh', 'profiles', 'web')
const dest = path.join(home, '.dsh', 'profiles', 'web-verify')
const portArg = process.argv.find((arg, i) => process.argv[i - 1] === '--port')
const port = portArg === undefined ? 3199 : Number(portArg)
const cdpPort = port + 1000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

console.log('1/5 复制 profile ...')
fs.rmSync(dest, { recursive: true, force: true })
fs.cpSync(src, dest, { recursive: true })
// 插件是实体复制（非 symlink）：把工作区最新代码同步进副本，否则验证跑的是旧代码
const pluginDest = path.join(dest, 'node_modules', 'chat-in-dsh')
fs.rmSync(pluginDest, { recursive: true, force: true })
fs.cpSync(path.join(home, 'projects_mine', 'chat-in-dsh'), pluginDest, {
  recursive: true,
  filter: name => !name.includes('node_modules') && !name.includes('/.git'),
})

console.log('2/5 启动隔离实例 ...')
const logFile = '/tmp/dsh-verify-profile.log'
const logFd = fs.openSync(logFile, 'w')
const child = spawn('dsh', ['--profile', 'web-verify', '--port', String(port), '--no-open', '--host', '127.0.0.1'], {
  stdio: ['ignore', logFd, logFd],
})
await sleep(20000)

// 从日志抓 token（dsh web 启动打印的 dsh web: http://...?token=xxx）
let token = ''
for (let i = 0; i < 90 && !token; i++) {
  await sleep(2000)
  const log = fs.readFileSync(logFile, 'utf8')
  const match = /dsh web:\s*(http[^\s]*[?&]token=([A-Za-z0-9_-]+))/u.exec(log)
  if (match) {
    token = match[2]
    const portMatch = /:(\d+)(?:\/|$|\?)/u.exec(match[1])
    if (portMatch) console.log(`   实例地址：http://127.0.0.1:${portMatch[1]}`)
    break
  }
  try {
    await fetch(`http://127.0.0.1:${port}/`)
  } catch { /* 还没起来 */ }
}
const log = fs.readFileSync(logFile, 'utf8')
if (!token) {
  console.error('没抓到 DSH_WEB_TOKEN，日志尾部：')
  console.error(log.split('\n').filter(l => !/serena|mobile-mcp|mdcg/i.test(l)).slice(-10).join('\n'))
  child.kill('SIGKILL')
  if (!keep) fs.rmSync(dest, { recursive: true, force: true })
  process.exit(2)
}
console.log(`   token 已拿到（${token.length} 字符，不打印）`)

const env = { ...process.env, DSH_WEB_TOKEN: token }
const run = (script, args) => new Promise(resolve => {
  const p = spawn('node', [script, ...args], { env, stdio: 'inherit' })
  p.on('exit', code => resolve(code))
})

console.log('3/5 跑 profile-e2e ...')
const c1 = await run('test/profile-e2e.mjs', [
  '--base', `http://127.0.0.1:${port}`,
  '--model', targetModel,
  '--home', path.join(home, '.dsh'),
  '--out', 'docs/evidence/profile-e2e.json',
])

console.log('4/5 跑 ui-e2e ...')
const c2 = await run('test/ui-e2e.mjs', [
  '--base', `http://127.0.0.1:${port}`,
  '--model', targetModel,
  '--out-dir', 'docs/evidence',
  '--port', String(cdpPort),
])

console.log('5/5 清理 ...')
child.kill('SIGKILL')
await sleep(2000)
if (!keep) {
  fs.rmSync(dest, { recursive: true, force: true })
  console.log('   隔离 profile 已删除，主实例未动')
} else {
  console.log(`   保留隔离 profile：${dest}（--keep）`)
}

if (c1 !== 0 || c2 !== 0) {
  console.error(`验证失败：profile-e2e=${c1} ui-e2e=${c2}`)
  process.exit(1)
}
console.log('VERIFY_PROFILE_OK')
