/**
 * 浏览器半边。
 *
 * 一个入口：左侧面板列表里的「网页版」。
 * 面板顶部挂一条模型选择条：DSH 聊天框同款两级菜单（provider 分组模型列表 + 搜索 + 推理等级），选择随宿主落盘。
 * 另外在会话的右键菜单里加一行「导入到网页版」——一次性复制，复制完两边各管各的。
 */
window.__ModuleLoader__.load({
  id: 'chat-in-dsh',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // 模型搜索：规则与 src/model-search.js 同一套——大小写不敏感的有序子序列，
    // 前缀命中优先、命中越紧凑越靠前，分组标题只在组内还有命中时出现。
    // 客户端插件拿不到宿主的 ESM 模块，这里留一份同源实现，
    // test/client-model-menu.test.js 会拿它和模块逐条比对，防止两边跑偏。
    const normalizeQuery = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '')
    const matchText = (text, query) => {
      const q = normalizeQuery(query)
      const source = typeof text === 'string' ? text : ''
      if (q === '') return { indices: [], score: 0 }
      const haystack = source.toLowerCase()
      const indices = []
      let from = 0
      for (const character of q) {
        const found = haystack.indexOf(character, from)
        if (found < 0) return undefined
        indices.push(found)
        from = found + 1
      }
      const span = indices[indices.length - 1] - indices[0] + 1
      return { indices, score: (indices[0] === 0 ? 0 : 1000) + span }
    }
    const highlightSegments = (text, indices) => {
      const source = typeof text === 'string' ? text : String(text ?? '')
      const hits = new Set((Array.isArray(indices) ? indices : []).filter((index) => index >= 0 && index < source.length))
      if (hits.size === 0) return [{ text: source, hit: false }]
      const segments = []
      for (let index = 0; index < source.length; index += 1) {
        const hit = hits.has(index)
        const last = segments[segments.length - 1]
        if (last !== undefined && last.hit === hit) last.text += source[index]
        else segments.push({ text: source[index], hit })
      }
      return segments
    }

    // 官方字标（小鲸鱼）内联为 data URI：侧栏图标不依赖任何额外请求。
    const PANEL_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNyIgaGVpZ2h0PSIyMCIgdmlld0JveD0iMC4xNjMgMS43NSAyNi42MzQgMTkuNiIgZmlsbD0ibm9uZSIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsPSJEZWVwU2VlayI+CiAgPHBhdGggZD0iTTI2LjUxNzQgMy4zOTQ3MUMyNi4yMzUgMy4yNTY3IDI2LjExMzcgMy41MjAwNiAyNS45NDg3IDMuNjUzNDZDMjUuODkyMyAzLjY5NjU5IDI1Ljg0NDYgMy43NTI5NCAyNS43OTY5IDMuODA0NjlDMjUuMzg0NiA0LjI0NTE2IDI0LjkwMjcgNC41MzQzOSAyNC4yNzM3IDQuNDk5ODlDMjMuMzUzNiA0LjQ0ODE0IDIyLjU2ODIgNC43MzczNyAyMS44NzM1IDUuNDQxMTlDMjEuNzI1OCA0LjU3MzQ5IDIxLjIzNTMgNC4wNTU0IDIwLjQ4ODkgMy43MjMwNEMyMC4wOTg1IDMuNTUwNTQgMTkuNzAzNCAzLjM3NzQ2IDE5LjQyOTcgMy4wMDE5N0MxOS4yMzg4IDIuNzM0NTkgMTkuMTg2NSAyLjQzNjczIDE5LjA5MSAyLjE0Mjg5QzE5LjAzMDEgMS45NjU3OSAxOC45Njk3IDEuNzg0NjYgMTguNzY1NiAxLjc1NDE4QzE4LjU0NDIgMS43MTk2OCAxOC40NTc0IDEuOTA1NDEgMTguMzcwNSAyLjA2MDY3QzE4LjAyMzIgMi42OTU0OSAxNy44ODg3IDMuMzk0NzEgMTcuOTAxOSA0LjEwMzEzQzE3LjkzMjQgNS42OTY1IDE4LjYwNTEgNi45NjU1NiAxOS45NDIxIDcuODY4MzRDMjAuMDkzOSA3Ljk3MTg0IDIwLjEzMyA4LjA3NTM1IDIwLjA4NTIgOC4yMjY1OEMxOS45OTM4IDguNTM3NjYgMTkuODg1NyA4LjgzOTU1IDE5Ljc5MDMgOS4xNTA2M0MxOS43MjkzIDkuMzQ5MDEgMTkuNjM4NCA5LjM5MjcxIDE5LjQyNTcgOS4zMDU4OEMxOC42OTIgOC45OTk0IDE4LjA1ODMgOC41NDU3MSAxNy40OTgyIDcuOTk3NzJDMTYuNTQ3NyA3LjA3ODI3IDE1LjY4ODEgNi4wNjMzNiAxNC42MTYyIDUuMjY4NjlDMTQuMzY0NCA1LjA4Mjk2IDE0LjExMjUgNC45MTA0NSAxMy44NTIxIDQuNzQ2QzEyLjc1ODQgMy42ODM5NCAxMy45OTUyIDIuODExNjQgMTQuMjgxNiAyLjcwODE0QzE0LjU4MTIgMi42MDAwMyAxNC4zODU3IDIuMjI4NTcgMTMuNDE3OSAyLjIzMzE3QzEyLjQ1MDIgMi4yMzcyIDExLjU2NDYgMi41NjE1MSAxMC40MzU5IDIuOTkzMzVDMTAuMjcwOCAzLjA1ODMyIDEwLjA5NzIgMy4xMDU0NyA5LjkxOTUxIDMuMTQ0NTdDOC44OTU0IDIuOTUwMjIgNy44MzE2MiAyLjkwNzA5IDYuNzIwNjkgMy4wMzI0NUM0LjYyODc3IDMuMjY1MzMgMi45NTc3NyA0LjI1NDM2IDEuNzI5NTQgNS45NDI2MUMwLjI1NDA0MyA3Ljk3MTg0IC0wLjA5MzI2NzggMTAuMjc3NyAwLjMzMTY3IDEyLjY4MjRDMC43Nzg0NTggMTUuMjE3MSAyLjA3MjI1IDE3LjMxNTMgNC4wNjAwOCAxOC45NTU4QzYuMTIxNTIgMjAuNjU2NyA4LjQ5NTc3IDIxLjQ5MDUgMTEuMjA0NyAyMS4zMzA2QzEyLjg0OTggMjEuMjM1OCAxNC42ODEyIDIxLjAxNTUgMTYuNzQ3MyAxOS4yNjY5QzE3LjI2ODIgMTkuNTI2MiAxNy44MTUxIDE5LjYyOTcgMTguNzIxOSAxOS43MDc0QzE5LjQyMDUgMTkuNzcyMyAyMC4wOTMzIDE5LjY3MjkgMjAuNjE0MyAxOS41NjQ4QzIxLjQzMDIgMTkuMzkyMyAyMS4zNzM5IDE4LjYzNjcgMjEuMDc4OSAxOC40OTgxQzE4LjY4NzQgMTcuMzg0MyAxOS4yMTI0IDE3LjgzNzQgMTguNzM1MSAxNy40NzA2QzE5Ljk1MDEgMTYuMDMzIDIxLjgwNjMgMTMuNDc3NiAyMi4zNzkgOS45OTgyMUMyMi40MzUzIDkuNjE0MDkgMjIuNTA3MiA5LjA3MyAyMi40OTg2IDguNzYxOTJDMjIuNDk0IDguNTcyMTYgMjIuNTM3NyA4LjQ5ODU2IDIyLjc1NDUgOC40NzY3MUMyMy4zNTM2IDguNDA3NzEgMjMuOTM1IDguMjQzODMgMjQuNDY5MiA3Ljk0OTk5QzI2LjAxODggNy4xMDM1NyAyNi42NDM5IDUuNzEzMTggMjYuNzkxMSA0LjA0Njc4QzI2LjgxMjkgMy43OTIwNCAyNi43ODY1IDMuNTI4NjkgMjYuNTE3NCAzLjM5NDcxWk0xMy4wMTQzIDE4LjM5NDZDMTAuNjk2NCAxNi41NzI0IDkuNTcyMiAxNS45NzI2IDkuMTA4MTYgMTUuOTk4NUM4LjY3NDAyIDE2LjAyNDQgOC43NTIyMiAxNi41MjEyIDguODQ3NjggMTYuODQ0OUM4Ljk0NzczIDE3LjE2NDYgOS4wNzc2OCAxNy4zODQ5IDkuMjU5OTYgMTcuNjY1NUM5LjM4NTg5IDE3Ljg1MTIgOS40NzI3MiAxOC4xMjcyIDkuMTM0MDQgMTguMzM0OEM4LjM4NzY2IDE4Ljc5NjUgNy4wODk4NSAxOC4xNzk2IDcuMDI4OSAxOC4xNDkxQzUuNTE4MzMgMTcuMjU5NSA0LjI1NTU5IDE2LjA4NTMgMy4zNjU0NiAxNC40NzkzQzIuNTA1ODEgMTIuOTMzNyAyLjAwNjcgMTEuMjc1MyAxLjkyNDQ3IDkuNTA1NDJDMS45MDI2MiA5LjA3ODE4IDIuMDI4NTUgOC45MjY5NSAyLjQ1NDA2IDguODQ5MzJDMy4wMTQxMyA4Ljc0NTgyIDMuNTkxNDQgOC43MjM5NyA0LjE1MDkzIDguODA2MTlDNi41MTY1NiA5LjE1MTc4IDguNTMwMjcgMTAuMjA5MiAxMC4yMTg1IDExLjg4NDhDMTEuMTgyMiAxMi44Mzg4IDExLjkxMTQgMTMuOTc5IDEyLjY2MjMgMTUuMDkyOUMxMy40NjEgMTYuMjc1NyAxNC4zMjAxIDE3LjQwMjcgMTUuNDE0NCAxOC4zMjY4QzE1LjgwMDggMTguNjUwNSAxNi4xMDkgMTguODk2NiAxNi40MDQgMTkuMDc4M0MxNS41MTQ0IDE5LjE3NzggMTQuMDI5NyAxOS4xOTkxIDEzLjAxNDMgMTguMzk1OFYxOC4zOTQ2Wk0xNC4xMjUyIDExLjI0ODlDMTQuMTI1MiAxMS4wNTkxIDE0LjI3NyAxMC45MDc5IDE0LjQ2NzkgMTAuOTA3OUMxNC41MTEgMTAuOTA3OSAxNC41NTAxIDEwLjkxNjUgMTQuNTg1MiAxMC45MjkyQzE0LjYzMjkgMTAuOTQ2NCAxNC42NzY2IDEwLjk3MjMgMTQuNzExMSAxMS4wMTE0QzE0Ljc3MjEgMTEuMDcxOCAxNC44MDY2IDExLjE1OCAxNC44MDY2IDExLjI0ODlDMTQuODA2NiAxMS40Mzg2IDE0LjY1NDggMTEuNTg5OSAxNC40NjM5IDExLjU4OTlDMTQuMjczIDExLjU4OTkgMTQuMTI1MiAxMS40Mzg2IDE0LjEyNTIgMTEuMjQ4OVpNMTcuNTc1OSAxMy4wMTg4QzE3LjM1NDUgMTMuMTA5NiAxNy4xMzMxIDEzLjE4NzMgMTYuOTIwMyAxMy4xOTU5QzE2LjU5MDMgMTMuMjEzMSAxNi4yMzAzIDEzLjA3OTEgMTYuMDM0OCAxMi45MTUzQzE1LjczMTIgMTIuNjYwNSAxNS41MTM5IDEyLjUxNzkgMTUuNDIzIDEyLjA3MzRDMTUuMzgzOSAxMS44ODM3IDE1LjQwNTcgMTEuNTg5OSAxNS40NDAyIDExLjQyMTRDMTUuNTE4NSAxMS4wNTg1IDE1LjQzMTYgMTAuODI1NyAxNS4xNzU3IDEwLjYxNEMxNC45Njc2IDEwLjQ0MTUgMTQuNzAyNSAxMC4zOTM4IDE0LjQxMTUgMTAuMzkzOEMxNC4zMDI5IDEwLjM5MzggMTQuMjAzNCAxMC4zNDYxIDE0LjEyOTIgMTAuMzA3NkMxNC4wMDc5IDEwLjI0NzIgMTMuOTA3OCAxMC4wOTYgMTQuMDAzMyA5LjkxMDIzQzE0LjAzMzggOS44NDk4NSAxNC4xODE1IDkuNzAzMjIgMTQuMjE2IDkuNjc3MzRDMTQuNjExMSA5LjQ1MjUxIDE1LjA2NjUgOS41MjYxMiAxNS40ODggOS42OTQ2QzE1Ljg3ODQgOS44NTQ0NSAxNi4xNzQgMTAuMTQ3NyAxNi41OTg5IDEwLjU2MjNDMTcuMDMzIDExLjA2MzEgMTcuMTExMiAxMS4yMDExIDE3LjM1ODUgMTEuNTc3MkMxNy41NTQgMTEuODcxIDE3LjczMTcgMTIuMTcyOSAxNy44NTM2IDEyLjUxODVDMTcuOTI3MiAxMi43MzQxIDE3LjgzMTcgMTIuOTEwNyAxNy41NzU5IDEzLjAxODhaIiBmaWxsPSIjMzk2NEZFIi8+Cjwvc3ZnPgo='

    // DSH 桌面的麦克风权限只授予主框架（iframe 一律拒绝），
    // 所以录音放在宿主主框架做，面板 iframe 通过同源 window.top 取音频流。
    const installMicBridge = () => {
      try {
        window.__dshPanelMic = {
          async getStream() {
            if (!navigator.mediaDevices?.getUserMedia) throw new Error('麦克风不可用')
            return navigator.mediaDevices.getUserMedia({
              audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
            })
          },
        }
      } catch (_error) {
        // 非浏览器环境或跨源限制：面板会回退到自身 getUserMedia。
      }
    }
    // DSH 网页版的账号头像由 shell 自己渲染，没有暴露成 Slot。这里按位置找：
    // 侧栏左下角、16~64px 的 img，把 src 写进同源 localStorage，面板搜索结果的用户行直接读。
    const publishUserAvatar = () => {
      try {
        const findAvatar = () => {
          let found = null
          for (const img of document.querySelectorAll('img')) {
            const rect = img.getBoundingClientRect()
            if (rect.width < 16 || rect.width > 64 || rect.height < 16 || rect.height > 64) continue
            if (rect.left > 320 || rect.top < window.innerHeight - 160) continue
            const src = img.currentSrc || img.src
            if (src) found = src
          }
          return found
        }
        const apply = () => {
          const src = findAvatar()
          if (src !== null && window.localStorage.getItem('dsh:user-avatar') !== src) {
            window.localStorage.setItem('dsh:user-avatar', src)
          }
        }
        apply()
        if (typeof MutationObserver !== 'function') return undefined
        let scheduled = false
        const observer = new MutationObserver(() => {
          if (scheduled) return
          scheduled = true
          setTimeout(() => {
            scheduled = false
            apply()
          }, 200)
        })
        observer.observe(document.body, { childList: true, subtree: true })
        return () => observer.disconnect()
      } catch (_error) {
        return undefined
      }
    }
    // 导入完成后让面板重新加载一次，好让新会话出现在列表里。
    const importBus = { token: 0, listeners: new Set() }
    const notifyImported = () => {
      importBus.token += 1
      for (const listener of importBus.listeners) listener(importBus.token)
    }

    const frame = (key, src, title) => h('iframe', {
      key,
      src,
      title,
      allow: 'clipboard-write; microphone',
      style: { width: '100%', height: '100%', border: 'none', display: 'block', background: '#fff' },
    })

    /** 左侧面板：完整的网页版，带它自己的会话列表。 */
    function Panel() {
      const [token, setToken] = React.useState(importBus.token)
      React.useEffect(() => {
        const listener = (value) => setToken(value)
        importBus.listeners.add(listener)
        return () => importBus.listeners.delete(listener)
      }, [])
      return h('div', { style: { height: '100%', minHeight: 320, display: 'flex', flexDirection: 'column' } },
        h(ModelBar, null),
        h('div', { style: { flex: 1, minWidth: 0, minHeight: 0 } }, frame(token, '/webchat/', 'DeepSeek 网页版')))
    }

    /** 面板顶部模型选择条：DSH 同款两级菜单（provider 分组 + 搜索 + effort）。
     * 第一级：搜索框 + provider 分组模型列表；有 reasoning.efforts 的模型行
     * 右侧有 effort 入口，点进第二级选 effort。选择（模型 + effort）POST 到
     * /webchat/api/models，宿主落盘并透传 reasoningEffort。
     */
    function ModelBar() {
      const [state, setState] = React.useState({ groups: [], models: [], active: '', activeEffort: '', loading: true, dsh: false })
      const [saving, setSaving] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const [pane, setPane] = React.useState('model')
      const [query, setQuery] = React.useState('')
      const [activeIndex, setActiveIndex] = React.useState(0)
      const [effortTarget, setEffortTarget] = React.useState(null)
      const rootRef = React.useRef(null)
      const load = React.useCallback(() => {
        // 先读 DSH 同一份目录（与 DSH 聊天框同源）；失败回退插件 models 配置。
        fetch('/webchat/api/dsh-models')
          .then((response) => response.json())
          .then((body) => {
            if (body?.ok && Array.isArray(body.groups) && body.groups.length > 0) {
              const groups = body.groups
              const flat = []
              for (const group of groups) {
                for (const model of group.models ?? []) {
                  flat.push({ id: `${group.id}/${model.id}`, label: model.name, provider: group.name })
                }
              }
              const def = body.default
              const defId = def ? `${def.provider}/${def.model}` : (flat[0]?.id ?? '')
              setState({ groups, models: flat, active: defId, activeEffort: '', loading: false, dsh: true })
              return
            }
            throw new Error(body?.error ?? '无 DSH 目录')
          })
          .catch(() => fetch('/webchat/api/models')
            .then((response) => response.json())
            .then((body) => setState({
              groups: [],
              models: Array.isArray(body?.models) ? body.models : [],
              active: typeof body?.active === 'string' ? body.active : '',
              activeEffort: '',
              loading: false,
              dsh: false,
            }))
            .catch(() => setState((previous) => ({ ...previous, loading: false }))))
      }, [])
      React.useEffect(() => { load() }, [load])
      // 点外部关菜单。
      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) {
            setOpen(false)
            setPane('model')
          }
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [open ])
      const select = (id, effort) => {
        if (saving) return
        if (id === state.active && (effort ?? '') === (state.activeEffort ?? '')) {
          setOpen(false)
          return
        }
        setSaving(true)
        fetch('/webchat/api/models', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, ...(effort === undefined ? {} : { effort }) }),
        })
          .then((response) => response.json())
          .then((body) => {
            if (body?.ok) {
              setState((previous) => ({ ...previous, active: body.active, activeEffort: effort ?? '' }))
              setOpen(false)
              setPane('model')
            }
          })
          .catch(() => {})
          .finally(() => setSaving(false))
      }
      const q = normalizeQuery(query)
      const searching = q !== ''
      const hasEfforts = (model) => Array.isArray(model.reasoning?.efforts) && model.reasoning.efforts.length > 0
      // 分组视图：标题命中时整组保留（标题高亮），否则只留命中的模型；
      // 组内一个都不剩的组直接消失，和 DSH 的分组标题行为一致。
      const groupsView = state.groups.map((group) => {
        const models = Array.isArray(group.models) ? group.models : []
        if (!searching) return { group, titleIndices: [], models: models.map((model) => ({ model, indices: [] })) }
        const title = matchText(group.name ?? group.id, q)
        if (title !== undefined) {
          return { group, titleIndices: title.indices, models: models.map((model) => ({ model, indices: [] })) }
        }
        const hits = models.map((model, order) => {
          const hit = matchText(model.name ?? '', q) ?? matchText(model.id ?? '', q)
          return hit === undefined ? undefined : { model, indices: hit.indices, score: hit.score, order }
        }).filter((hit) => hit !== undefined)
        hits.sort((left, right) => left.score - right.score || left.order - right.order)
        return { group, titleIndices: [], models: hits }
      }).filter((entry) => entry.models.length > 0)
      // 没有 provider 分组时退回插件目录，同样按关键字过滤。
      const flatView = state.models.map((item, order) => {
        if (!searching) return { item, indices: [], score: 0, order }
        const hit = matchText(item.label ?? '', q) ?? matchText(item.id ?? '', q)
        return hit === undefined ? undefined : { item, indices: hit.indices, score: hit.score, order }
      }).filter((row) => row !== undefined)
      flatView.sort((left, right) => left.score - right.score || left.order - right.order)
      // 键盘上下键走的是这条扁平序列，和画出来的顺序一致。
      const visibleRows = groupsView.length > 0
        ? groupsView.flatMap((entry) => entry.models.map((row) => ({
          group: entry.group,
          model: row.model,
          id: `${entry.group.id}/${row.model.id}`,
          hasEffort: hasEfforts(row.model),
        })))
        : flatView.map((row) => ({ group: null, model: row.item, id: row.item.id, hasEffort: false }))
      const activeRow = visibleRows.length === 0
        ? undefined
        : visibleRows[Math.min(activeIndex, visibleRows.length - 1)]
      const chooseRow = (row) => {
        if (row.group === null) {
          select(row.id)
          return
        }
        if (row.hasEffort) {
          setEffortTarget({ group: row.group, model: row.model })
          setPane('effort')
          return
        }
        select(row.id)
      }
      const marked = (text, indices) => highlightSegments(text, indices).map((segment, index) => (
        segment.hit
          ? h('mark', { key: index, style: { background: '#fde68a', color: 'inherit', borderRadius: 2 } }, segment.text)
          : segment.text))
      const activeLabel = (() => {
        for (const group of state.groups) {
          for (const model of group.models ?? []) {
            if (`${group.id}/${model.id}` === state.active) return model.name
          }
        }
        return state.models.find((item) => item.id === state.active)?.label ?? state.active
      })()
      const barStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        borderBottom: '1px solid #e5e7eb',
        background: '#fff',
        fontSize: 12,
        color: '#6b7280',
        flex: 'none',
        position: 'relative',
      }
      const triggerStyle = {
        font: 'inherit',
        maxWidth: '100%',
        padding: '2px 6px',
        borderRadius: 6,
        border: '1px solid #d0d7de',
        background: '#fff',
        color: '#1f2328',
        cursor: 'pointer',
      }
      const menuStyle = {
        position: 'absolute',
        top: '100%',
        left: 8,
        zIndex: 50,
        width: 300,
        maxHeight: 320,
        overflow: 'auto',
        background: '#fff',
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
        padding: 4,
        color: '#1f2328',
        fontSize: 12,
      }
      const emptyStyle = { padding: '8px', color: '#9ca3af' }
      const rowStyle = (selected) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        textAlign: 'left',
        padding: '6px 8px',
        border: 'none',
        borderRadius: 6,
        background: selected ? '#f5f8ff' : 'transparent',
        cursor: 'pointer',
        font: 'inherit',
        color: 'inherit',
      })
      // 第二级：effort 列表。
      const effortPane = () => {
        if (effortTarget === null) return null
        const efforts = effortTarget.model.reasoning?.efforts ?? []
        return h('div', null,
          h('button', {
            type: 'button',
            style: rowStyle(false),
            onClick: () => setPane('model'),
          }, '‹ 返回模型列表'),
          h('div', { style: { padding: '4px 8px', color: '#6b7280' } },
            `${effortTarget.group.name} / ${effortTarget.model.name}`),
          efforts.length === 0
            ? h('div', { role: 'status', style: emptyStyle }, '当前模型未提供推理等级。')
            : efforts.map((effort) => h('button', {
              key: effort.id,
              type: 'button',
              style: rowStyle(false),
              onClick: () => select(`${effortTarget.group.id}/${effortTarget.model.id}`, effort.id),
            }, effort.name ?? effort.id)))
      }
      // 第一级：搜索 + 分组模型列表。
      const modelPane = () => {
        let cursor = 0
        const rows = groupsView.length > 0
          ? groupsView.map((entry) => h('div', { key: entry.group.id },
            h('div', { style: { padding: '6px 8px 2px', color: '#9ca3af' } }, marked(entry.group.name ?? entry.group.id, entry.titleIndices)),
            entry.models.map((row) => {
              const id = `${entry.group.id}/${row.model.id}`
              const selected = id === state.active
              const highlighted = cursor++ === activeIndex
              return h('div', { key: id, style: { display: 'flex', alignItems: 'center' } },
                h('button', {
                  type: 'button',
                  style: { ...rowStyle(selected), ...(highlighted ? { background: '#eef2ff' } : {}), flex: 1 },
                  onClick: () => chooseRow({ group: entry.group, model: row.model, id, hasEffort: hasEfforts(row.model) }),
                },
                h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  marked(row.model.name ?? row.model.id, row.indices)),
                selected ? h('span', null, '✓') : null),
                hasEfforts(row.model) ? h('button', {
                  type: 'button',
                  title: '选择 effort',
                  'aria-label': `为 ${row.model.name} 选择 effort`,
                  style: { ...rowStyle(false), flex: 'none', padding: '6px 4px' },
                  onClick: () => {
                    setEffortTarget({ group: entry.group, model: row.model })
                    setPane('effort')
                  },
                }, '›') : null)
            })))
          : flatView.map((row) => {
            const highlighted = cursor++ === activeIndex
            return h('button', {
              key: row.item.id,
              type: 'button',
              style: { ...rowStyle(row.item.id === state.active), ...(highlighted ? { background: '#eef2ff' } : {}) },
              onClick: () => select(row.item.id),
            }, marked(`${row.item.label ?? row.item.id}${row.item.default ? '（默认）' : ''}`, row.indices))
          })
        return h('div', null,
          h('div', { style: { position: 'relative', marginBottom: 4 } },
            h('input', {
              value: query,
              placeholder: '搜索模型…',
              'aria-label': '搜索模型',
              role: 'searchbox',
              'aria-controls': 'chat-in-dsh-model-list',
              onChange: (event) => {
                setQuery(event.target.value)
                setActiveIndex(0)
              },
              onKeyDown: (event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  if (visibleRows.length === 0) return
                  const step = event.key === 'ArrowDown' ? 1 : -1
                  setActiveIndex((current) => (current + step + visibleRows.length) % visibleRows.length)
                  return
                }
                if (event.key === 'Enter') {
                  event.preventDefault()
                  if (activeRow !== undefined) chooseRow(activeRow)
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  if (query !== '') {
                    setQuery('')
                    setActiveIndex(0)
                  } else {
                    setOpen(false)
                    setPane('model')
                  }
                }
              },
              style: {
                font: 'inherit', width: '100%', boxSizing: 'border-box',
                padding: '6px 8px', paddingRight: query === '' ? 8 : 28,
                borderRadius: 6, border: '1px solid #d0d7de',
              },
            }),
            query === ''
              ? null
              : h('button', {
                type: 'button',
                'aria-label': '清除搜索',
                title: '清除搜索',
                onClick: () => {
                  setQuery('')
                  setActiveIndex(0)
                },
                style: {
                  position: 'absolute', top: '50%', right: 4, transform: 'translateY(-50%)',
                  width: 20, height: 20, padding: 0, border: 'none', borderRadius: '50%',
                  background: 'transparent', color: '#6b7280', cursor: 'pointer', font: 'inherit', lineHeight: 1,
                },
              }, '×')),
          h('div', { id: 'chat-in-dsh-model-list', role: 'group' },
            visibleRows.length > 0
              ? rows
              : h('div', { role: 'status', style: emptyStyle },
                state.models.length === 0 ? '暂无可用模型' : '没有匹配的模型。')))
      }
      return h('div', { ref: rootRef, style: barStyle, title: '网页版使用哪个模型（与 DSH 聊天框同一份目录）' },
        h('span', null, '模型'),
        h('button', {
          type: 'button',
          style: triggerStyle,
          disabled: state.loading || state.models.length === 0,
          'aria-label': '网页版使用哪个模型',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          onClick: () => { setOpen(!open); setPane('model') },
        }, saving ? '切换中…' : (activeLabel === '' ? '选择模型' : activeLabel)),
        open ? h('div', { role: 'menu', style: menuStyle }, pane === 'effort' ? effortPane() : modelPane()) : null,
        state.activeEffort !== '' ? h('span', { style: { color: '#6b7280' } }, `effort: ${state.activeEffort}`) : null,
        state.dsh ? h('span', { style: { color: '#9ca3af' } }, '与 DSH 聊天框同款目录') : null)
    }

    /** 会话菜单里的图标：一个"导入到托盘"的线性图标，风格对齐宿主其它条目。 */
    function ImportIcon() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M8 2.5v6.2' }),
        h('path', { d: 'M5.4 6.3 8 8.9l2.6-2.6' }),
        h('path', { d: 'M3 10.4v1.8c0 .8.6 1.4 1.4 1.4h7.2c.8 0 1.4-.6 1.4-1.4v-1.8' }))
    }
    /** 侧栏图标；size 由侧栏按宽窄状态给出。 */
    function PanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h('img', {
        src: PANEL_ICON,
        alt: 'DeepSeek',
        style: { height: size, width: size, objectFit: 'contain', display: 'block' },
      })
    }

    return {
      inject: ['slots', 'layout', 'contextMenus'],
      apply(ctx) {
        installMicBridge()
        const stopAvatar = publishUserAvatar()

        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'chat-in-dsh',
        }, Panel)), 'webchat.panel')

        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'chat-in-dsh',
          order: 20,
          label: '网页版',
        }, PanelIcon)), 'webchat.panellist')

        ctx.effect(() => ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
          name: 'contextMenu.icon',
          key: 'chat-in-dsh',
        }, ImportIcon)), 'webchat.import-icon')
        // 会话菜单：注册成正规条目，样式、键盘操作、选中后收起都交给宿主。
        ctx.effect(() => ctx.contextMenus.register({
          id: 'chat-in-dsh',
          target: 'session',
          order: 10,
          resolve: (target) => [{
            id: 'chat-in-dsh:import',
            label: '导入到网页版',
            icon: { key: 'chat-in-dsh' },
            afterContent: true,
            run: async () => {
              const response = await fetch('/webchat/api/import/stage', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId: String(target.sessionId) }),
              })
              if (!response.ok) throw new Error(`stage failed: ${response.status}`)
              notifyImported()
              ctx.layout.selectPanel('chat-in-dsh')
              ctx.contextMenus.notify('已导入到网页版', true)
            },
            failureLabel: '导入失败',
          }],
        }), 'webchat.import')

        ctx.effect(() => () => {
          if (window.__dshPanelMic !== undefined) delete window.__dshPanelMic
        }, 'webchat.mic-bridge')

        ctx.effect(() => () => {
          stopAvatar?.()
        }, 'webchat.avatar')
      },
    }
  },
})


