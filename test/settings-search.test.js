import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { createWebview, renderModelSettings } from '../src/webview.js'
import { createModelRegistry } from '../src/models.js'

const servers = []

async function listen(handler) {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}`, port }
}

after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
})

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chat-in-dsh-settings-'))

const CONFIG = {
  models: [
    { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash', api: 'openai', baseURL: 'http://127.0.0.1:1/openai/v1', apiKeyEnv: 'GLM_KEY' },
    { id: 'deepseek-flash', label: 'DeepSeek 网页版' },
    { id: 'agnes-3.0-flash', label: 'Agnes 3.0 Flash', api: 'openai', baseURL: 'http://127.0.0.1:1/openai/v1', apiKeyEnv: 'AGNES_KEY' },
  ],
}

async function plugin(config = CONFIG, home = tempHome()) {
  const handler = createWebview({ get: () => undefined }, config, home)
  return listen((req, res) => handler(req, res))
}

test('设置页：带搜索框、可过滤的行数据与空态占位', async () => {
  const site = await plugin()
  const response = await fetch(`${site.url}/webchat/settings`)
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /<input id="search" type="search"/u)
  assert.match(html, /aria-label="搜索模型"/u)
  assert.match(html, /id="empty" role="status" hidden/u)
  assert.match(html, /data-id="glm-5\.3-flash"/u)
  assert.match(html, /data-label="GLM 5\.3 Flash"/u)
  assert.match(html, /data-provider-name=""/u)
  assert.match(html, /import \{ matchEntry, highlightSegments/u)
  assert.match(html, /from '\/webchat\/settings-search\.js'/u)
  assert.match(html, /name="model" value="glm-5\.3-flash" checked/u, '默认选中的单选按钮要保留')
  assert.match(html, /<mark>/u, '样式里要有命中高亮')
})

test('设置页：搜索模块按 ESM 原样提供，与宿主同一份源码', async () => {
  const site = await plugin()
  const response = await fetch(`${site.url}/webchat/settings-search.js`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/javascript/u)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const source = await response.text()
  assert.equal(source, fs.readFileSync(new URL('../src/model-search.js', import.meta.url), 'utf8'))
  assert.match(source, /export function matchEntry/u)
})

test('设置页：HEAD 也能取到搜索模块（不写 body）', async () => {
  const site = await plugin()
  const response = await fetch(`${site.url}/webchat/settings-search.js`, { method: 'HEAD' })
  assert.equal(response.status, 200)
  assert.equal((await response.text()), '')
})

test('设置页渲染：DSH 目录项带 provider，插件项回落到协议名', () => {
  const home = tempHome()
  const registry = createModelRegistry({ models: CONFIG.models }, home)
  const html = renderModelSettings(registry)
  assert.match(html, /data-provider-name=""/u)
  const merged = createModelRegistry({ models: CONFIG.models }, home, [
    { id: 'agent2api', name: 'Agent2API', models: [{ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }] },
  ])
  const withProvider = renderModelSettings(merged)
  assert.match(withProvider, /data-provider-name="Agent2API"/u)
  assert.match(withProvider, /data-provider="agent2api"/u)
})
