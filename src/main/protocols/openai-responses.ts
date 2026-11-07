// OpenAI Responses 协议适配器(P1 最后一项)。
// 依据 OpenAI 官方文档:
// - 端点 POST /v1/responses,Authorization Bearer
// - 参数名 max_output_tokens(注意与 chat 的 max_tokens 不同);input 可为字符串或消息数组
// - 非流式响应:{ object:'response', status:'completed'|'incomplete'|'failed',
//   output:[{type:'message', content:[{type:'output_text', text}]}], usage:{input_tokens,output_tokens,total_tokens} }
// - 流式 SSE:response.output_text.delta(delta 字段)→ response.completed(response.usage)
//   → response.failed / error;response.incomplete(被 max_output_tokens 截断,按正常结束处理)

import type { ModelEntry, ProviderConfig } from '@shared/types'
import type {
  AdapterStreamResult,
  BuiltRequest,
  ChatRequestInput,
  NeutralMessage,
  NonStreamResult,
  ProtocolAdapter
} from './types'
import type { SseEvent } from '../net/sse-parser'
import { mergeHeaders } from './types'
import { joinUrl } from '@shared/url'

const TEXT_CAP = 128 * 1024

/** 中立消息 → Responses input 数组 */
function toResponsesInput(input: ChatRequestInput): string | unknown[] {
  if (input.messages && input.messages.length > 0) {
    return input.messages.map((m: NeutralMessage) => {
      if (m.role === 'assistant') {
        return {
          role: 'assistant',
          content: m.toolCalls
            ? m.toolCalls.map((tc) => ({ type: 'output_text', text: `[请求调用工具 ${tc.name}(${tc.argsJson})]` })).join('') || undefined
            : (m.text ?? '')
        }
      }
      if (m.role === 'tool') {
        return { role: 'user', content: `[工具结果] ${m.toolResult!.content}` }
      }
      return { role: 'user', content: m.text ?? '' }
    })
  }
  return input.prompt
}

export class OpenAiResponsesAdapter implements ProtocolAdapter {
  readonly kind = 'openai-responses' as const

  defaultChatPath(): string {
    return '/v1/responses'
  }

  defaultModelsPath(): string {
    return '/v1/models'
  }

  buildChatRequest(provider: ProviderConfig, apiKey: string | undefined, input: ChatRequestInput): BuiltRequest {
    const url = joinUrl(provider.baseUrl, provider.chatPath || this.defaultChatPath())
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    const body: Record<string, unknown> = {
      model: input.model,
      input: toResponsesInput(input),
      stream: input.stream
    }
    // 仅发送用户明确设置的字段;Responses 的参数名是 max_output_tokens
    if (typeof input.maxTokens === 'number') body['max_output_tokens'] = input.maxTokens
    if (typeof input.temperature === 'number') body['temperature'] = input.temperature
    return { url, method: 'POST', headers: mergeHeaders(headers, provider), body: JSON.stringify(body) }
  }

  buildModelsRequest(provider: ProviderConfig, apiKey: string | undefined): BuiltRequest {
    const url = joinUrl(provider.baseUrl, provider.modelsPath || this.defaultModelsPath())
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    return { url, method: 'GET', headers: mergeHeaders(headers, provider) }
  }

  handleStreamEvent(ev: SseEvent): AdapterStreamResult {
    const data = ev.data.trim()
    if (data === '[DONE]') return { done: true }
    let parsed: any
    try {
      parsed = JSON.parse(data)
    } catch {
      return {}
    }
    const out: AdapterStreamResult = {}
    const type = parsed?.type
    if (type === 'response.output_text.delta' && typeof parsed.delta === 'string' && parsed.delta.length > 0) {
      out.delta = parsed.delta
      out.firstContent = true
      return out
    }
    if (type === 'response.completed') {
      if (parsed.response?.usage != null) out.usage = parsed.response.usage
      out.done = true
      return out
    }
    if (type === 'response.incomplete') {
      // 被截断属正常结束(诊断价值有限,不标失败)
      if (parsed.response?.usage != null) out.usage = parsed.response.usage
      out.done = true
      return out
    }
    if (type === 'response.failed') {
      const err = parsed.response?.error ?? {}
      return {
        error: { message: String(err.message ?? JSON.stringify(parsed.response?.error ?? 'response.failed')), code: err.code != null ? String(err.code) : undefined }
      }
    }
    if (type === 'error') {
      return {
        error: { message: String(parsed.message ?? JSON.stringify(parsed)), code: parsed.code != null ? String(parsed.code) : undefined }
      }
    }
    return out
  }

  parseNonStreamResponse(bodyText: string, _httpStatus: number): NonStreamResult {
    let parsed: any
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      return { ok: false, error: { message: '响应不是有效 JSON(可能是网关 HTML 错误页或非 OpenAI Responses 端点)' } }
    }
    if (parsed?.error) {
      return {
        ok: false,
        error: {
          message: String(parsed.error.message ?? JSON.stringify(parsed.error)),
          code: parsed.error.code != null ? String(parsed.error.code) : undefined
        }
      }
    }
    if (parsed?.object !== 'response' || !Array.isArray(parsed.output)) {
      return {
        ok: false,
        error: { message: `响应结构不符合 OpenAI Responses 协议(期望 object:"response" 与 output 数组,实际 object=${String(parsed?.object)})` }
      }
    }
    if (parsed.status === 'failed') {
      const err = parsed.error ?? {}
      return { ok: false, error: { message: String(err.message ?? 'response failed'), code: err.code != null ? String(err.code) : undefined } }
    }
    const joined = parsed.output
      .filter((o: any) => o?.type === 'message' && Array.isArray(o.content))
      .flatMap((o: any) => o.content)
      .filter((c: any) => c?.type === 'output_text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('')
    return {
      ok: true,
      text: joined.length > TEXT_CAP ? joined.slice(0, TEXT_CAP) : joined,
      textTruncated: joined.length > TEXT_CAP,
      usage: parsed.usage != null ? parsed.usage : undefined
    }
  }

  parseModelsResponse(bodyText: string): { entries: ModelEntry[]; error?: string } {
    let parsed: any
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      return { entries: [], error: '模型目录响应不是有效 JSON' }
    }
    const data = parsed?.data
    if (!Array.isArray(data)) {
      return { entries: [], error: `模型目录响应格式不符合预期:data 字段为 ${data === undefined ? '缺失' : typeof data}(期望数组)` }
    }
    const entries: ModelEntry[] = []
    for (const item of data.slice(0, 2000)) {
      if (typeof item === 'string') {
        entries.push({ id: item, origin: 'catalog' })
      } else if (item && typeof item === 'object' && typeof item.id === 'string') {
        entries.push({
          id: item.id,
          origin: 'catalog',
          ownedBy: typeof item.owned_by === 'string' ? item.owned_by : undefined,
          declaredCapabilities:
            Array.isArray(item.capabilities) && item.capabilities.every((c: unknown) => typeof c === 'string')
              ? item.capabilities
              : undefined
        })
      }
    }
    return { entries }
  }
}
