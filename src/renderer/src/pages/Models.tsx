// 模型目录页：同步、手动添加、搜索、能力标注
import { useEffect, useMemo, useState } from 'react'
import type { ModelEntry } from '@shared/types'
import { useApp } from '../store'
import { Collapse, CopyButton, Empty } from '../components/common'

export default function ModelsPage() {
  const providers = useApp((s) => s.providers)
  const catalogs = useApp((s) => s.catalogs)
  const setCatalog = useApp((s) => s.setCatalog)
  const setToast = useApp((s) => s.setToast)
  const [selectedId, setSelectedId] = useState<string | undefined>(providers[0]?.id)
  const [query, setQuery] = useState('')
  const [manualId, setManualId] = useState('')
  const [syncing, setSyncing] = useState(false)

  const provider = providers.find((p) => p.id === selectedId)
  const catalog = selectedId ? catalogs[selectedId] : undefined

  // 首次进入时读取已存储的目录
  useEffect(() => {
    if (selectedId && !catalog) {
      void window.api.getModels(selectedId).then((c) => c && setCatalog(c))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  const filtered = useMemo(() => {
    if (!catalog) return []
    const q = query.trim().toLowerCase()
    const list = [...catalog.entries].sort((a, b) => a.id.localeCompare(b.id))
    return q ? list.filter((m) => m.id.toLowerCase().includes(q) || (m.ownedBy ?? '').toLowerCase().includes(q)) : list
  }, [catalog, query])

  const sync = async () => {
    if (!provider) return
    setSyncing(true)
    setToast({ kind: 'info', text: '正在同步模型目录…' })
    try {
      const c = await window.api.syncModels(provider.id)
      setCatalog(c)
      setToast(
        c.status === 'ok'
          ? { kind: 'ok', text: `同步成功，共 ${c.entries.length} 个模型` }
          : { kind: 'err', text: `同步失败：${c.error}` }
      )
    } finally {
      setSyncing(false)
    }
  }

  const addManual = async () => {
    const id = manualId.trim()
    if (!provider || !id) return
    const c = await window.api.saveModelEntry(provider.id, { id, origin: 'manual' })
    setCatalog(c)
    setManualId('')
    setToast({ kind: 'ok', text: `已添加手动模型 ${id}（标注为"用户手动指定"，能力尚未验证）` })
  }

  const markCapability = async (entry: ModelEntry, cap: 'tools' | 'vision', on: boolean) => {
    if (!provider) return
    const marked = new Set(entry.userMarkedCapabilities ?? [])
    if (on) marked.add(cap)
    else marked.delete(cap)
    const c = await window.api.saveModelEntry(provider.id, {
      ...entry,
      userMarkedCapabilities: [...marked]
    })
    setCatalog(c)
  }

  if (providers.length === 0) {
    return (
      <div>
        <h1>模型</h1>
        <Empty text="先在「服务商」页添加配置，然后回到这里同步模型目录。" />
      </div>
    )
  }

  return (
    <div>
      <h1>模型</h1>
      <div className="panel">
        <div className="row">
          <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} style={{ maxWidth: 260 }}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || p.id}
              </option>
            ))}
          </select>
          <button className="primary" onClick={() => void sync()} disabled={syncing || !provider}>
            {syncing && <span className="spin" />}同步模型目录
          </button>
          {catalog?.status === 'ok' && catalog.syncedAt && (
            <span className="badge ok">
              已同步 {new Date(catalog.syncedAt).toLocaleString('zh-CN')} · {catalog.entries.length} 个模型
            </span>
          )}
          {catalog?.status === 'error' && <span className="badge err">上次同步失败</span>}
        </div>
        {catalog?.error && <div className="notice err">同步错误：{catalog.error}。目录失败不影响手动发起测试：可在测试页手输模型 ID。</div>}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>手动添加模型</h2>
        <div className="row">
          <input
            type="text"
            className="grow"
            placeholder="模型 ID（如 gpt-4o-mini 或 mock-chat-mini）"
            value={manualId}
            onChange={(e) => setManualId(e.target.value)}
          />
          <button className="secondary" onClick={() => void addManual()} disabled={!manualId.trim() || !provider}>
            添加
          </button>
        </div>
        <div className="muted" style={{ marginTop: 4 }}>
          模型目录接口失败时仍可手动输入模型 ID 发起测试。手动添加的模型会标注为"用户手动指定"，能力未经测试验证。
        </div>
      </div>

      <div className="panel">
        <div className="row">
          <input
            type="text"
            className="grow"
            placeholder="搜索模型 ID 或所有者…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {catalog && <span className="muted">{filtered.length} / {catalog.entries.length}</span>}
        </div>

        {catalog && catalog.entries.length === 0 && catalog.status === 'ok' && (
          <Empty text="目录为空（上游返回空列表）。可在上方手动添加模型 ID。" />
        )}
        {!catalog && <Empty text="尚未同步目录。点击上方「同步模型目录」，或手动添加模型 ID。" />}

        {filtered.length > 0 && (
          <table className="list" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>模型 ID</th>
                <th>来源</th>
                <th>所有者</th>
                <th>能力标注</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => (
                <tr key={m.id}>
                  <td style={{ fontFamily: 'Menlo, monospace', fontSize: 12 }}>{m.id}</td>
                  <td>
                    {m.origin === 'manual' ? <span className="badge warn">手动指定</span> : <span className="badge info">目录同步</span>}
                  </td>
                  <td className="muted">{m.ownedBy ?? '—'}</td>
                  <td>
                    <CapabilityBadges entry={m} onMark={markCapability} providerId={provider?.id} />
                  </td>
                  <td>
                    {m.origin === 'manual' && provider && (
                      <button
                        className="danger small"
                        onClick={() => void window.api.deleteModelEntry(provider.id, m.id).then(setCatalog)}
                      >
                        删除
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {catalog?.rawPreview && (
        <div className="panel">
          <Collapse title="查看原始返回数据">
            <div className="row" style={{ marginBottom: 6 }}>
              {catalog.rawTruncated && <span className="badge warn">已截断（仅显示前 8KB）</span>}
              <CopyButton text={catalog.rawPreview} />
            </div>
            <pre className="code">{catalog.rawPreview}</pre>
          </Collapse>
        </div>
      )}
    </div>
  )
}

function CapabilityBadges({
  entry,
  onMark,
  providerId
}: {
  entry: ModelEntry
  onMark: (e: ModelEntry, cap: 'tools' | 'vision', on: boolean) => void
  providerId?: string
}) {
  const verified = entry.verifiedCapabilities ?? []
  const declared = entry.declaredCapabilities ?? []
  const marked = entry.userMarkedCapabilities ?? []
  return (
    <span style={{ lineHeight: 2 }}>
      {verified.includes('chat') && <span className="badge ok">对话已验证</span>}
      {verified.includes('tools') && <span className="badge ok">工具已验证</span>}
      {verified.includes('vision') && <span className="badge ok">视觉已验证</span>}
      {declared.includes('tools') && !verified.includes('tools') && <span className="badge dim" title="供应商元数据声明，未经实际测试">文档声明:工具</span>}
      {declared.includes('vision') && !verified.includes('vision') && <span className="badge dim" title="供应商元数据声明，未经实际测试">文档声明:视觉</span>}
      {marked.includes('tools') && !verified.includes('tools') && <span className="badge warn">用户标记:工具</span>}
      {marked.includes('vision') && !verified.includes('vision') && <span className="badge warn">用户标记:视觉</span>}
      {verified.length === 0 && declared.length === 0 && marked.length === 0 && <span className="badge dim">尚未验证</span>}
      {providerId && (
        <span style={{ marginLeft: 8 }}>
          <button className="secondary small" onClick={() => onMark(entry, 'tools', !marked.includes('tools'))}>
            {marked.includes('tools') ? '取消工具标记' : '标记支持工具'}
          </button>{' '}
          <button className="secondary small" onClick={() => onMark(entry, 'vision', !marked.includes('vision'))}>
            {marked.includes('vision') ? '取消视觉标记' : '标记支持视觉'}
          </button>
        </span>
      )}
    </span>
  )
}
