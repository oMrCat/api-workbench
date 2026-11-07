import { describe, it, expect } from 'vitest'
import { AnthropicMessagesAdapter } from '../../src/main/protocols/anthropic-messages'
import type { ProviderConfig } from '@shared/types'

const adapter = new AnthropicMessagesAdapter()
const provider: ProviderConfig = {
  id: 'p',
  name: 'x',
  baseUrl: 'https://api.anthropic-compatible.example',
  protocol: 'anthropic-messages',
  headers: [],
  timeoutMs: 60000,
  createdAt: 0,
  updatedAt: 0
}

describe('Anthropic Messages 适配器(P1)', () => {
  it('请求头使用 x-api-key + anthropic-version(非 Authorization Bearer)', () => {
    const built = adapter.buildChatRequest(provider, 'sk-test-key-123', {
      model: 'claude-mock',
      prompt: '你好',
      stream: false
    })
    expect(built.url).toBe('https://api.anthropic-compatible.example/v1/messages')
    expect(built.headers['x-api-key']).toBe('sk-test-key-123')
    expect(built.headers['anthropic-version']).toBe('2023-06-01')
    expect(built.headers['Authorization']).toBeUndefined()
  })

  it('max_tokens 必填:未设置时补 1024(协议要求,非静默扩展)', () => {
    const body = JSON.parse(adapter.buildChatRequest(provider, 'k', { model: 'm', prompt: 'p', stream: false }).body!)
    expect(body.max_tokens).toBe(1024)
    const body2 = JSON.parse(
      adapter.buildChatRequest(provider, 'k', { model: 'm', prompt: 'p', stream: false, maxTokens: 64 }).body!
    )
    expect(body2.max_tokens).toBe(64)
  })

  it('未设置的字段不发送(参数最小化)', () => {
    const body = JSON.parse(adapter.buildChatRequest(provider, 'k', { model: 'm', prompt: 'p', stream: false }).body!)
    expect(body.temperature).toBeUndefined()
    expect(body.system).toBeUndefined()
  })

  it('流式事件:content_block_delta 提取文本增量', () => {
    const r = adapter.handleStreamEvent({
      data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}'
    })
    expect(r.delta).toBe('你好')
    expect(r.firstContent).toBe(true)
  })

  it('流式事件:message_start 捕获输入用量,message_stop 判定完成', () => {
    const start = adapter.handleStreamEvent({
      data: '{"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}'
    })
    expect(start.usage).toEqual({ input_tokens: 10, output_tokens: 0 })
    const stop = adapter.handleStreamEvent({ data: '{"type":"message_stop"}' })
    expect(stop.done).toBe(true)
  })

  it('流式错误事件(error type)正确归类', () => {
    const r = adapter.handleStreamEvent({
      data: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
    })
    expect(r.error?.message).toBe('Overloaded')
    expect(r.error?.code).toBe('overloaded_error')
  })

  it('非流式:content 分段数组拼接,type:"message" 校验', () => {
    const r = adapter.parseNonStreamResponse(
      JSON.stringify({
        type: 'message',
        content: [
          { type: 'text', text: '第一段' },
          { type: 'text', text: '第二段' }
        ],
        usage: { input_tokens: 5, output_tokens: 7 }
      }),
      200
    )
    expect(r.ok).toBe(true)
    expect(r.text).toBe('第一段第二段')
    expect(r.usage).toEqual({ input_tokens: 5, output_tokens: 7 })
  })

  it('非流式错误体(type:"error")解析', () => {
    const r = adapter.parseNonStreamResponse(
      JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'not allowed' } }),
      403
    )
    expect(r.ok).toBe(false)
    expect(r.error?.message).toBe('not allowed')
    expect(r.error?.code).toBe('permission_error')
  })

  it('非流式:结构不符(OpenAI 形态)给出明确错误而非猜测', () => {
    const r = adapter.parseNonStreamResponse(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), 200)
    expect(r.ok).toBe(false)
    expect(r.error?.message).toContain('不符合 Anthropic Messages 协议')
  })

  it('模型目录解析(data[].id,display_name 作所有者)', () => {
    const r = adapter.parseModelsResponse(
      JSON.stringify({ data: [{ id: 'claude-x', type: 'model', display_name: 'Claude X' }, 'plain'] })
    )
    expect(r.entries).toHaveLength(2)
    expect(r.entries[0].ownedBy).toBe('Claude X')
    expect(r.entries[1].id).toBe('plain')
  })
})
