// OpenAI 兼容 Chat Completions 适配器（P0）。
// 原则：请求体只包含用户明确设置且协议支持的字段。

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

const TEXT_CAP = 128 * 1024 // 提取文本上限

/** 中立消息 → OpenAI messages 数组 */
function toOpenAiMessages(input: ChatRequestInput): unknown[] {
  if (input.messages && input.messages.length > 0) {
    return input.messages.map((m: NeutralMessage) => {
      if (m.role === 'assistant') {
        return {
          role: 'assistant',
          content: m.text ?? null,
          ...(m.toolCalls
            ? {
                tool_calls: m.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: tc.argsJson }
                }))
              }
            : {})
        }
      }
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.toolResult!.toolCallId, content: m.toolResult!.content }
      }
      return { role: 'user', content: m.text ?? '' }
    })
  }
  return [{ role: 'user', content: input.prompt }]
}

export class OpenAiChatAdapter implements ProtocolAdapter {
  readonly kind = 'openai-chat' as const

  defaultChatPath(): string {
    return '/v1/chat/completions'
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
      messages: toOpenAiMessages(input),
      stream: input.stream
    }
    // 仅发送用户明确设置的字段
    if (typeof input.maxTokens === 'number') {
      const param = input.maxTokensParam === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens'
      body[param] = input.maxTokens
    }
    if (typeof input.temperature === 'number') body['temperature'] = input.temperature
    if (input.stream && input.streamIncludeUsage) body['stream_options'] = { include_usage: true }
    // 工具调用(P1):仅当用户启用时注入固定示例工具
    if (input.tools && input.tools.length > 0) {
      body['tools'] = input.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }))
    }
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
      // 非法 JSON 事件：不致命，保留为原始证据即可
      return {}
    }
    if (parsed && typeof parsed === 'object' && parsed.error) {
      return {
        error: {
          message: String(parsed.error.message ?? JSON.stringify(parsed.error)),
          code: parsed.error.code != null ? String(parsed.error.code) : undefined,
          type: parsed.error.type != null ? String(parsed.error.type) : undefined
        }
      }
    }
    const out: AdapterStreamResult = {}
    const delta = parsed?.choices?.[0]?.delta?.content
    if (typeof delta === 'string' && delta.length > 0) {
      out.delta = delta
      out.firstContent = true // 调用方只在第一次时采用
    }
    if (parsed && typeof parsed === 'object' && 'usage' in parsed && parsed.usage != null) {
      out.usage = parsed.usage
    }
    return out
  }

  parseNonStreamResponse(bodyText: string, _httpStatus: number): NonStreamResult {
    let parsed: any
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      return { ok: false, error: { message: '响应不是有效 JSON（可能是网关 HTML 错误页或非 OpenAI 兼容端点）' } }
    }
    if (parsed?.error) {
      return {
        ok: false,
        error: {
          message: String(parsed.error.message ?? JSON.stringify(parsed.error)),
          code: parsed.error.code != null ? String(parsed.error.code) : undefined,
          type: parsed.error.type != null ? String(parsed.error.type) : undefined
        }
      }
    }
    const content = parsed?.choices?.[0]?.message?.content
    let text: string | undefined
    let textTruncated = false
    if (typeof content === 'string') {
      text = content.length > TEXT_CAP ? content.slice(0, TEXT_CAP) : content
      textTruncated = content.length > TEXT_CAP
    } else if (Array.isArray(content)) {
      // 部分 compatible 网关返回分段 content
      const joined = content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('')
      text = joined.length > TEXT_CAP ? joined.slice(0, TEXT_CAP) : joined
      textTruncated = joined.length > TEXT_CAP
    }
    // 工具调用请求(P1):模型未给内容而给出 tool_calls 时原样返回,由执行器校验回传
    const rawToolCalls = parsed?.choices?.[0]?.message?.tool_calls
    const toolCalls = Array.isArray(rawToolCalls)
      ? rawToolCalls
          .filter((tc: any) => tc && typeof tc === 'object' && typeof tc.id === 'string' && tc.function?.name)
          .map((tc: any) => ({
            id: String(tc.id),
            name: String(tc.function.name),
            argsJson: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? {})
          }))
      : undefined
    return {
      ok: true,
      text,
      textTruncated,
      usage: parsed?.usage != null ? parsed.usage : undefined,
      toolCalls
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
        error: `模型目录响应格式不符合预期：data 字段为 ${data === undefined ? '缺失' : typeof data}（期望数组）`
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
          ownedBy: typeof item.owned_by === 'string' ? item.owned_by : undefined,
          declaredCapabilities:
            Array.isArray(item.capabilities) && item.capabilities.every((c: unknown) => typeof c === 'string')
              ? item.capabilities
              : undefined
        })
      }
      // 其余畸形条目跳过，不猜测
    }
    return { entries }
  }
}
