// 请求测试页：P0 核心闭环
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TestParams, TestRunRecord } from '@shared/types'
import { PROTOCOL_LABELS } from '@shared/types'
import { useApp } from '../store'
import { Collapse, ErrorCopy, Empty } from '../components/common'

export default function TestPage() {
  const providers = useApp((s) => s.providers)
  const catalogs = useApp((s) => s.catalogs)
  const running = useApp((s) => s.running)
  const startRun = useApp((s) => s.startRun)
  const finishRun = useApp((s) => s.finishRun)
  const addRecord = useApp((s) => s.addRecord)
  const setToast = useApp((s) => s.setToast)

  const [providerId, setProviderId] = useState<string>(providers[0]?.id ?? '')
  const provider = providers.find((p) => p.id === providerId)

  const [model, setModel] = useState('')
  const [stream, setStream] = useState(false)
  const [prompt, setPrompt] = useState('你好，请用一句话介绍你自己。')
  const [maxTokens, setMaxTokens] = useState('64')
  const [useMaxTokens, setUseMaxTokens] = useState(true)
  const [temperature, setTemperature] = useState('')
  const [streamIncludeUsage, setStreamIncludeUsage] = useState(false)
  const [lastRecord, setLastRecord] = useState<TestRunRecord | undefined>(undefined)
  const runIdRef = useRef<string | undefined>(undefined)

  const modelOptions = useMemo(() => {
    const c = providerId ? catalogs[providerId] : undefined
    return c?.entries.map((m) => m.id) ?? []
  }, [catalogs, providerId])

  // 服务商列表异步到达后,若尚未选中则默认选第一个(避免 state 停留在空串导致请求静默无效)
  useEffect(() => {
    if (!providerId && providers.length > 0) {
      setProviderId(providers[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, providerId])

  if (providers.length === 0) {
    return (
      <div>
        <h1>请求测试</h1>
        <Empty text="先在「服务商」页添加配置，再回到这里发起测试。" />
      </div>
    )
  }

  const send = async () => {
    if (running) return
    if (!provider) {
      setToast({ kind: 'err', text: '服务商未就绪或未选择,请稍候再试' })
      return
    }
    const params: TestParams = {
      providerId: provider.id,
      model: model.trim(),
      stream,
      prompt,
      maxTokens: useMaxTokens && maxTokens ? Math.max(1, Number(maxTokens)) : undefined,
      temperature: temperature !== '' ? Number(temperature) : undefined,
      streamIncludeUsage: stream && streamIncludeUsage ? true : undefined
    }
    if (!params.model) {
      setToast({ kind: 'err', text: '请填写模型 ID(可从模型页同步,或直接手输)' })
      return
    }
    // 预生成 runId 并随参数下发:主进程用同一 ID 记录运行,取消按钮按它匹配
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    params.runId = runId
    runIdRef.current = runId
    startRun(runId)
    try {
      const record = await window.api.runTest(params)
      setLastRecord(record)
      addRecord(record)
    } catch (e) {
      setToast({ kind: 'err', text: String((e as Error).message ?? e) })
    } finally {
      finishRun()
      runIdRef.current = undefined
    }
  }

  const cancel = () => {
    const id = runIdRef.current
    if (id) void window.api.cancelTest(id)
  }

  return (
    <div>
      <h1>请求测试</h1>

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
          <div style={{ flex: 1, minWidth: 240 }}>
            <label className="field">
              模型 ID <small>（可选下拉项来自模型目录，也可直接输入）</small>
            </label>
            <input
              type="text"
              value={model}
              list="model-list"
              placeholder="如 mock-chat-mini"
              onChange={(e) => setModel(e.target.value)}
            />
            <datalist id="model-list">
              {modelOptions.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
        </div>

        <div className="row" style={{ marginTop: 8 }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} />
            流式响应
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={useMaxTokens} onChange={(e) => setUseMaxTokens(e.target.checked)} />
            限制输出
          </label>
          <input
            type="number"
            min={1}
            max={100000}
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)}
            style={{ width: 110 }}
            disabled={!useMaxTokens}
            title="max_tokens"
          />
          <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            temperature
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              placeholder="不发送"
              value={temperature}
              onChange={(e) => setTemperature(e.target.value)}
              style={{ width: 90 }}
            />
          </label>
          {stream && (
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={streamIncludeUsage} onChange={(e) => setStreamIncludeUsage(e.target.checked)} />
              请求 usage（stream_options.include_usage）
            </label>
          )}
        </div>

        <label className="field">提示词</label>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <div className="muted">提示词与响应正文可能包含私人信息，导出报告默认不包含（可主动选择）。</div>

        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => void send()} disabled={Boolean(running)}>
            {running ? '请求进行中…' : stream ? '发起流式请求' : '发起请求'}
          </button>
          {running && (
            <button className="danger" onClick={cancel}>
              取消请求
            </button>
          )}
          <span className="muted">
            {running ? `状态：${running.status}` : '参数只发送你明确设置的项；默认较低输出上限，避免无意消耗额度。'}
          </span>
        </div>
      </div>

      {running && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>流式输出 {running.status === 'streaming' && <span className="badge info">接收中</span>}</h2>
          <div className="stream-box">{running.text || `（等待首个内容片段…当前阶段：${running.status}）`}</div>
          <div className="muted" style={{ marginTop: 6 }}>
            首个内容片段延迟以非空内容到达为准，不含响应头时间。
          </div>
        </div>
      )}

      {lastRecord && <ResultPanel record={lastRecord} />}
    </div>
  )
}

// ---------- 结果面板 ----------

export function ResultPanel({ record }: { record: TestRunRecord }) {
  const st = record.stream ? '流式' : '非流式'
  const resultBadge = record.ok ? (
    <span className="badge ok">成功</span>
  ) : record.cancelled ? (
    <span className="badge warn">已取消</span>
  ) : (
    <span className="badge err">失败</span>
  )

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>结果 {resultBadge}</h2>

      <div className="kv" style={{ marginBottom: 12 }}>
        <span className="k">请求 ID</span>
        <span className="v">{record.id}</span>
        <span className="k">时间</span>
        <span className="v">{new Date(record.startedAt).toLocaleString('zh-CN')}</span>
        <span className="k">服务商</span>
        <span className="v">{record.providerName}</span>
        <span className="k">模型</span>
        <span className="v">{record.model}</span>
        <span className="k">协议</span>
        <span className="v">{PROTOCOL_LABELS[record.protocol]}（{st}）</span>
        <span className="k">HTTP 状态</span>
        <span className="v">{record.httpStatus ?? '—'}</span>
        <span className="k">总耗时</span>
        <span className="v">{fmt(record.timing.totalMs)}</span>
        <span className="k">响应头到达</span>
        <span className="v">{fmt(record.timing.ttfbMs)}</span>
        <span className="k">首个内容片段</span>
        <span className="v">{fmt(record.timing.firstContentMs)}</span>
        <span className="k">usage</span>
        <span className="v">{record.usage == null ? '上游未返回' : JSON.stringify(record.usage)}</span>
        {record.errorCode && (
          <>
            <span className="k">错误码</span>
            <span className="v">{record.errorCode}</span>
          </>
        )}
        {record.errorMessage && (
          <>
            <span className="k">错误信息</span>
            <span className="v">{record.errorMessage}</span>
          </>
        )}
      </div>

      {record.text && record.ok && (
        <>
          <h2>提取文本</h2>
          <div className="stream-box">{record.text}</div>
          {record.textTruncated && <div className="muted">（文本超过上限已截断）</div>}
        </>
      )}

      {record.diagnosis && (
        <>
          <h2>诊断</h2>
          <DiagnosisPanel d={record.diagnosis} />
        </>
      )}

      <h2>详情</h2>
      <Collapse title="请求详情（已脱敏）">
        <pre className="code">
          {record.request.method} {record.request.url}
          {'\n'}
          {Object.entries(record.request.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n')}
          {record.request.body != null && `\n\n${typeof record.request.body === 'string' ? record.request.body : JSON.stringify(record.request.body, null, 2)}`}
        </pre>
        <div className="muted">Authorization 等敏感头已替换为 ***REDACTED***。</div>
      </Collapse>

      {record.rawResponsePreview && (
        <Collapse title={`原始响应${record.rawTruncated ? '（已截断）' : ''}`}>
          <pre className="code">{record.rawResponsePreview}</pre>
        </Collapse>
      )}

      {record.errorBodyPreview && (
        <Collapse title="错误响应体片段">
          <ErrorCopy text={record.errorBodyPreview} />
        </Collapse>
      )}

      {record.streamEvents && record.streamEvents.length > 0 && (
        <Collapse title={`流事件日志（${record.streamEvents.length} 条${record.streamEventsTruncated ? '，已截断' : ''}）`}>
          <pre className="code">
            {record.streamEvents.map((e) => `#${e.seq} +${e.tMs}ms  ${e.data}`).join('\n')}
          </pre>
        </Collapse>
      )}
    </div>
  )
}

export function DiagnosisPanel({ d }: { d: import('@shared/types').Diagnosis }) {
  return (
    <div>
      <div className="panel" style={{ background: '#fafafa' }}>
        <strong>已观察到的事实</strong>
        <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
          {d.facts.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
        {d.possibleCauses.length > 0 && (
          <>
            <strong>可能原因</strong>
            <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
              {d.possibleCauses.map((c, i) => (
                <li key={i}>
                  <span className={`badge ${c.likelihood === 'high' ? 'err' : c.likelihood === 'medium' ? 'warn' : 'dim'}`}>
                    {c.likelihood === 'high' ? '可能性高' : c.likelihood === 'medium' ? '可能性中' : '可能性低'}
                  </span>{' '}
                  {c.cause}
                  {c.note && <div className="muted">{c.note}</div>}
                </li>
              ))}
            </ul>
          </>
        )}
        <strong>建议排查步骤</strong>
        <ol style={{ margin: '6px 0', paddingLeft: 18 }}>
          {d.suggestions.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
        <div className="muted">⚖️ {d.uncertainty}</div>
      </div>
    </div>
  )
}

function fmt(v?: number): string {
  return v == null ? '—' : `${v} ms`
}
