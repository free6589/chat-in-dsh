import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAnthropicStream, effortOf, toAnthropicMessage, toOpenAIRequest } from '../src/openai-bridge.js'

const entry = { id: 'glm-5.3-flash', upstreamModel: 'agent2api/glm-5.3-flash', api: 'openai', baseURL: 'http://127.0.0.1:18088/openai/v1' }

test('请求翻译：system、消息正文、max_tokens、stream、上游模型名', () => {
  const payload = toOpenAIRequest({
    model: 'deepseek-flash',
    system: '该助手为DeepSeek',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '想一下' }, { type: 'text', text: '在' }] },
      { role: 'user', content: [{ type: 'text', text: '第二句' }] },
    ],
    max_tokens: 256,
    stream: true,
  }, entry)
  assert.equal(payload.model, 'agent2api/glm-5.3-flash')
  assert.equal(payload.stream, true)
  assert.equal(payload.max_tokens, 256)
  assert.deepEqual(payload.messages, [
    { role: 'system', content: '该助手为DeepSeek' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '在' },
    { role: 'user', content: '第二句' },
  ])
})

test('请求翻译：没有 upstreamModel 时用目录 id', () => {
  const payload = toOpenAIRequest({ messages: [{ role: 'user', content: 'hi' }] }, { id: 'plain' })
  assert.equal(payload.model, 'plain')
  assert.equal(payload.stream, true)
})

test('请求翻译：丢掉网页版对官方上游才有效的扩展字段', () => {
  const payload = toOpenAIRequest({
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'hi' }],
    safety_check: { level: 'high' },
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    title: { enabled: true },
    thinking: { type: 'enabled' },
  }, entry)
  assert.equal('safety_check' in payload, false)
  assert.equal('tools' in payload, false)
  assert.equal('title' in payload, false)
  assert.equal('thinking' in payload, false)
})

test('请求翻译：图片块转成 data URI，文档块丢掉', () => {
  const payload = toOpenAIRequest({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'document', source: { type: 'file', file_id: 'f1' } },
      ],
    }],
  }, entry)
  const content = payload.messages[0].content
  assert.equal(content[0].type, 'text')
  assert.equal(content[1].type, 'image_url')
  assert.equal(content[1].image_url.url, 'data:image/png;base64,AAAA')
  assert.equal(content.length, 2)
})

test('流翻译：先 message_start，思考进 thinking 块，正文进 text 块', () => {
  const stream = createAnthropicStream({ model: 'glm', thinking: true })
  const frames = [...stream.start()]
  assert.match(frames[0], /event: message_start/u)
  assert.match(frames[0], /"type":"message"/u)

  frames.push(...stream.onChunk({ choices: [{ delta: { reasoning_content: '想一想' } }] }))
  frames.push(...stream.onChunk({ choices: [{ delta: { content: '收' } }] }))
  frames.push(...stream.onChunk({ choices: [{ delta: { content: '到' } }] }))
  frames.push(...stream.onChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }))

  const text = frames.join('')
  assert.match(text, /content_block_start[^]*"type":"thinking"[^]*thinking_delta[^]*想一想/u)
  assert.match(text, /"type":"text_delta","text":"收"/u)
  assert.match(text, /"type":"text_delta","text":"到"/u)
  assert.match(text, /"stop_reason":"end_turn"/u)
  assert.match(text, /event: message_stop/u)
  // 思考块在正文开始前就要关掉：thinking 与 text 各一个 content_block_stop 帧。
  assert.equal((text.match(/event: content_block_stop/gu) ?? []).length, 2)
})

test('流翻译：thinking 关闭时不产出 thinking 块', () => {
  const stream = createAnthropicStream({ model: 'glm', thinking: false })
  const frames = [...stream.start(), ...stream.onChunk({ choices: [{ delta: { reasoning_content: '不该出现', content: '答' } }] })]
  const text = frames.join('')
  assert.equal(text.includes('thinking_delta'), false)
  assert.match(text, /"type":"text_delta","text":"答"/u)
})

test('流翻译：finish 幂等，重复调用只出一次 message_stop', () => {
  const stream = createAnthropicStream({ model: 'glm' })
  stream.start()
  const first = stream.finish('length').join('')
  const second = stream.finish('length').join('')
  assert.match(first, /"stop_reason":"max_tokens"/u)
  assert.equal(second, '')
})

test('流翻译：上游错误转成 Anthropic error 帧', () => {
  const stream = createAnthropicStream({ model: 'glm' })
  stream.start()
  const frames = stream.onChunk({ error: { message: '上游炸了' } }).join('')
  assert.match(frames, /event: error/u)
  assert.match(frames, /上游炸了/u)
})

test('非流式响应翻译成 Anthropic message', () => {
  const message = toAnthropicMessage({
    id: 'x',
    choices: [{ message: { content: '收到', reasoning_content: '想' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 5 },
  }, { model: 'glm', thinking: true })
  assert.equal(message.type, 'message')
  assert.equal(message.role, 'assistant')
  assert.equal(message.stop_reason, 'end_turn')
  assert.deepEqual(message.content, [
    { type: 'thinking', thinking: '想' },
    { type: 'text', text: '收到' },
  ])
  assert.deepEqual(message.usage, { input_tokens: 3, output_tokens: 5 })
})

test('effort 透传：顶层 effort 翻成 reasoning_effort', () => {
  const payload = toOpenAIRequest({
    messages: [{ role: 'user', content: 'hi' }],
    effort: ' high ',
  }, entry)
  assert.equal(payload.reasoning_effort, 'high')
})

test('effort 透传：thinking.effort 同样生效，未知取值原样透传', () => {
  const payload = toOpenAIRequest({
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', effort: 'max' },
  }, entry)
  assert.equal(payload.reasoning_effort, 'max')
})

test('effort 缺省：请求体里不多出 reasoning_effort 字段（与 v1.4.0 一致）', () => {
  const payload = toOpenAIRequest({
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled' },
  }, entry)
  assert.equal('reasoning_effort' in payload, false)
  assert.deepEqual(Object.keys(payload).sort(), ['messages', 'model', 'stream'])
})

test('effort 读取：空串与非字符串按缺省处理', () => {
  assert.equal(effortOf({}), undefined)
  assert.equal(effortOf({ effort: '   ' }), undefined)
  assert.equal(effortOf({ effort: 3 }), undefined)
  assert.equal(effortOf({ thinking: { effort: '' } }), undefined)
  assert.equal(effortOf({ effort: 'low', thinking: { effort: 'high' } }), 'low')
  assert.equal(effortOf({ thinking: { effort: ' high ' } }), 'high')
})
