// Anthropic Messages 协议适配器(P1)。
// 依据 Anthropic 官方文档(2023-06-01 版本头):
// - 端点 POST /v1/messages,认证头 x-api-key(非 Authorization Bearer)
// - max_tokens 为必填参数:用户未设置时按协议最低要求补 1024(在请求详情中可见,非静默)
// - 非流式响应 content 为分段数组;流式为 SSE 事件流
//   (message_start / content_block_delta / message_delta / message_stop / error)

import type { ModelEntry, ProviderConfig } from '@shared/types'
import type {
  AdapterStreamResult,
  BuiltRequest,
  ChatRequestInput,
  NonStreamResult,
  ProtocolAdapter
} from './types'
import type { SseEvent } from '../net/sse-parser'
import { mergeHeaders } from './types'
import { joinUrl } from '@shared/url'

const ANTHROPIC_VERSION = '2023-06-01'
const TEXT_CAP = 128 * 1024

export class AnthropicMessagesAdapter implements ProtocolAdapter {
  readonly kind = 'anthropic-messages' as const

  defaultChatPath(): string {
    return '/v1/messages'
  }

  defaultModelsPath(): string {
    return '/v1/models'
  }

  buildChatRequest(provider: ProviderConfig, apiKey: string | undefined, input: ChatRequestInput): BuiltRequest {
    const url = joinUrl(provider.baseUrl, provider.chatPath || this.defaultChatPath())
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION
    }
    if (apiKey) headers['x-api-key'] = apiKey
    const body: Record<string, unknown> = {
      model: input.model,
      messages: [{ role: 'user', content: input.prompt }],
      stream: input.stream
    }
    // Anthropic 协议必填 max_tokens:用户设置优先,否则用协议允许的保守默认值
    body['max_tokens'] = typeof input.maxTokens === 'number' ? input.maxTokens : 1024
    if (typeof input.temperature === 'number') body['temperature'] = input.temperature
    return { url, method: 'POST', headers: mergeHeaders(headers, provider), body: JSON.stringify(body) }
  }

  buildModelsRequest(provider: ProviderConfig, apiKey: string | undefined): BuiltRequest {
    const url = joinUrl(provider.baseUrl, provider.modelsPath || this.defaultModelsPath())
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'anthropic-version': ANTHROPIC_VERSION
    }
    if (apiKey) headers['x-api-key'] = apiKey
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
    if (parsed && typeof parsed === 'object' && parsed.type === 'error' && parsed.error) {
      return {
        error: {
          message: String(parsed.error.message ?? JSON.stringify(parsed.error)),
          code: parsed.error.type != null ? String(parsed.error.type) : undefined
        }
      }
    }
    switch (parsed?.type) {
      case 'message_start': {
        const u = parsed.message?.usage
        if (u != null) out.usage = u
        break
      }
      case 'content_block_delta': {
        if (parsed.delta?.type === 'text_delta' && typeof parsed.delta.text === 'string' && parsed.delta.text.length > 0) {
          out.delta = parsed.delta.text
          out.firstContent = true
        }
        break
      }
      case 'message_delta': {
        if (parsed.usage != null) {
          out.usage = parsed.usage
          if (parsed.delta?.stop_reason) out.done = false // stop_reason 出现但流未结束,等待 message_stop
        }
        break
      }
      case 'message_stop': {
        out.done = true
        break
      }
      default:
        break
    }
    return out
  }

  parseNonStreamResponse(bodyText: string, _httpStatus: number): NonStreamResult {
    let parsed: any
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      return { ok: false, error: { message: '响应不是有效 JSON(可能是网关 HTML 错误页或非 Anthropic 兼容端点)' } }
    }
    if (parsed?.type === 'error' && parsed.error) {
      return {
        ok: false,
        error: {
          message: String(parsed.error.message ?? JSON.stringify(parsed.error)),
          code: parsed.error.type != null ? String(parsed.error.type) : undefined
        }
      }
    }
    if (parsed?.type !== 'message' || !Array.isArray(parsed.content)) {
      return { ok: false, error: { message: `响应结构不符合 Anthropic Messages 协议(期望 type:"message" 与 content 数组,实际 type=${String(parsed?.type)})` } }
    }
    const joined = parsed.content
      .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
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
      return {
        entries: [],
        error: `模型目录响应格式不符合预期:data 字段为 ${data === undefined ? '缺失' : typeof data}(期望数组)`
      }
    }
    const entries: ModelEntry[] = []
    for (const item of data.slice(0, 2000)) {
      if (typeof item === 'string') {
        entries.push({ id: item, origin: 'catalog' })
      } else if (item && typeof item === 'object' && typeof item.id === 'string') {
        entries.push({
          id: item.id,
          origin: 'catalog',
          ownedBy: typeof item.display_name === 'string' ? item.display_name : undefined,
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
