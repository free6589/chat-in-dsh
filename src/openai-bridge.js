/**
 * Anthropic Messages ↔ OpenAI Chat Completions 的桥。
 *
 * 网页版前端只会说 Anthropic 协议（`/anthropic/v1/messages` + Anthropic SSE），
 * 而非 DeepSeek 的上游大多是 OpenAI 协议。这里做两件事：
 *   1. 请求：把 Anthropic 请求体翻成 OpenAI chat.completions（只翻网页版真的会发的字段）；
 *   2. 响应：把 OpenAI 的分块流翻回 Anthropic 的 message_start / content_block_* / message_delta / message_stop，
 *      思考内容翻成 thinking 块（`reasoning_content`），前端本来就能渲染。
 *
 * 网页版扩展字段（`safety_check` / `tools` / `title`）只对官方上游有意义，
 * 桥里一律丢掉，否则普通 OpenAI 网关会直接 400。
 */

/** 把 Anthropic 的 content 数组压成 OpenAI 的 content。 */
function contentToOpenAI(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image' && block.source?.type === 'base64') {
      const media = typeof block.source.media_type === 'string' ? block.source.media_type : 'image/png'
      parts.push({ type: 'image_url', image_url: { url: `data:${media};base64,${block.source.data}` } })
    }
    // document / tool_use / tool_result / thinking：上游没有对应物，丢掉。
  }
  if (parts.length === 0) return ''
  if (parts.every(part => part.type === 'text')) return parts.map(part => part.text).join('\n')
  return parts
}

/** 系统提示词：字符串或文本块数组。 */
function systemToOpenAI(system) {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * Anthropic 请求里的 effort 选择。
 *
 * 网页版协议本身没有 effort 字段，面板在 thinking 开关旁边加的选择放在
 * 顶层 `effort`，也接受 `thinking.effort`（跟着 reasoning 配置走）。
 * 这里只做读取和去空白：取值集合由上游模型目录决定，未知值原样透传，
 * 不校验、不做同义词映射。没有选择时返回 undefined。
 */
export function effortOf(body) {
  for (const raw of [body?.effort, body?.thinking?.effort]) {
    if (typeof raw !== 'string') continue
    const value = raw.trim()
    if (value !== '') return value
  }
  return undefined
}

/**
 * Anthropic 请求体 → OpenAI chat.completions 请求体。
 * @param {object} body 浏览器发来的 Anthropic 请求
 * @param {{ id: string, upstreamModel?: string }} entry 目录项
 */
export function toOpenAIRequest(body, entry) {
  const messages = []
  const system = systemToOpenAI(body?.system)
  if (system !== '') messages.push({ role: 'system', content: system })
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const content = contentToOpenAI(message.content)
    if (content === '' || (Array.isArray(content) && content.length === 0)) continue
    messages.push({ role: message.role, content })
  }
  const payload = {
    model: entry.upstreamModel ?? entry.id,
    messages,
    stream: body?.stream !== false,
  }
  if (typeof body?.max_tokens === 'number' && body.max_tokens > 0) payload.max_tokens = body.max_tokens
  if (typeof body?.temperature === 'number') payload.temperature = body.temperature
  if (typeof body?.top_p === 'number') payload.top_p = body.top_p
  if (typeof body?.stop_sequences === 'string') payload.stop = body.stop_sequences
  else if (Array.isArray(body?.stop_sequences) && body.stop_sequences.length > 0) payload.stop = body.stop_sequences
  // 选了 effort 才带上：没选就与 v1.4.0 的请求体逐字节一致。
  const effort = effortOf(body)
  if (effort !== undefined) payload.reasoning_effort = effort
  return payload
}

/** 一条 Anthropic SSE 帧。 */
function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** OpenAI finish_reason → Anthropic stop_reason。 */
function stopReason(reason) {
  if (reason === 'length') return 'max_tokens'
  return 'end_turn'
}

/**
 * OpenAI 分块流 → Anthropic SSE 帧。
 * @param {{ model: string, thinking?: boolean }} options
 */
export function createAnthropicStream({ model, thinking = false }) {
  let index = 0
  let open = null
  let started = false
  let stopped = false
  let sawText = false
  let usage = { input_tokens: 0, output_tokens: 0 }

  const closeBlock = () => {
    if (open === null) return []
    const frame = sse('content_block_stop', { type: 'content_block_stop', index })
    open = null
    index += 1
    return [frame]
  }

  const openBlock = (kind) => {
    const frames = []
    if (kind === 'thinking') {
      frames.push(sse('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '' },
      }))
    } else {
      frames.push(sse('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      }))
    }
    open = kind
    return frames
  }

  /** 收尾：补 message_delta + message_stop（幂等）。 */
  const finish = (reason) => {
    if (stopped) return []
    stopped = true
    const frames = [...closeBlock()]
    frames.push(sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason(reason), stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    }))
    frames.push(sse('message_stop', { type: 'message_stop' }))
    return frames
  }

  return {
    /** message_start：网页版要先拿到消息外壳才开始渲染。 */
    start() {
      if (started) return []
      started = true
      return [sse('message_start', {
        type: 'message_start',
        message: {
          id: `msg_${Date.now().toString(36)}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage,
        },
      })]
    },
    /** 处理一个 OpenAI chunk，返回要写给浏览器的帧。 */
    onChunk(chunk) {
      if (chunk === null || typeof chunk !== 'object') return []
      if (chunk.error !== undefined) {
        return [sse('error', {
          type: 'error',
          error: {
            type: 'api_error',
            message: String(chunk.error?.message ?? '上游返回错误'),
          },
        })]
      }
      const frames = []
      if (chunk.usage !== null && typeof chunk.usage === 'object') {
        if (typeof chunk.usage.prompt_tokens === 'number') usage.input_tokens = chunk.usage.prompt_tokens
        if (typeof chunk.usage.completion_tokens === 'number') usage.output_tokens = chunk.usage.completion_tokens
      }
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
      const delta = choice?.delta
      if (delta !== undefined && delta !== null) {
        const reasoning = typeof delta.reasoning_content === 'string' && delta.reasoning_content !== ''
          ? delta.reasoning_content
          : (typeof delta.reasoning === 'string' ? delta.reasoning : '')
        if (reasoning !== '' && thinking && !sawText) {
          if (open !== 'thinking') {
            frames.push(...closeBlock())
            frames.push(...openBlock('thinking'))
          }
          frames.push(sse('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'thinking_delta', thinking: reasoning },
          }))
        }
        const text = typeof delta.content === 'string' ? delta.content : ''
        if (text !== '') {
          sawText = true
          if (open !== 'text') {
            frames.push(...closeBlock())
            frames.push(...openBlock('text'))
          }
          frames.push(sse('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text },
          }))
        }
      }
      if (choice?.finish_reason !== null && choice?.finish_reason !== undefined) {
        frames.push(...finish(choice.finish_reason))
      }
      return frames
    },
    finish,
  }
}

/** 非流式响应：OpenAI JSON → Anthropic message JSON。 */
export function toAnthropicMessage(json, { model, thinking = false }) {
  const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined
  const message = choice?.message ?? {}
  const content = []
  const reasoning = typeof message.reasoning_content === 'string' && message.reasoning_content !== ''
    ? message.reasoning_content
    : (typeof message.reasoning === 'string' ? message.reasoning : '')
  if (reasoning !== '' && thinking) content.push({ type: 'thinking', thinking: reasoning })
  if (typeof message.content === 'string' && message.content !== '') {
    content.push({ type: 'text', text: message.content })
  }
  return {
    id: typeof json?.id === 'string' ? json.id : `msg_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: json?.usage?.prompt_tokens ?? 0,
      output_tokens: json?.usage?.completion_tokens ?? 0,
    },
  }
}
