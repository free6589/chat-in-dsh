/**
 * 经 DSH 的 live registry 派发网页版请求。
 *
 * 面板下拉现在与 DSH 聊天框同源（`ctx.llm` 的 provider/model 目录）。
 * 选中 `provider/model` 后，不再走插件自建的 baseURL + 自带 Key，
 * 而是 `ctx.llm.prepareCall(provider, model)` 绑定一代 adapter，
 * 再 `stream(options)` 出块，翻成网页版要的 Anthropic SSE。
 *
 * 网页版请求（Anthropic Messages）→ DSH GenerateOptions：
 *   - system → options.system（字符串；数组压平）
 *   - user 文本 → RequestUserInput[]（assistant 历史压成带说话人前缀的 user 上下文，
 *     因 RequestUserInput 只有 user role；图片暂不支持，走旧桥/直通路径）
 *   - max_tokens/temperature/top_p/stop_sequences → 同名字段
 *   - 网页版选了 effort（顶层 `effort` 或 `thinking.effort`）→ reasoningEffort；
 *     没选才回退目录默认值（`entry.reasoningEffort`），两者都没有就不带该字段
 * DSH StreamChunk → Anthropic SSE：text-delta → text_delta，
 * reasoning-delta → thinking_delta，其余丢掉；收尾补 message_delta + message_stop。
 */
import { createAnthropicStream, effortOf } from './openai-bridge.js'

/** Anthropic content → 纯文本（DSH 文本块）。 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block !== null && typeof block === 'object'
      && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/** system → 字符串。 */
function systemText(system) {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return undefined
  const text = system
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
  return text === '' ? undefined : text
}

/**
 * 网页版 Anthropic 请求体 → DSH GenerateOptions（provider/model 由调用方填）。
 * @returns {{ messages: Array<object>, system?: string, maxTokens?: number, temperature?: number, top_p?: number, stop?: Array<string> }}
 */
export function toGenerateInput(body) {
  const messages = []
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message === null || typeof message !== 'object') continue
    const text = textOf(message.content)
    if (text === '') continue
    if (message.role === 'user') {
      messages.push({ role: 'user', content: [{ type: 'text', text }] })
    } else if (message.role === 'assistant') {
      // RequestUserInput 只有 user role：assistant 历史压成带前缀的 user 上下文。
      messages.push({ role: 'user', content: [{ type: 'text', text: `助手上一轮回复：${text}` }] })
    }
  }
  const input = { messages }
  const system = systemText(body?.system)
  if (system !== undefined) input.system = system
  if (typeof body?.max_tokens === 'number' && body.max_tokens > 0) input.maxTokens = body.max_tokens
  if (typeof body?.temperature === 'number') input.temperature = body.temperature
  if (typeof body?.top_p === 'number') input.top_p = body.top_p
  if (typeof body?.stop_sequences === 'string') input.stop = [body.stop_sequences]
  else if (Array.isArray(body?.stop_sequences) && body.stop_sequences.length > 0) {
    input.stop = body.stop_sequences.filter(item => typeof item === 'string')
  }
  return input
}

/**
 * DSH StreamChunk 流 → 写 Anthropic SSE 给浏览器。
 * @param {AsyncIterable<object>} chunks ctx.llm prepareCall 后 stream() 的块流
 * @param {object} res Node 响应
 * @param {{ model: string, thinking: boolean }} options
 */
export async function pipeDshStream(chunks, res, { model, thinking }) {
  const stream = createAnthropicStream({ model, thinking })
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const write = frames => {
    for (const frame of frames) res.write(frame)
  }
  write(stream.start())
  let stopped = false
  try {
    for await (const chunk of chunks) {
      if (chunk === null || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        write(stream.onChunk({ choices: [{ delta: { content: chunk.text } }] }))
      } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        write(stream.onChunk({ choices: [{ delta: { reasoning_content: chunk.text } }] }))
      } else if (chunk.type === 'error') {
        write(stream.onChunk({ error: { message: String(chunk.message ?? '上游返回错误') } }))
      } else if (chunk.type === 'finish' || chunk.type === 'aborted') {
        write(stream.finish('stop'))
        stopped = true
        break
      }
    }
  } catch (error) {
    write(stream.onChunk({ error: { message: String(error?.message ?? error) } }))
  }
  if (!stopped) write(stream.finish('stop'))
  res.end()
}

/**
 * 一次 DSH 派发：绑定 adapter → 流式回 Anthropic SSE。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} req Node 请求（已读过 body 传进来也行，这里自己读）
 */
export async function proxyDshDispatch(ctx, rawBody, res, { provider, model, reasoningEffort }) {
  let body
  try {
    body = JSON.parse(rawBody.toString('utf8') || '{}')
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: { message: '请求体不是合法 JSON' } }))
    return
  }
  const thinking = body?.thinking?.type !== 'disabled'
  // 网页版下发的 effort 优先；没下发才用目录默认值。
  const effort = effortOf(body) ?? reasoningEffort
  const input = toGenerateInput(body)
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })
  const config = {
    provider,
    model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    ...input,
  }
  let prepared
  try {
    prepared = await ctx.llm.prepareCall(config, controller.signal)
  } catch (error) {
    const message = String(error?.message ?? error)
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message: `[${provider}/${model}] prepareCall 失败：${message}`.slice(0, 500) },
    }))
    return
  }
  try {
    await pipeDshStream(
      // 显式带上 effort：adapter 的 prepared.config 若丢了未知字段，stream 这一跳也还能看到选择。
      prepared.stream({
        ...prepared.config,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        signal: controller.signal,
      }),
      res,
      { model: `${provider}/${model}`, thinking }
    )
  } catch (error) {
    if (!res.headersSent) {
      const message = String(error?.message ?? error)
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: `[${provider}/${model}] 派发失败：${message}`.slice(0, 500) },
      }))
    } else {
      res.destroy()
    }
  }
}

/**
 * 自检的 DSH 侧：对当前选择的 provider/model 做一次最小派发（maxTokens 16，非流式收尾），
 * 确认 prepareCall + stream 能通。返回的 detail 带 provider/model，失败带真实错误。
 */
export async function selfTestDshDispatch(ctx, entry) {
  const provider = entry.provider
  const model = entry.upstreamModel ?? String(entry.id).split('/').slice(1).join('/') ?? entry.id
  const timeout = (ms) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`超时 ${ms}ms`)), ms)
    if (typeof timer.unref === 'function') timer.unref()
    return controller.signal
  }
  try {
    const config = {
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：收到' }] }],
      maxTokens: 64,
    }
    const prepared = await ctx.llm.prepareCall(config, timeout(60_000))
    const stream = prepared.stream({
      ...prepared.config,
      signal: timeout(120_000),
    })
    let text = ''
    let count = 0
    for await (const chunk of stream) {
      count += 1
      if (count > 200) break
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk?.type === 'finish' || chunk?.type === 'aborted') break
    }
    const ok = text.trim() !== ''
    return { ok, detail: ok ? `${provider}/${model} · ${text.trim().slice(0, 60)}` : `${provider}/${model} · 空回复` }
  } catch (error) {
    return { ok: false, detail: `${provider}/${model} · ${String(error?.message ?? error).slice(0, 300)}` }
  }
}
