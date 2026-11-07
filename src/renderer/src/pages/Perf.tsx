// 性能测试(P1):用户主动启动的简单压测。
// 安全边界(逐条落实需求):
// - 默认并发 1(上限 4);请求数默认 5(上限 50);运行时间上限默认 5 分钟(上限 30 分钟)
// - 随时可停(在途请求逐个 cancel)
// - 任一请求返回 429 → 立即停止派发新请求(限流不绕过、不重试)
// - 零自动重试:失败原样记录(失败可能已在上游计费)
// - 每条请求照常落入诊断历史(perfId 分组);汇总仅存于本会话

import { useRef, useState } from 'react'
import type { TestRunRecord } from '@shared/types'
import { useApp } from '../store'
import { Empty } from '../components/common'

interface PerfEntry {
  seq: number
  runId: string
  status: 'pending' | 'running' | 'done'
  record?: TestRunRecord
  invokeError?: string
}

interface PerfSummary {
  total: number
  completed: number
  ok: number
  failed: number
  rateLimited: boolean
  stopped: boolean
  deadlineHit: boolean
  latencies: number[]
  ttfbs: number[]
  usageSum: { prompt: number; completion: number; total: number } | null
  usageProvidersReturned: number
}

const MAX_COUNT = 50
const MAX_CONCURRENCY = 4
const MAX_MINUTES = 30

function median(list: number[]): number {
  if (list.length === 0) return 0
  const s = [...list].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

function p95(list: number[]): number {
  if (list.length === 0) return 0
  const s = [...list].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]
}

export default function PerfPage() {
  const providers = useApp((s) => s.providers)
  const catalogs = useApp((s) => s.catalogs)
  const addRecord = useApp((s) => s.addRecord)
  const setToast = useApp((s) => s.setToast)

  const [providerId, setProviderId] = useState(providers[0]?.id ?? '')
  const [model, setModel] = useState('')
  const [count, setCount] = useState(5)
  const [maxTokens, setMaxTokens] = useState(64)
  const [concurrency, setConcurrency] = useState(1)
  const [minutes, setMinutes] = useState(5)
  const [entries, setEntries] = useState<PerfEntry[]>([])
  const [running, setRunning] = useState(false)
  const [summary, setSummary] = useState<PerfSummary | undefined>(undefined)
  const runIdsRef = useRef<Set<string>>(new Set())
  const stopRef = useRef(false)

  const provider = providers.find((p) => p.id === providerId)
  const canRun = !running && provider && model.trim().length > 0 && count >= 1 && concurrency >= 1

  const start = async () => {
    if (!canRun) return
    const perfId = `perf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const deadline = Date.now() + minutes * 60 * 1000
    stopRef.current = false
    setRunning(true)
    setSummary(undefined)
    const initial: PerfEntry[] = Array.from({ length: count }, (_, i) => ({
      seq: i,
      runId: `run-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 6)}`,
      status: 'pending'
    }))
    setEntries(initial)

    const results: (TestRunRecord | { error: string })[] = new Array(count)
    let nextIndex = 0
    let rateLimited = false
    let completed = 0

    const worker = async () => {
      for (;;) {
        if (stopRef.current || rateLimited || Date.now() > deadline) return
        const idx = nextIndex
        if (idx >= count) return
        nextIndex++
        const entry = initial[idx]
        runIdsRef.current.add(entry.runId)
        setEntries((prev) => prev.map((e) => (e.seq === idx ? { ...e, status: 'running' } : e)))
        try {
          const record = await window.api.runTest({
            providerId: provider!.id,
            model: model.trim(),
            stream: false,
            prompt: '性能测试请求。请用一句话回复。',
            maxTokens,
            perfId,
            runId: entry.runId
          })
          results[idx] = record
          addRecord(record)
          setEntries((prev) => prev.map((e) => (e.seq === idx ? { ...e, status: 'done', record } : e)))
          if (record.httpStatus === 429) {
            // 遵守限流:立即停止派发新请求(不重试)
            rateLimited = true
          }
        } catch (e) {
          results[idx] = { error: String((e as Error).message ?? e) }
          setEntries((prev) => prev.map((en) => (en.seq === idx ? { ...en, status: 'done', invokeError: String((e as Error).message ?? e) } : en)))
        } finally {
          runIdsRef.current.delete(entry.runId)
          completed++
        }
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, count) }, () => worker())
    await Promise.all(workers)
    void completed

    const records = results.filter((r): r is TestRunRecord => r !== undefined && !('error' in r))
    const okRecords = records.filter((r) => r.ok)
    const latencies = okRecords.map((r) => r.timing.totalMs ?? 0).filter((v) => v > 0)
    const ttfbs = okRecords.map((r) => r.timing.ttfbMs ?? 0).filter((v) => v > 0)
    let usageSum: PerfSummary['usageSum'] = null
    let usageProvidersReturned = 0
    for (const r of okRecords) {
      const u = r.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined
      if (u && typeof u.total_tokens === 'number') {
        usageProvidersReturned++
        usageSum = usageSum ?? { prompt: 0, completion: 0, total: 0 }
        usageSum.prompt += u.prompt_tokens ?? 0
        usageSum.completion += u.completion_tokens ?? 0
        usageSum.total += u.total_tokens ?? 0
      }
    }
    setSummary({
      total: count,
      completed: results.filter((r) => r !== undefined).length,
      ok: okRecords.length,
      failed: count - okRecords.length,
      rateLimited,
      stopped: stopRef.current,
      deadlineHit: Date.now() > deadline,
      latencies,
      ttfbs,
      usageSum,
      usageProvidersReturned
    })
    setRunning(false)
    setToast({ kind: rateLimited ? 'err' : 'info', text: rateLimited ? '遇到限流(429),已停止剩余请求' : `性能测试结束:${okRecords.length}/${count} 成功` })
  }

  const stop = () => {
    stopRef.current = true
    for (const id of runIdsRef.current) void window.api.cancelTest(id)
  }

  if (providers.length === 0) {
    return (
      <div>
        <h1>性能</h1>
        <Empty text="先在「服务商」页添加配置,再回到这里做性能测试。" />
      </div>
    )
  }

  return (
    <div>
      <h1>性能</h1>
      <p className="muted">
        用户主动启动的简单压测。默认并发 1(上限 {MAX_CONCURRENCY});请求数上限 {MAX_COUNT};运行时间上限 {MAX_MINUTES} 分钟。
        <b>不自动重试</b>(失败可能已在上游计费);遇到 429 限流会<b>立即停止</b>派发新请求。每条请求照常记入诊断历史。
      </p>

      <div className="panel">
        <div className="row">
          <div>
            <label className="field">服务商</label>
            <select value={providerId} onChange={(e) => { setProviderId(e.target.value); setModel('') }} style={{ minWidth: 200 }}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name || p.id}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label className="field">模型 ID</label>
            <input type="text" value={model} list="perf-model-list" placeholder="如 mock-chat-mini" onChange={(e) => setModel(e.target.value)} />
            <datalist id="perf-model-list">
              {(providerId ? catalogs[providerId]?.entries ?? [] : []).map((m) => (
                <option key={m.id} value={m.id} />
              ))}
            </datalist>
          </div>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            请求数(≤{MAX_COUNT})
            <input type="number" min={1} max={MAX_COUNT} value={count} onChange={(e) => setCount(Math.min(MAX_COUNT, Math.max(1, Number(e.target.value) || 1)))} style={{ width: 90 }} />
          </label>
          <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            并发(≤{MAX_CONCURRENCY})
            <input type="number" min={1} max={MAX_CONCURRENCY} value={concurrency} onChange={(e) => setConcurrency(Math.min(MAX_CONCURRENCY, Math.max(1, Number(e.target.value) || 1)))} style={{ width: 80 }} />
          </label>
          <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            输出上限
            <input type="number" min={1} value={maxTokens} onChange={(e) => setMaxTokens(Math.max(1, Number(e.target.value) || 1))} style={{ width: 90 }} />
          </label>
          <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            时间上限(分钟,≤{MAX_MINUTES})
            <input type="number" min={1} max={MAX_MINUTES} value={minutes} onChange={(e) => setMinutes(Math.min(MAX_MINUTES, Math.max(1, Number(e.target.value) || 1)))} style={{ width: 90 }} />
          </label>
          <button className="primary" onClick={() => void start()} disabled={!canRun}>
            {running ? '测试进行中…' : '开始性能测试'}
          </button>
          {running && (
            <button className="danger" onClick={stop}>
              停止
            </button>
          )}
        </div>
        <div className="muted" style={{ marginTop: 6 }}>
          本次将发起 {count} 个请求 · 模型 {model || '(未填)'} · 输出上限 {maxTokens} · 并发 {concurrency} · 时间上限 {minutes} 分钟
        </div>
      </div>

      {summary && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>汇总</h2>
          <div className="kv">
            <span className="k">完成 / 总数</span>
            <span className="v">{summary.completed} / {summary.total}</span>
            <span className="k">成功率</span>
            <span className="v">{summary.completed > 0 ? Math.round((summary.ok / summary.completed) * 100) : 0}%({summary.ok} 成功 / {summary.failed} 失败或取消)</span>
            <span className="k">总耗时(成功请求)</span>
            <span className="v">
              {summary.latencies.length > 0
                ? `min ${Math.min(...summary.latencies)} · 中位 ${median(summary.latencies)} · p95 ${p95(summary.latencies)} · max ${Math.max(...summary.latencies)} ms`
                : '—'}
            </span>
            <span className="k">响应头中位</span>
            <span className="v">{summary.ttfbs.length > 0 ? `${median(summary.ttfbs)} ms` : '—'}</span>
            <span className="k">usage 合计</span>
            <span className="v">
              {summary.usageSum
                ? `prompt ${summary.usageSum.prompt} + completion ${summary.usageSum.completion} = total ${summary.usageSum.total}(${summary.usageProvidersReturned}/${summary.ok} 个成功请求返回了 usage,其余上游未返回)`
                : '上游未返回'}
            </span>
            {(summary.rateLimited || summary.stopped || summary.deadlineHit) && (
              <>
                <span className="k">提前终止</span>
                <span className="v">
                  {summary.rateLimited && '⚠️ 遇到限流(429),已停止派发新请求;'}
                  {summary.stopped && '用户主动停止;'}
                  {summary.deadlineHit && '达到时间上限;'}
                </span>
              </>
            )}
          </div>
          <div className="muted" style={{ marginTop: 6 }}>汇总仅保存在本会话;每条请求的完整记录在「诊断历史」可查可导出。</div>
        </div>
      )}

      {entries.length > 0 && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>逐请求</h2>
          <table className="list">
            <thead>
              <tr>
                <th>#</th>
                <th>状态</th>
                <th>HTTP</th>
                <th>总耗时</th>
                <th>错误摘要</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.seq}>
                  <td>{e.seq}</td>
                  <td>
                    {e.status === 'pending' ? (
                      <span className="badge dim">等待</span>
                    ) : e.status === 'running' ? (
                      <span className="badge info">进行中</span>
                    ) : e.record?.ok ? (
                      <span className="badge ok">成功</span>
                    ) : e.record?.cancelled ? (
                      <span className="badge warn">取消</span>
                    ) : (
                      <span className="badge err">{e.record?.phase ?? '失败'}</span>
                    )}
                  </td>
                  <td>{e.record?.httpStatus ?? '—'}</td>
                  <td>{e.record?.timing.totalMs != null ? `${e.record.timing.totalMs} ms` : '—'}</td>
                  <td className="muted" style={{ maxWidth: 220, wordBreak: 'break-all' }}>
                    {e.record?.httpStatus === 429 ? '⚠️ 429 限流' : e.record?.errorMessage ?? e.invokeError ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
