// 多服务商对比(P1):同一提示词并发发给多个服务商,表格对比关键指标。
// 并发数 = 所选服务商数(上限 5),用户主动触发,不做自动重试;
// 每条结果带同一 compareId 落入诊断历史,可导出。

import { useMemo, useRef, useState } from 'react'
import type { TestRunRecord } from '@shared/types'
import { useApp } from '../store'
import { Empty } from '../components/common'
import { ResultPanel } from './Test'

interface CompareTarget {
  providerId: string
  model: string
}

interface CompareRow {
  key: string
  providerName: string
  model: string
  runId: string
  status: 'running' | 'done' | 'error'
  record?: TestRunRecord
  invokeError?: string
}

const MAX_COMPARE = 5

export default function ComparePage() {
  const providers = useApp((s) => s.providers)
  const catalogs = useApp((s) => s.catalogs)
  const addRecord = useApp((s) => s.addRecord)
  const setToast = useApp((s) => s.setToast)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [models, setModels] = useState<Record<string, string>>({})
  const [prompt, setPrompt] = useState('用一句话介绍你自己。')
  const [maxTokens, setMaxTokens] = useState('64')
  const [stream, setStream] = useState(false)
  const [rows, setRows] = useState<CompareRow[]>([])
  const [running, setRunning] = useState(false)
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  const runIdsRef = useRef<Set<string>>(new Set())

  const toggleProvider = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) {
      next.delete(id)
    } else {
      if (next.size >= MAX_COMPARE) {
        setToast({ kind: 'err', text: `对比最多选择 ${MAX_COMPARE} 个服务商(避免无意高并发)` })
        return
      }
      next.add(id)
      // 默认带出该服务商目录的第一个模型
      setModels((m) => (m[id] ? m : { ...m, [id]: catalogs[id]?.entries[0]?.id ?? '' }))
    }
    setSelected(next)
  }

  const canRun =
    !running && selected.size >= 2 && [...selected].every((id) => (models[id] ?? '').trim().length > 0) && prompt.trim().length > 0

  const start = async () => {
    if (!canRun) return
    const compareId = `cmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const targets: CompareTarget[] = [...selected].map((providerId) => ({
      providerId,
      model: (models[providerId] ?? '').trim()
    }))
    const initial: CompareRow[] = targets.map((t) => {
      const p = providers.find((x) => x.id === t.providerId)!
      return {
        key: `${compareId}:${t.providerId}`,
        providerName: p.name || p.id,
        model: t.model,
        runId: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        status: 'running'
      }
    })
    setRows(initial)
    setRunning(true)
    setExpanded(undefined)

    const runOne = async (row: CompareRow, target: CompareTarget) => {
      const runId = row.runId
      runIdsRef.current.add(runId)
      try {
        const record = await window.api.runTest({
          providerId: target.providerId,
          model: target.model,
          stream,
          prompt,
          maxTokens: maxTokens ? Math.max(1, Number(maxTokens)) : undefined,
          compareId,
          runId
        })
        addRecord(record)
        return { rowKey: row.key, record }
      } catch (e) {
        return { rowKey: row.key, error: String((e as Error).message ?? e) }
      } finally {
        runIdsRef.current.delete(runId)
      }
    }

    const results = await Promise.all(initial.map((row, i) => runOne(row, targets[i])))
    setRows((prev) =>
      prev.map((row) => {
        const r = results.find((x) => x.rowKey === row.key)
        if (!r) return row
        if ('record' in r && r.record) return { ...row, status: 'done', record: r.record }
        return { ...row, status: 'error', invokeError: 'error' in r ? r.error : '未知错误' }
      })
    )
    setRunning(false)
    const okCount = results.filter((r) => 'record' in r && r.record?.ok).length
    setToast({ kind: 'info', text: `对比完成:${okCount}/${results.length} 个服务商成功` })
  }

  const stop = () => {
    for (const id of runIdsRef.current) void window.api.cancelTest(id)
  }

  const doneRows = useMemo(() => rows.filter((r) => r.status === 'done'), [rows])

  if (providers.length < 2) {
    return (
      <div>
        <h1>对比</h1>
        <Empty text="多服务商对比至少需要 2 个服务商配置。先到「服务商」页添加。" />
      </div>
    )
  }

  return (
    <div>
      <h1>对比</h1>
      <p className="muted">
        同一提示词并发发给多个服务商并排比较。并发数 = 所选服务商数(上限 {MAX_COMPARE}),不做自动重试;
        失败可能已在上游计费,请知悉。结果会以同一分组 ID 记入诊断历史。
      </p>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>选择服务商({selected.size}/{MAX_COMPARE})</h2>
        <table className="list">
          <thead>
            <tr>
              <th style={{ width: 40 }}>选择</th>
              <th>服务商</th>
              <th>协议</th>
              <th>模型 ID(每家各自填写)</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => {
              const checked = selected.has(p.id)
              return (
                <tr key={p.id}>
                  <td>
                    <input type="checkbox" checked={checked} onChange={() => toggleProvider(p.id)} />
                  </td>
                  <td>{p.name || p.id}</td>
                  <td className="muted">{p.protocol}</td>
                  <td>
                    {checked && (
                      <>
                        <input
                          type="text"
                          className="grow"
                          list={`cmp-models-${p.id}`}
                          value={models[p.id] ?? ''}
                          placeholder="模型 ID"
                          onChange={(e) => setModels((m) => ({ ...m, [p.id]: e.target.value }))}
                        />
                        <datalist id={`cmp-models-${p.id}`}>
                          {(catalogs[p.id]?.entries ?? []).map((m) => (
                            <option key={m.id} value={m.id} />
                          ))}
                        </datalist>
                      </>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <label className="field">共享提示词</label>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <div className="row" style={{ marginTop: 8 }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} />
            流式(对比首字延迟)
          </label>
          <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            输出上限
            <input type="number" min={1} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} style={{ width: 100 }} />
          </label>
          <button className="primary" onClick={() => void start()} disabled={!canRun}>
            {running ? '对比进行中…' : '开始对比'}
          </button>
          {running && (
            <button className="danger" onClick={stop}>
              停止全部
            </button>
          )}
        </div>
      </div>

      {rows.length > 0 && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>结果</h2>
          <table className="list">
            <thead>
              <tr>
                <th>服务商</th>
                <th>模型</th>
                <th>状态</th>
                <th>HTTP</th>
                <th>总耗时</th>
                <th>响应头</th>
                <th>首字延迟</th>
                <th>usage</th>
                <th>错误摘要</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const rec = row.record
                const best = doneRows.length > 1 && rec?.ok && rec.timing.totalMs != null
                  ? rec.timing.totalMs === Math.min(...doneRows.map((x) => x.record?.timing.totalMs ?? Infinity).filter((v) => v !== Infinity))
                  : false
                return (
                  <tr
                    key={row.key}
                    style={{ cursor: rec ? 'pointer' : 'default' }}
                    onClick={() => rec && setExpanded(expanded === row.key ? undefined : row.key)}
                  >
                    <td>
                      {row.providerName}
                      {best && <span className="badge ok">最快</span>}
                    </td>
                    <td><code style={{ fontSize: 12 }}>{row.model}</code></td>
                    <td>
                      {row.status === 'running' ? (
                        <span className="badge info">进行中</span>
                      ) : rec?.ok ? (
                        <span className="badge ok">成功</span>
                      ) : rec?.cancelled ? (
                        <span className="badge warn">取消</span>
                      ) : (
                        <span className="badge err">{rec?.phase ?? row.invokeError?.slice(0, 20) ?? '失败'}</span>
                      )}
                    </td>
                    <td>{rec?.httpStatus ?? '—'}</td>
                    <td>{rec?.timing.totalMs != null ? `${rec.timing.totalMs} ms` : '—'}</td>
                    <td>{rec?.timing.ttfbMs != null ? `${rec.timing.ttfbMs} ms` : '—'}</td>
                    <td>{rec?.timing.firstContentMs != null ? `${rec.timing.firstContentMs} ms` : '—'}</td>
                    <td className="muted" style={{ maxWidth: 150, wordBreak: 'break-all' }}>
                      {rec?.usage == null ? '上游未返回' : JSON.stringify(rec.usage)}
                    </td>
                    <td className="muted" style={{ maxWidth: 180, wordBreak: 'break-all' }}>
                      {rec?.errorMessage ?? row.invokeError ?? '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="muted">点击行展开完整详情(与单次测试相同的记录面板)。</div>
        </div>
      )}

      {expanded && (() => {
        const row = rows.find((r) => r.key === expanded)
        return row?.record ? <ResultPanel record={row.record} /> : null
      })()}
    </div>
  )
}
