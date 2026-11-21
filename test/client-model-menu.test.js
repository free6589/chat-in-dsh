/**
 * 面板顶部模型菜单的搜索交互：在 Node 里用最小 React 运行时把 client.js 真的渲染出来，
 * 点开菜单、敲关键字、读渲染结果。
 *
 * 同时和 src/model-search.js 逐条比对——菜单里那份实现是同一套规则的手抄副本，
 * 两边跑偏了这里会红。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { filterGroups } from '../src/model-search.js'

const SOURCE = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const CATALOG = {
  ok: true,
  default: { provider: 'agent2api', model: 'glm-5.3-flash' },
  groups: [
    {
      id: 'agent2api',
      name: 'Agent2API',
      models: [
        { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', reasoning: { efforts: [{ id: 'high', name: '高' }] } },
        { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash' },
      ],
    },
    {
      id: 'bifrost',
      name: 'Bifrost',
      models: [
        { id: 'agnes-3.0-flash', name: 'Agnes 3.0 Flash' },
        { id: 'muse-spark-1.3', name: 'Muse Spark 1.3' },
      ],
    },
  ],
}

/** 最小 React：只实现 client.js 用到的 createElement 与四个 hook，够跑组件即可。 */
function createRuntime() {
  const hooks = []
  const pending = []
  let cursor = 0
  let dirty = false
  const sameDeps = (left, right) => Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  const slot = (initial) => {
    const at = cursor
    cursor += 1
    if (hooks[at] === undefined) hooks[at] = { value: initial }
    return hooks[at]
  }
  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: {
          ...(props ?? {}),
          ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
        },
      }
    },
    useState(initial) {
      const at = slot(typeof initial === 'function' ? initial() : initial)
      return [at.value, (next) => {
        const value = typeof next === 'function' ? next(at.value) : next
        if (Object.is(value, at.value)) return
        at.value = value
        dirty = true
      }]
    },
    useRef(initial) {
      return slot({ current: initial })
    },
    useCallback(fn, deps) {
      const at = slot({ fn, deps })
      if (!sameDeps(at.deps, deps)) {
        at.fn = fn
        at.deps = deps
      }
      return at.fn
    },
    useEffect(fn, deps) {
      const at = slot({ deps: undefined, ran: false })
      if (at.ran && sameDeps(at.deps, deps)) return
      at.deps = deps
      at.ran = true
      pending.push(fn)
    },
  }
  return {
    React,
    hooks,
    pending,
    takeDirty: () => {
      const value = dirty
      dirty = false
      return value
    },
    resetCursor: () => { cursor = 0 },
  }
}

/** 函数组件展开：把 h(Component) 递归渲染成宿主节点，effect 收集到 runtime.pending。 */
function expand(tree) {
  if (tree === null || tree === undefined) return tree
  if (Array.isArray(tree)) return tree.map(expand)
  if (typeof tree !== 'object') return tree
  if (typeof tree.type === 'function') return expand(tree.type(tree.props ?? {}))
  const children = tree.props?.children
  return { ...tree, props: { ...tree.props, ...(children === undefined ? {} : { children: expand(children) }) } }
}

/** 一次渲染 + 跑挂起 effect，直到没有新状态。 */
async function flush(runtime, component) {
  let tree
  for (let round = 0; round < 40; round += 1) {
    runtime.resetCursor()
    tree = expand(component())
    const effects = runtime.pending.splice(0)
    for (const effect of effects) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    }
    // fetch 的链式 then 要跑几轮微任务，用宏任务把它们一次放干。
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    if (!runtime.takeDirty()) return tree
  }
  throw new Error('渲染没有收敛（可能是 effect 里 setState 的死循环）')
}
let cleanups = []

/** 深度遍历渲染树，按条件收集节点。 */
function collect(tree, predicate, found = []) {
  if (tree === null || tree === undefined) return found
  if (Array.isArray(tree)) {
    for (const child of tree) collect(child, predicate, found)
    return found
  }
  if (typeof tree === 'string' || typeof tree === 'number') return found
  if (predicate(tree)) found.push(tree)
  collect(tree.props?.children, predicate, found)
  return found
}

const textOf = (tree) => {
  if (tree === null || tree === undefined) return ''
  if (Array.isArray(tree)) return tree.map(textOf).join('')
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  return textOf(tree.props?.children)
}

const buttonByText = (tree, text) => collect(tree, node => node.type === 'button' && textOf(node).includes(text))[0]
const byAria = (tree, label) => collect(tree, node => node.props?.['aria-label'] === label)[0]
const input = (tree) => collect(tree, node => node.type === 'input')[0]
/** 菜单里的模型行（触发器也是 button，按 aria-label 排掉）。 */
const modelRow = (tree, name) => collect(tree, node => node.type === 'button'
  && node.props?.['aria-label'] === undefined
  && textOf(node).includes(name))[0]
const markedTexts = (tree) => collect(tree, node => node.type === 'mark').map(textOf)

/** 把 client.js 在沙箱里加载出来，拿到注册到 main 槽位的面板组件（Panel → ModelBar）。 */
async function mountPanel(options = {}) {
  const dshCatalog = options.dshCatalog ?? CATALOG
  const flatModels = options.flatModels ?? []
  const registration = {}
  const requested = []
  const window = {
    __ModuleLoader__: { load: (value) => { Object.assign(registration, value) } },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: {},
  }
  const document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () => [],
    body: {},
  }
  const fetch = async (url, options) => {
    requested.push({ url: String(url), options })
    if (String(url).includes('/webchat/api/dsh-models')) return { json: async () => dshCatalog }
    if (String(url).includes('/webchat/api/models')) {
      return { json: async () => ({ ok: true, models: flatModels, active: 'agent2api/glm-5.3-flash' }) }
    }
    throw new Error(`未预期的请求：${url}`)
  }
  const runtime = createRuntime()
  const require = (specifier) => {
    if (specifier === 'react') return runtime.React
    throw new Error(`未预期的依赖：${specifier}`)
  }
  const load = new Function('window', 'document', 'fetch', 'navigator', 'MutationObserver', SOURCE)
  load(window, document, fetch, window.navigator, undefined)
  assert.equal(typeof registration.factory, 'function', 'client.js 没有走 __ModuleLoader__.load')
  const module = registration.factory(require)
  const registered = []
  const ctx = {
    effect: (fn) => { fn() },
    slots: {
      inject: (_name, run) => run(),
      register: (definition, component) => { registered.push({ definition, component }); return component },
    },
    contextMenus: { register: () => {}, notify: () => {} },
    layout: { selectPanel: () => {} },
    get: () => undefined,
  }
  module.apply(ctx)
  const panel = registered.find(entry => entry.definition?.name === 'main')?.component
  assert.equal(typeof panel, 'function', '面板组件没注册到 main 槽位')
  return { runtime, panel, requested }
}

/** 打开菜单：先渲染面板，再点触发器。 */
async function openMenu(options = {}) {
  cleanups = []
  const { runtime, panel, requested } = await mountPanel(options)
  let tree = await flush(runtime, panel)
  const trigger = byAria(tree, '网页版使用哪个模型')
  assert.notEqual(trigger, undefined, '找不到模型选择触发器')
  trigger.props.onClick()
  tree = await flush(runtime, panel)
  return { runtime, panel, requested, tree: () => tree, rerender: async () => { tree = await flush(runtime, panel); return tree } }
}

const type = async (session, value) => {
  const field = input(session.tree())
  assert.notEqual(field, undefined, '菜单里没有搜索框')
  field.props.onChange({ target: { value } })
  return session.rerender()
}

test('打开菜单：搜索框、分组标题、全部模型都在', async () => {
  const session = await openMenu()
  const tree = session.tree()
  assert.equal(input(tree).props.placeholder, '搜索模型…')
  const headings = collect(tree, node => node.type === 'div' && ['Agent2API', 'Bifrost'].includes(textOf(node)))
  assert.equal(headings.length, 2)
  assert.notEqual(modelRow(tree, 'Qwen3.8 Flash'), undefined)
  assert.notEqual(modelRow(tree, 'Muse Spark 1.3'), undefined)
})

test('输入关键字即时过滤：只留命中的模型，名字命中处有高亮', async () => {
  const session = await openMenu()
  const tree = await type(session, 'glm')
  assert.equal(modelRow(tree, 'Qwen3.8 Flash'), undefined, '没命中的模型应该消失')
  assert.notEqual(modelRow(tree, 'GLM 5.3 Flash'), undefined)
  assert.deepEqual(markedTexts(tree), ['GLM'])
  assert.equal(collect(tree, node => node.type === 'div' && textOf(node) === 'Bifrost').length, 0, '空组的分组标题不该出现')
})

test('provider 标题命中：整组保留，标题本身高亮', async () => {
  const session = await openMenu()
  const tree = await type(session, 'bifrost')
  assert.notEqual(modelRow(tree, 'Agnes 3.0 Flash'), undefined)
  assert.notEqual(modelRow(tree, 'Muse Spark 1.3'), undefined)
  assert.equal(modelRow(tree, 'GLM 5.3 Flash'), undefined)
  assert.deepEqual(markedTexts(tree), ['Bifrost'])
})

test('无命中：明确空态，选中项与触发器文字都不动', async () => {
  const session = await openMenu()
  const tree = await type(session, 'zzz')
  const status = collect(tree, node => node.props?.role === 'status').map(textOf)
  assert.deepEqual(status, ['没有匹配的模型。'])
  assert.equal(modelRow(tree, 'GLM 5.3 Flash'), undefined)
  const trigger = byAria(tree, '网页版使用哪个模型')
  assert.notEqual(trigger, undefined, '触发器还在')
  assert.match(textOf(trigger), /GLM 5\.3 Flash/u)
})

test('清除搜索：列表恢复全部模型', async () => {
  const session = await openMenu()
  await type(session, 'glm')
  const clear = byAria(session.tree(), '清除搜索')
  assert.notEqual(clear, undefined, '有查询时应该有清除按钮')
  clear.props.onClick()
  const tree = await session.rerender()
  assert.notEqual(modelRow(tree, 'Muse Spark 1.3'), undefined)
  assert.deepEqual(markedTexts(tree), [])
  assert.equal(input(tree).props.value, '')
})

test('上下键在过滤结果里移动高亮，回车选中', async () => {
  const session = await openMenu()
  await type(session, 'flash')
  const field = input(session.tree())
  field.props.onKeyDown({ key: 'ArrowDown', preventDefault: () => {} })
  const tree = await session.rerender()
  const active = collect(tree, node => node.type === 'button' && node.props.style?.background === '#eef2ff')
  assert.equal(active.length, 1, '应该正好一行是高亮行')
  collect(tree, node => node.props?.role === 'searchbox')[0].props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
  const after = await session.rerender()
  const posts = session.requested.filter(request => request.options?.method === 'POST')
  assert.equal(after !== undefined, true)
  assert.equal(posts.length, 1, '回车应该提交一次选择')
  assert.equal(JSON.parse(posts[0].options.body).id, 'agent2api/qwen3.8-flash', '回车选中的是高亮那一行')
})

test('和 src/model-search.js 的分组过滤结果逐条一致', async () => {
  const session = await openMenu()
  for (const query of ['', 'glm', 'flash', 'bifrost', 'agent', 'qwen3', 'zzz', '  GLM  ']) {
    const tree = await type(session, query)
    const rendered = collect(tree, node => node.type === 'button' && typeof node.props.onClick === 'function')
      .map(textOf)
      .filter(text => !text.includes('网页版使用哪个模型') && !text.includes('×'))
    const expected = filterGroups(CATALOG.groups, query).flatMap(group => group.models.map(row => row.model.name))
    for (const name of expected) {
      assert.ok(rendered.some(text => text.includes(name)), `query=${query} 少了 ${name}`)
    }
    if (expected.length === 0) assert.deepEqual(collect(tree, node => node.props?.role === 'status').map(textOf), ['没有匹配的模型。'])
  }
})

test('没有 DSH 目录时退回插件目录：关键字同样即时过滤', async () => {
  const session = await openMenu({
    dshCatalog: { ok: false, error: '无 DSH 目录' },
    flatModels: [
      { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash' },
      { id: 'deepseek-flash', label: 'DeepSeek 网页版', default: true },
    ],
  })
  const all = session.tree()
  assert.notEqual(modelRow(all, 'GLM 5.3 Flash'), undefined)
  assert.notEqual(modelRow(all, 'DeepSeek 网页版'), undefined)
  const tree = await type(session, 'glm')
  assert.equal(modelRow(tree, 'DeepSeek 网页版'), undefined, '没命中的插件条目应该消失')
  assert.deepEqual(markedTexts(tree), ['GLM'])
  const empty = await type(session, 'zzz')
  assert.deepEqual(collect(empty, node => node.props?.role === 'status').map(textOf), ['没有匹配的模型。'])
})
