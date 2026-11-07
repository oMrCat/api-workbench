import { describe, it, expect } from 'vitest'
import { OpenAiResponsesAdapter } from '../../src/main/protocols/openai-responses'
import type { ProviderConfig } from '@shared/types'

const adapter = new OpenAiResponsesAdapter()
const provider: ProviderConfig = {
  id: 'p',
  name: 'x',
  baseUrl: 'https://api.openai-compatible.example',
  protocol: 'openai-responses',
  headers: [],
  timeoutMs: 60000,
  createdAt: 0,
  updatedAt: 0
}

describe('OpenAI Responses 适配器(P1 收官)', () => {
  it('端点 /v1/responses + Bearer 认证', () => {
    const built = adapter.buildChatRequest(provider, 'sk-test-key', { model: 'm', prompt: 'hi', stream: false })
    expect(built.url).toBe('https://api.openai-compatible.example/v1/responses')
    expect(built.headers['Authorization']).toBe('Bearer sk-test-key')
  })

  it('参数名是 max_output_tokens(区别于 chat 的 max_tokens)', () => {
    const body = JSON.parse(adapter.buildChatRequest(provider, 'k', { model: 'm', prompt: 'p', stream: false, maxTokens: 64 }).body!)
    expect(body.max_output_tokens).toBe(64)
    expect(body.max_tokens).toBeUndefined()
    expect(body.input).toBe('p')
    expect(body.temperature).toBeUndefined()
  })

  it('流式:output_text.delta 提取增量', () => {
    const r = adapter.handleStreamEvent({ data: '{"type":"response.output_text.delta","delta":"你好"}' })
    expect(r.delta).toBe('你好')
    expect(r.firstContent).toBe(true)
  })

  it('流式:response.completed 携带 usage 并判定完成', () => {
    const r = adapter.handleStreamEvent({
      data: '{"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":6,"total_tokens":11}}}'
    })
    expect(r.done).toBe(true)
    expect(r.usage).toEqual({ input_tokens: 5, output_tokens: 6, total_tokens: 11 })
  })

  it('流式:response.incomplete(截断)按正常结束处理', () => {
    const r = adapter.handleStreamEvent({
      data: '{"type":"response.incomplete","response":{"status":"incomplete","usage":{"total_tokens":9}}}'
    })
    expect(r.done).toBe(true)
    expect(r.error).toBeUndefined()
  })

  it('流式:response.failed 与 error 事件归类为错误', () => {
    const f = adapter.handleStreamEvent({ data: '{"type":"response.failed","response":{"error":{"code":"server_error","message":"boom"}}}' })
    expect(f.error?.message).toBe('boom')
    const e = adapter.handleStreamEvent({ data: '{"type":"error","code":"rate_limit","message":"too fast"}' })
    expect(e.error?.code).toBe('rate_limit')
  })

  it('非流式:output[] → output_text 拼接 + usage 透传', () => {
    const r = adapter.parseNonStreamResponse(
      JSON.stringify({
        object: 'response',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'A' }, { type: 'output_text', text: 'B' }] }],
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 }
      }),
      200
    )
    expect(r.ok).toBe(true)
    expect(r.text).toBe('AB')
    expect(r.usage).toEqual({ input_tokens: 3, output_tokens: 4, total_tokens: 7 })
  })

  it('非流式:status failed → 错误', () => {
    const r = adapter.parseNonStreamResponse(
      JSON.stringify({ object: 'response', status: 'failed', error: { code: 'x', message: 'bad' } }),
      200
    )
    expect(r.ok).toBe(false)
    expect(r.error?.message).toBe('bad')
  })

  it('非流式:结构不符(把 chat 响应喂进来)明确报错', () => {
    const r = adapter.parseNonStreamResponse(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), 200)
    expect(r.ok).toBe(false)
    expect(r.error?.message).toContain('不符合 OpenAI Responses 协议')
  })

  it('模型目录解析复用 data[] 形态', () => {
    const r = adapter.parseModelsResponse(JSON.stringify({ data: [{ id: 'gpt-x' }] }))
    expect(r.entries[0].id).toBe('gpt-x')
  })
})
