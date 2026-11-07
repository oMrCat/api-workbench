// 诊断历史页：会话+持久化记录、导出、脱敏 curl
import { useEffect, useState } from 'react'
import type { TestRunRecord } from '@shared/types'
import { useApp } from '../store'
import { Collapse, CopyButton, Empty } from '../components/common'
import { ResultPanel } from './Test'

export default function HistoryPage() {
  const sessionHistory = useApp((s) => s.sessionHistory)
  const setSessionHistory = useApp((s) => s.setSessionHistory)
  const settings = useApp((s) => s.settings)
  const setToast = useApp((s) => s.setToast)
  const [persisted, setPersisted] = useState<TestRunRecord[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [includeBodies, setIncludeBodies] = useState(false)

  const refresh = async () => {
    if (settings?.persistHistory) setPersisted(await window.api.listHistory())
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.persistHistory])

  const all = mergeRecords(sessionHistory, persisted)

  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const exportReport = async (format: 'markdown' | 'json') => {
    const ids = selected.size > 0 ? [...selected] : all.map((r) => r.id)
    if (ids.length === 0) {
      setToast({ kind: 'err', text: '没有可导出的记录' })
      return
    }
    const r = await window.api.exportReport({ recordIds: ids, format, includeBodies })
    if (r.ok) setToast({ kind: 'ok', text: `已导出：${r.path}` })
    else if (r.cancelled) setToast({ kind: 'info', text: '已取消导出' })
    else setToast({ kind: 'err', text: `导出失败：${r.error}` })
  }

  const showCurl = async (id: string) => {
    const sample = await window.api.curlSample(id)
    setToast({ kind: 'info', text: 'curl 示例已生成，见下方面板' })
    setCurlText(sample)
  }
  const [curlText, setCurlText] = useState<string | undefined>(undefined)

  const removeOne = async (id: string) => {
    setPersisted(await window.api.deleteHistory(id))
    setSessionHistory(sessionHistory.filter((r) => r.id !== id))
    selected.delete(id)
    setSelected(new Set(selected))
    setToast({ kind: 'info', text: '已删除该条记录' })
  }

  const clearAll = async () => {
    if (!window.confirm('确认清空全部持久化历史记录？此操作不可撤销（本次会话内记录不受影响）。')) return
    setPersisted(await window.api.clearHistory())
    setToast({ kind: 'info', text: '已清空持久化历史' })
  }

  return (
    <div>
      <h1>诊断历史</h1>

      <div className="panel">
        <div className="row">
          <span className="muted">
            已选 {selected.size} 条（不选则导出全部 {all.length} 条） · 持久化：{settings?.persistHistory ? '开' : '关（仅本会话）'}
          </span>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={includeBodies} onChange={(e) => setIncludeBodies(e.target.checked)} />
            包含提示词与响应正文
          </label>
          <button className="primary" onClick={() => void exportReport('markdown')}>
            导出 Markdown
          </button>
          <button className="primary" onClick={() => void exportReport('json')}>
            导出 JSON
          </button>
          <button className="danger" onClick={() => void clearAll()}>
            清空持久化历史
          </button>
        </div>
        {includeBodies && (
          <div className="notice warn">
            已勾选包含正文：提示词与响应正文可能包含私人信息，导出前会再次弹窗确认。密钥仍会脱敏。
          </div>
        )}
        <div className="muted" style={{ marginTop: 6 }}>
          报告默认脱敏：Authorization / API Key / Cookie / 自定义敏感头 / URL 敏感参数 / 已知密钥字符串 → ***REDACTED***
        </div>
      </div>

      {all.length === 0 && <Empty text="还没有请求记录。去「请求测试」页发起一次测试。" />}

      {all.length > 0 && (
        <div className="panel">
          <table className="list">
            <thead>
              <tr>
                <th style={{ width: 36 }} />
                <th>时间</th>
                <th>服务商 / 模型</th>
                <th>方式</th>
                <th>HTTP</th>
                <th>耗时</th>
                <th>结果</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {all.map((r) => (
                <tr key={r.id}>
                  <td>
                    <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                  </td>
                  <td className="muted">{new Date(r.startedAt).toLocaleString('zh-CN')}</td>
                  <td>
                    {r.providerName} / <code style={{ fontSize: 12 }}>{r.model}</code>
                  </td>
                  <td>{r.stream ? '流式' : '非流式'}</td>
                  <td>{r.httpStatus ?? '—'}</td>
                  <td>{r.timing.totalMs != null ? `${r.timing.totalMs} ms` : '—'}</td>
                  <td>
                    {r.ok ? (
                      <span className="badge ok">成功</span>
                    ) : r.cancelled ? (
                      <span className="badge warn">取消</span>
                    ) : (
                      <span className="badge err">{r.phase}</span>
                    )}
                    {r.compareId && <span className="badge info" style={{ marginLeft: 4 }}>对比组</span>}
                    {r.perfId && <span className="badge dim" style={{ marginLeft: 4 }}>性能组</span>}
                  </td>
                  <td>
                    <button className="secondary small" onClick={() => void showCurl(r.id)}>
                      curl
                    </button>{' '}
                    <button className="danger small" onClick={() => void removeOne(r.id)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {curlText && (
        <div className="panel">
          <div className="row">
            <h2 style={{ margin: 0 }}>脱敏 curl 复现示例</h2>
            <CopyButton text={curlText} />
            <button className="secondary small" onClick={() => setCurlText(undefined)}>
              关闭
            </button>
          </div>
          <div className="notice warn">
            ⚠️ 命令中的 <code>$API_WORKBENCH_KEY</code> 是占位符。替换为真实密钥后才能运行；在共享终端运行会留下 shell
            历史记录，请注意。
          </div>
          <pre className="code">{curlText}</pre>
        </div>
      )}

      {all.length > 0 && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>记录详情</h2>
          {all.map((r) => (
            <Collapse key={r.id} title={`${new Date(r.startedAt).toLocaleString('zh-CN')} · ${r.providerName} · ${r.model} · ${r.ok ? '成功' : r.cancelled ? '取消' : r.phase}`}>
              <ResultPanel record={r} />
            </Collapse>
          ))}
        </div>
      )}
    </div>
  )
}

/** 合并会话与持久化记录，按时间倒序，按 id 去重 */
function mergeRecords(session: TestRunRecord[], persisted: TestRunRecord[]): TestRunRecord[] {
  const map = new Map<string, TestRunRecord>()
  for (const r of persisted) map.set(r.id, r)
  for (const r of session) map.set(r.id, r)
  return [...map.values()].sort((a, b) => b.startedAt - a.startedAt)
}
