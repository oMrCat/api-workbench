// 测试执行器：完整请求闭环编排。
// 依赖注入 adapter（协议）与 fetch 实现，便于集成测试直接驱动。

import type {
  CapturedRequest,
  ProviderConfig,
  RunEvent,
  StreamEventLog,
  TestParams,
  ToolCallStep,
  TestRunRecord
} from '@shared/types'
import type { NeutralMessage, ProtocolAdapter } from '../protocols/types'
import { SseDecoder } from '../net/sse-parser'
import { classifyFetchError, readStreamChunks, timedFetch, withDeadline } from '../net/http-client'
import { redactCapturedRequest, redactText } from '../redact'
import { diagnose } from '../diagnosis'
import { executeToolCall, toolDefinitions } from '../tools/example-tools'

const RAW_PREVIEW_CAP = 32 * 1024 // 原始响应预览上限
const MAX_STREAM_EVENTS = 5000 // 流事件日志硬上限（防内存失控）

export interface RunnerDeps {
  /** 事件回调（主进程转发给 renderer；测试中可收集） */
  onEvent?: (ev: RunEvent) => void
  /** 生成 runId */
  newId?: () => string
}

export interface RunSecrets {
  /** 参与脱敏的已知密钥值（API Key + 敏感自定义头值） */
  knownSecrets: string[]
}

/** 单次测试运行的句柄，用于取消 */
export interface RunningRequest {
  cancel(): void
}

export class TestRunner {
  private deps: RunnerDeps
  private active = new Map<string, AbortController>()

  constructor(deps: RunnerDeps) {
    this.deps = deps
  }

  cancel(runId: string): boolean {
    const c = this.active.get(runId)
    if (!c) return false
    c.abort()
    return true
  }

  cancelAll(): void {
    for (const c of this.active.values()) c.abort()
    this.active.clear()
  }

  async run(
    adapter: ProtocolAdapter,
    params: TestParams,
    provider: ProviderConfig,
    apiKey: string | undefined,
    secrets: RunSecrets,
    settings: { streamLogLimit: number; streamIdleTimeoutMs: number },
    opts?: { runId?: string; compareId?: string }
  ): Promise<TestRunRecord> {
    // 优先使用调用方(渲染进程)预生成的 runId,保证 UI 的取消按钮能按 ID 匹配
    const runId =
      opts?.runId ??
      this.deps.newId?.() ??
      `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const input = {
      model: params.model,
      prompt: params.prompt,
      stream: params.stream,
      maxTokens: params.maxTokens,
      temperature: params.temperature,
      streamIncludeUsage: params.streamIncludeUsage
    }
    const built = adapter.buildChatRequest(provider, apiKey, input)
    const emit = (ev: RunEvent) => this.deps.onEvent?.(ev)

    const record: TestRunRecord = {
      id: runId,
      startedAt: Date.now(),
      providerId: provider.id,
      providerName: provider.name,
      model: params.model,
      protocol: adapter.kind,
      stream: params.stream,
      request: { url: '', method: '', headers: {} }, // 稍后填充脱敏版
      ok: false,
      phase: 'unknown',
      timing: {},
      ...(opts?.compareId ? { compareId: opts.compareId } : {})
    }

    // 捕获脱敏后的请求（原始请求只在此处捕获，密钥不落盘）
    const captured: CapturedRequest = {
      url: built.url,
      method: built.method,
      headers: { ...built.headers },
      body: built.body
    }
    record.request = redactCapturedRequest(captured, secrets.knownSecrets)

    const controller = new AbortController()
    this.active.set(runId, controller)
    const events: StreamEventLog[] = []
    let textParts: string[] = []
    let textLen = 0
    let firstContentAt: number | undefined
    let usage: unknown
    let streamUpstreamError: { message: string; code?: string; type?: string } | undefined
    let sawDone = false
    let streamInterrupted = false
    let enteredStreaming = false // 是否已进入流读取阶段（用于中途断开的阶段归类）
    const started = performance.now()

    emit({ type: 'status', runId, status: 'connecting' })

    try {
      const { response, ttfbMs } = await timedFetch(
        built.url,
        {
          method: built.method,
          headers: built.headers,
          body: built.body
        },
        { timeoutMs: provider.timeoutMs, abortSignal: controller.signal }
      )
      record.timing.ttfbMs = ttfbMs
      record.httpStatus = response.status
      emit({ type: 'status', runId, status: 'headers-received', detail: `HTTP ${response.status}` })

      if (!response.ok && !response.body) {
        // 无响应体的错误
        record.phase = 'response'
        record.errorMessage = `HTTP ${response.status}（无响应体）`
        record.ok = false
        record.finishedAt = Date.now()
        record.timing.totalMs = Math.round(performance.now() - started)
        record.diagnosis = diagnoseRecordShim(record)
        return finalize()
      }

      const contentType = response.headers.get('content-type') ?? ''

      if (!response.ok) {
        // 错误响应：读取正文片段作为证据
        const bodyText = await response.text().catch(() => '')
        record.errorBodyPreview = bodyText.slice(0, RAW_PREVIEW_CAP)
        record.phase = 'response'
        record.errorMessage = `HTTP ${response.status}`
        // 尝试按协议解析错误体（4xx/5xx 也可能带 JSON 错误结构）
        const parsed = adapter.parseNonStreamResponse(bodyText, response.status)
        if (!parsed.ok && parsed.error) {
          record.errorMessage = parsed.error.code
            ? `HTTP ${response.status}（${parsed.error.code}）`
            : `HTTP ${response.status}`
          if (parsed.error.message && !bodyText.trim().startsWith('<')) {
            record.errorMessage = `${record.errorMessage}: ${parsed.error.message.slice(0, 500)}`
          }
        }
        record.ok = false
        record.finishedAt = Date.now()
        record.timing.totalMs = Math.round(performance.now() - started)
        record.diagnosis = diagnoseRecordShim(record)
        emit({ type: 'status', runId, status: 'error', detail: `HTTP ${response.status}` })
        return finalize()
      }

      if (!params.stream) {
        // 非流式:读全文(受整体超时约束),按协议解析;支持工具调用循环(P1)
        const MAX_TOOL_ROUNDS = 3
        const toolSteps: ToolCallStep[] = []
        let messages: NeutralMessage[] | undefined
        const tools = params.toolsEnabled ? toolDefinitions() : undefined
        let round = 0
        let currentResponse = response
        for (;;) {
          round++
          const elapsed = performance.now() - started
          const bodyText = await withDeadline(
            currentResponse.text(),
            Math.max(100, provider.timeoutMs - elapsed),
            () => void currentResponse.body?.cancel().catch(() => {})
          )
          record.timing.totalMs = Math.round(performance.now() - started)
          record.rawResponsePreview = bodyText.slice(0, RAW_PREVIEW_CAP)
          record.rawTruncated = bodyText.length > RAW_PREVIEW_CAP
          const parsed = adapter.parseNonStreamResponse(bodyText, response.status)
          if (!parsed.ok) {
            record.phase = 'parse'
            record.errorMessage = parsed.error?.message ?? '响应解析失败'
            record.diagnosis = diagnoseRecordShim(record)
            emit({ type: 'status', runId, status: 'error' })
            return finalize()
          }
          const wantsToolRound =
            params.toolsEnabled && Boolean(parsed.toolCalls?.length) && round < MAX_TOOL_ROUNDS
          if (!wantsToolRound) {
            record.ok = true
            record.phase = 'success'
            record.text = parsed.text
            record.textTruncated = parsed.textTruncated
            record.usage = parsed.usage
            record.toolRounds = round
            if (toolSteps.length > 0) record.toolSteps = toolSteps
            record.finishedAt = Date.now()
            record.diagnosis = diagnoseRecordShim(record)
            emit({ type: 'status', runId, status: 'done' })
            return finalize()
          }
          // ---- 工具调用轮:校验白名单 → 本地执行 → 回传结果进入下一轮 ----
          messages = messages ?? [{ role: 'user', text: params.prompt }]
          messages.push({ role: 'assistant', text: parsed.text, toolCalls: parsed.toolCalls })
          for (const tc of parsed.toolCalls!) {
            const t0 = performance.now()
            const exec = executeToolCall(tc.name, tc.argsJson)
            toolSteps.push({
              seq: toolSteps.length,
              toolName: tc.name,
              argumentsJson: tc.argsJson,
              resultJson: exec.resultJson,
              error: exec.error,
              status: exec.status,
              durationMs: Math.round(performance.now() - t0)
            })
            messages.push({
              role: 'tool',
              toolResult: { toolCallId: tc.id, content: exec.resultJson ?? exec.error ?? '' }
            })
          }
          emit({
            type: 'status',
            runId,
            status: 'headers-received',
            detail: `工具循环:第 ${round} 轮 ${parsed.toolCalls!.length} 个调用已回传`
          })
          // 下一轮:重建请求(完整消息历史),更新捕获与脱敏
          const nextBuilt = adapter.buildChatRequest(provider, apiKey, {
            model: params.model,
            prompt: params.prompt,
            stream: false,
            maxTokens: params.maxTokens,
            temperature: params.temperature,
            tools,
            messages
          })
          captured.url = nextBuilt.url
          captured.method = nextBuilt.method
          captured.headers = { ...nextBuilt.headers }
          captured.body = nextBuilt.body
          record.request = redactCapturedRequest(captured, secrets.knownSecrets)
          const next = await timedFetch(
            nextBuilt.url,
            { method: nextBuilt.method, headers: nextBuilt.headers, body: nextBuilt.body },
            { timeoutMs: provider.timeoutMs, abortSignal: controller.signal }
          )
          record.timing.ttfbMs = record.timing.ttfbMs ?? next.ttfbMs
          record.httpStatus = next.response.status
          currentResponse = next.response
          if (!next.response.ok) {
            // 下一轮请求失败:错误体走同一解析路径(循环会经 parse 失败/成功路径收尾)
            record.phase = 'response'
            record.errorMessage = `HTTP ${next.response.status}(工具循环第 ${round + 1} 轮)`
          }
        }
      }

      // 流式：检查 content-type，但不据此断言失败——很多兼容网关 content-type 不规范
      const isSse = contentType.includes('text/event-stream')
      if (!isSse) {
        // 记录事实，仍尝试按 SSE 解析（兼容性场景）
        record.errorMessage = `Content-Type 为 ${contentType || '未知'}（非 text/event-stream），仍尝试按流解析`
      }

      emit({ type: 'status', runId, status: 'streaming' })
      enteredStreaming = true
      const decoder = new SseDecoder()
      let seq = 0
      let rawEventCount = 0

      await readStreamChunks(
        response.body!,
        (chunk) => {
          const parsed = decoder.push(chunk)
          for (const ev of parsed) {
            rawEventCount++
            if (seq < Math.min(settings.streamLogLimit, MAX_STREAM_EVENTS)) {
              events.push({
                seq: seq++,
                tMs: Math.round(performance.now() - started),
                data: ev.data.slice(0, 2048)
              })
            }
            const r = adapter.handleStreamEvent(ev)
            if (r.error) streamUpstreamError = r.error
            if (r.delta) {
              if (firstContentAt == null) {
                firstContentAt = Math.round(performance.now() - started)
                record.timing.firstContentMs = firstContentAt
              }
              if (textLen < RAW_PREVIEW_CAP) {
                textParts.push(r.delta)
                textLen += r.delta.length
              }
              emit({ type: 'text-delta', runId, delta: r.delta })
            }
            if (r.usage) usage = r.usage
            if (r.done) sawDone = true
          }
        },
        { abortSignal: controller.signal, idleTimeoutMs: settings.streamIdleTimeoutMs }
      )

      // 外部取消可能表现为"流提前结束"而非抛错——在此统一归类
      if (controller.signal.aborted) {
        const e = new Error('cancelled')
        e.name = 'AbortError'
        throw e
      }

      // 冲出缓冲中的最后事件
      for (const ev of decoder.flush()) {
        rawEventCount++
        if (seq < Math.min(settings.streamLogLimit, MAX_STREAM_EVENTS)) {
          events.push({ seq: seq++, tMs: Math.round(performance.now() - started), data: ev.data.slice(0, 2048) })
        }
        const r = adapter.handleStreamEvent(ev)
        if (r.error) streamUpstreamError = r.error
        if (r.delta) {
          if (firstContentAt == null) {
            firstContentAt = Math.round(performance.now() - started)
            record.timing.firstContentMs = firstContentAt
          }
          if (textLen < RAW_PREVIEW_CAP) {
            textParts.push(r.delta)
            textLen += r.delta.length
          }
          emit({ type: 'text-delta', runId, delta: r.delta })
        }
        if (r.usage) usage = r.usage
        if (r.done) sawDone = true
      }

      record.timing.totalMs = Math.round(performance.now() - started)
      record.streamEvents = events
      record.streamEventsTruncated = rawEventCount > events.length
      record.usage = usage
      record.text = textParts.join('')

      if (streamUpstreamError) {
        record.ok = false
        record.phase = 'stream'
        record.errorMessage = streamUpstreamError.message
        record.errorCode = streamUpstreamError.code
      } else if (params.stream && !sawDone && !isSse) {
        record.ok = true // content-type 不规范但完整收到内容，不算失败
        record.phase = 'success'
      } else if (!sawDone && isSse) {
        record.ok = false
        record.phase = 'stream'
        streamInterrupted = true
        record.errorMessage = '流在 [DONE] 结束标记前中断'
      } else {
        record.ok = true
        record.phase = 'success'
      }
      record.finishedAt = Date.now()
      record.diagnosis = diagnoseRecordShim(record)
      emit({ type: 'status', runId, status: record.ok ? 'done' : 'error' })
      return finalize()
    } catch (err) {
      const cls = classifyFetchError(err)
      record.timing.totalMs = Math.round(performance.now() - started)
      record.errorCode = cls.code
      record.errorMessage = cls.message
      // 保留部分接收内容与事件日志作为诊断证据（取消/断开/异常都适用）
      if (textParts.length > 0) record.text = textParts.join('')
      if (events.length > 0) {
        record.streamEvents = events.slice(0, Math.min(settings.streamLogLimit, MAX_STREAM_EVENTS))
        record.streamEventsTruncated = events.length > settings.streamLogLimit
      }
      if (firstContentAt != null) record.timing.firstContentMs = firstContentAt
      if (cls.phase === 'cancelled') {
        record.cancelled = true
        record.phase = 'cancelled'
        record.ok = false
        record.finishedAt = Date.now()
        record.diagnosis = diagnoseRecordShim(record)
        emit({ type: 'status', runId, status: 'done', detail: '已取消' })
        return finalize()
      }
      if (cls.phase === 'timeout') {
        record.timedOut = true
        record.phase = 'timeout'
      } else if (cls.phase === 'connect' && enteredStreaming) {
        // 流读取中途连接断开：归类为流阶段，而非连接阶段
        record.phase = 'stream'
        streamInterrupted = true
        record.errorMessage = `流中途断开：${cls.message}`
      } else {
        record.phase = cls.phase
      }
      record.ok = false
      record.finishedAt = Date.now()
      record.diagnosis = diagnoseRecordShim(record)
      emit({ type: 'status', runId, status: 'error', detail: cls.code })
      return finalize()
    } finally {
      this.active.delete(runId)
    }

    // ---- 内部工具：填充脱敏与诊断后返回 ----
    function finalize(): TestRunRecord {
      record.request = redactCapturedRequest(captured, secrets.knownSecrets)
      record.rawResponsePreview = record.rawResponsePreview
        ? redactText(record.rawResponsePreview, secrets.knownSecrets)
        : undefined
      record.errorBodyPreview = record.errorBodyPreview
        ? redactText(record.errorBodyPreview, secrets.knownSecrets)
        : undefined
      record.streamEvents = record.streamEvents?.map((e) => ({ ...e, data: redactText(e.data, secrets.knownSecrets) }))
      record.text = record.text ? redactText(record.text, secrets.knownSecrets) : undefined
      return record
    }

    function diagnoseRecordShim(r: TestRunRecord) {
      return diagnose({
        phase: r.phase,
        httpStatus: r.httpStatus,
        errorCode: r.errorCode,
        errorMessage: r.errorMessage,
        errorBodyPreview: record.errorBodyPreview,
        stream: r.stream,
        streamInterrupted,
        timedOut: r.timedOut,
        cancelled: r.cancelled,
        timing: r.timing
      })
    }
  }
}
