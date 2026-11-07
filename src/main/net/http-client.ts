// HTTP 客户端：超时、取消、错误分类（DNS/连接/TLS）、流式读取。
// 使用标准 fetch（Electron 主进程与 Node 22 测试环境均可用），不依赖 electron。

export type FetchFailurePhase = 'dns' | 'connect' | 'tls' | 'response' | 'timeout' | 'cancelled' | 'unknown'

export interface FetchFailure extends Error {
  phase: FetchFailurePhase
}

export function classifyFetchError(err: unknown): { phase: FetchFailurePhase; code: string; message: string } {
  const e = err as any
  const cause = e?.cause ?? e
  const msg = String(cause?.message ?? e?.message ?? String(err))

  // 用户取消（AbortController.abort()）
  if (e?.name === 'AbortError' || cause?.name === 'AbortError') {
    return { phase: 'cancelled', code: 'ABORTED', message: '请求已取消' }
  }
  // 超时（AbortSignal.timeout() 或自定义 reason）
  if (e?.name === 'TimeoutError' || cause?.name === 'TimeoutError') {
    return { phase: 'timeout', code: 'TIMEOUT', message: '请求超时' }
  }

  // undici 连接失败常包装为 AggregateError（多个候选地址），取第一个有意义的错误码
  const candidates: any[] = [cause, e, ...((cause?.errors ?? e?.cause?.errors ?? []) as any[])]
  let code = 'UnknownError'
  for (const c of candidates) {
    const cc = c?.code ?? c?.name
    if (cc && cc !== 'TypeError' && cc !== 'AggregateError' && cc !== 'Error') {
      code = String(cc)
      break
    }
  }
  if (code === 'UnknownError' && /terminated|socket/i.test(msg)) {
    code = 'UND_ERR_SOCKET'
  }

  const c = String(code)
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN' || c === 'ESERVFAIL') {
    return { phase: 'dns', code: c, message: `域名解析失败：${msg}` }
  }
  if (
    c === 'ECONNREFUSED' ||
    c === 'EHOSTUNREACH' ||
    c === 'ENETUNREACH' ||
    c === 'ECONNRESET' ||
    c === 'EPIPE' ||
    c === 'EADDRNOTAVAIL' ||
    c === 'UND_ERR_SOCKET' ||
    c === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return { phase: 'connect', code: c, message: `连接失败：${msg}` }
  }
  if (
    c.startsWith('ERR_TLS') ||
    c.startsWith('CERT_') ||
    c === 'EPROTO' ||
    c === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    c === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    c === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    c === 'ERR_SSL_WRONG_VERSION_NUMBER'
  ) {
    return { phase: 'tls', code: c, message: `TLS 证书/握手失败：${msg}` }
  }
  return { phase: 'unknown', code: c, message: msg }
}

export interface TimedHeaders {
  response: Response
  /** 从发起请求到收到响应头的时间 */
  ttfbMs: number
}

/** 发起 fetch，统一计时与错误分类。abortSignal 外部取消；timeoutMs 总超时。 */
export async function timedFetch(
  url: string,
  init: RequestInit,
  opts: { timeoutMs?: number; abortSignal?: AbortSignal }
): Promise<TimedHeaders> {
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  opts.abortSignal?.addEventListener('abort', onOuterAbort, { once: true })
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      const err = new Error('timeout')
      err.name = 'TimeoutError'
      controller.abort(err)
    }, opts.timeoutMs)
  }
  const started = performance.now()
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    return { response, ttfbMs: Math.round(performance.now() - started) }
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    opts.abortSignal?.removeEventListener('abort', onOuterAbort)
  }
}

/**
 * 逐块读取流式响应体。
 * - onChunk 在每个二进制分块到达时调用（返回 promise 可施加背压）
 * - idleTimeoutMs：两次分块之间的最大等待，超时抛 TimeoutError（防止上游挂起）
 * - 依赖外部传入的 abortSignal 以支持用户取消
 */
export async function readStreamChunks(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
  opts: { abortSignal?: AbortSignal; idleTimeoutMs?: number }
): Promise<void> {
  try {
    await doRead(body, onChunk, opts)
  } catch (err) {
    // reader.cancel(reason) 的路径会把 cancel reason 作为 done 之后的 resolve，
    // 这里统一把"外部取消"转成 AbortError，供上层正确归类。
    if (opts.abortSignal?.aborted) {
      const e = new Error('cancelled')
      e.name = 'AbortError'
      throw e
    }
    throw err
  }
}

async function doRead(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
  opts: { abortSignal?: AbortSignal; idleTimeoutMs?: number }
): Promise<void> {
  const reader = body.getReader()
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
  }
  const armIdle = () => {
    if (!opts.idleTimeoutMs || opts.idleTimeoutMs <= 0) return
    clearIdle()
    idleTimer = setTimeout(() => {
      const err = new Error('stream idle timeout')
      err.name = 'TimeoutError'
      // 主动 cancel 让 reader.read() 抛错
      void reader.cancel(err).catch(() => {})
    }, opts.idleTimeoutMs)
  }
  try {
    armIdle()
    for (;;) {
      if (opts.abortSignal?.aborted) {
        await reader.cancel(new Error('cancelled'))
        const e = new Error('cancelled')
        e.name = 'AbortError'
        throw e
      }
      const { done, value } = await reader.read()
      clearIdle()
      if (done) return
      await onChunk(value)
      armIdle()
    }
    } finally {
      clearIdle()
      try {
        reader.releaseLock()
      } catch {
        /* 已取消场景 */
      }
    }
  }

/**
 * 给任意 promise 加截止时间；超时抛 TimeoutError 并调用 cancel 回调中止底层操作。
 * 用于非流式响应体读取（总超时必须覆盖到 body 读取完成）。
 */
export async function withDeadline<T>(p: Promise<T>, deadlineMs: number, onCancel?: () => void): Promise<T> {
  if (!deadlineMs || deadlineMs <= 0) return p
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onCancel?.()
      const e = new Error('deadline exceeded')
      e.name = 'TimeoutError'
      reject(e)
    }, deadlineMs)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    clearTimeout(timer!)
  }
}
