// 协议适配器接口：不同 AI 协议在此抽象下统一。
// P0 实现 openai-chat；openai-responses 与 anthropic-messages 为 P1。

import type { ModelEntry, ProtocolKind, ProviderConfig } from '@shared/types'
import type { SseEvent } from '../net/sse-parser'

export interface ChatRequestInput {
  model: string
  prompt: string
  stream: boolean
  maxTokens?: number
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens'
  temperature?: number
  streamIncludeUsage?: boolean
}

export interface BuiltRequest {
  url: string
  method: 'GET' | 'POST'
  /** 未脱敏的请求头；脱敏在记录捕获时统一进行 */
  headers: Record<string, string>
  body?: string
}

export interface AdapterStreamResult {
  /** 本事件是否携带首个有效内容（用于 firstContentMs 计时） */
  firstContent?: boolean
  /** 文本增量 */
  delta?: string
  usage?: unknown
  done?: boolean
  /** 上游在流中报错 */
  error?: { message: string; code?: string; type?: string }
}

export interface NonStreamResult {
  ok: boolean
  text?: string
  textTruncated?: boolean
  usage?: unknown
  error?: { message: string; code?: string; type?: string }
}

export interface ModelsResult {
  entries: ModelEntry[]
  error?: string
}

export interface ProtocolAdapter {
  kind: ProtocolKind
  defaultChatPath(): string
  defaultModelsPath(): string
  /** 是否以 SSE 流式响应（决定 HTTP 客户端读取方式） */
  buildChatRequest(provider: ProviderConfig, apiKey: string | undefined, input: ChatRequestInput): BuiltRequest
  buildModelsRequest(provider: ProviderConfig, apiKey: string | undefined): BuiltRequest
  handleStreamEvent(ev: SseEvent): AdapterStreamResult
  parseNonStreamResponse(bodyText: string, httpStatus: number): NonStreamResult
  parseModelsResponse(bodyText: string): ModelsResult
}

/** 组装最终请求头：协议头 + 自定义头（自定义头覆盖同名协议头，便于调试网关） */
export function mergeHeaders(
  protocolHeaders: Record<string, string>,
  provider: ProviderConfig
): Record<string, string> {
  const out: Record<string, string> = { ...protocolHeaders }
  for (const h of provider.headers) {
    if (h.name.trim()) out[h.name.trim()] = h.value
  }
  return out
}
