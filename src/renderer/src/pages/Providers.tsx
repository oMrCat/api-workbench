// 服务商配置页：增删改、密钥管理、URL 预览
import { useEffect, useState } from 'react'
import type { CustomHeader, ProviderConfig, ProtocolKind } from '@shared/types'
import { PROTOCOL_LABELS } from '@shared/types'
import { useApp } from '../store'
import { CopyButton, Empty } from '../components/common'
import { joinUrl } from '@shared/url'

const PROTOCOLS: ProtocolKind[] = ['openai-chat', 'anthropic-messages'] // openai-responses 为 P1 后续项

function blankProvider(): ProviderConfig {
  return {
    id: `p-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    baseUrl: '',
    protocol: 'openai-chat',
    headers: [],
    timeoutMs: 60000,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

export default function ProvidersPage() {
  const providers = useApp((s) => s.providers)
  const setProviders = useApp((s) => s.setProviders)
  const setToast = useApp((s) => s.setToast)
  const [editing, setEditing] = useState<ProviderConfig | undefined>(undefined)
  const [keyInput, setKeyInput] = useState('')
  const [keyPreviews, setKeyPreviews] = useState<Record<string, { exists: boolean; preview?: string; source: string }>>({})

  const refreshKeys = async (list: ProviderConfig[]) => {
    const out: Record<string, { exists: boolean; preview?: string; source: string }> = {}
    for (const p of list) out[p.id] = await window.api.getSecretPreview(p.id)
    setKeyPreviews(out)
  }

  useEffect(() => {
    void refreshKeys(providers)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.length])

  const save = async () => {
    if (!editing) return
    const r = await window.api.saveProvider(editing)
    const arr = (r as { providers: ProviderConfig[] }).providers
    setProviders(arr)
    setToast({ kind: 'ok', text: `已保存「${editing.name || editing.id}」` })
    if ((r as { warning?: string }).warning) {
      setToast({ kind: 'err', text: (r as { warning: string }).warning })
    }
    setEditing(undefined)
  }

  const remove = async (p: ProviderConfig) => {
    const ok = window.confirm(`确认删除服务商「${p.name || p.id}」？\n其保存的 API Key、模型目录缓存将一并删除，此操作不可撤销。`)
    if (!ok) return
    setProviders(await window.api.deleteProvider(p.id))
    setToast({ kind: 'info', text: '已删除' })
  }

  const saveKey = async (p: ProviderConfig) => {
    if (!keyInput.trim()) {
      setToast({ kind: 'err', text: '请先在输入框填写密钥' })
      return
    }
    const r = await window.api.setSecret(p.id, keyInput.trim())
    setKeyInput('')
    if (r.ok) {
      setToast({ kind: 'ok', text: '密钥已保存（不进入日志与报告）' })
      void refreshKeys(providers)
    } else {
      setToast({ kind: 'err', text: `保存失败：${r.error}` })
    }
  }

  return (
    <div>
      <h1>服务商</h1>
      <p className="muted">不绑定任何特定供应商。支持 OpenAI 兼容协议（P0）；Responses / Anthropic Messages 将在 P1 增加。</p>

      {providers.length === 0 && !editing && (
        <Empty text="还没有服务商配置。点击下方按钮添加，或先在概览页启动本地模拟服务。" />
      )}

      <div className="row" style={{ marginBottom: 12 }}>
        <button
          className="secondary"
          onClick={() => {
            void window.api.exportProviders().then((r) => {
              if (r.ok) setToast({ kind: 'ok', text: `配置已导出:${r.path}` })
              else if (r.cancelled) setToast({ kind: 'info', text: '已取消导出' })
              else setToast({ kind: 'err', text: `导出失败:${r.error}` })
            })
          }}
        >
          导出配置(JSON,不含密钥)
        </button>
        <button
          className="secondary"
          onClick={() => {
            void window.api.importProviders().then((r) => {
              if (r.ok) {
                void window.api.listProviders().then(setProviders)
                setToast({
                  kind: r.invalid.length > 0 ? 'info' : 'ok',
                  text: `导入完成:成功 ${r.imported},跳过(已存在) ${r.skipped},无效 ${r.invalid.length}。密钥需重新录入。`
                })
              } else if (r.cancelled) setToast({ kind: 'info', text: '已取消导入' })
              else setToast({ kind: 'err', text: `导入失败:${r.error}` })
            })
          }}
        >
          导入配置
        </button>
        <span className="muted">导出文件不含任何 API Key;导入后需重新录入密钥。</span>
      </div>

      {providers.length > 0 && (
        <div className="panel">
          <table className="list">
            <thead>
              <tr>
                <th>名称</th>
                <th>Base URL</th>
                <th>协议</th>
                <th>密钥</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td>{p.name || p.id}</td>
                  <td className="muted" style={{ wordBreak: 'break-all', maxWidth: 320 }}>{p.baseUrl}</td>
                  <td>
                    <span className="badge info">{PROTOCOL_LABELS[p.protocol]}</span>
                  </td>
                  <td>
                    {keyPreviews[p.id]?.exists ? (
                      <span>
                        <span className="badge ok">已保存 {keyPreviews[p.id].preview}</span>
                        {keyPreviews[p.id].source === 'memory' && <span className="badge warn">仅内存</span>}
                        <button
                          className="danger small"
                          style={{ marginLeft: 6 }}
                          onClick={() => {
                            void window.api.deleteSecret(p.id).then(() => refreshKeys(providers))
                          }}
                        >
                          删除密钥
                        </button>
                      </span>
                    ) : (
                      <span className="badge dim">未设置</span>
                    )}
                  </td>
                  <td>
                    <button className="secondary small" onClick={() => setEditing(structuredClone(p))}>
                      编辑
                    </button>{' '}
                    <button className="danger small" onClick={() => void remove(p)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!editing && (
        <button className="primary" onClick={() => setEditing(blankProvider())}>
          ＋ 添加服务商
        </button>
      )}

      {editing && <Editor editing={editing} setEditing={setEditing} onSave={() => void save()} />}
    </div>
  )

  // ---------- 编辑器 ----------

  function Editor({
    editing,
    setEditing,
    onSave
  }: {
    editing: ProviderConfig
    setEditing: (p: ProviderConfig | undefined) => void
    onSave: () => void
  }) {
    const [headers, setHeaders] = useState<CustomHeader[]>(editing.headers)
    const upd = (patch: Partial<ProviderConfig>) => setEditing({ ...editing, ...patch })

    // 最终 URL 预览（渲染进程本地拼接，与主进程同一实现）
    const urlPreview = (() => {
      try {
        const path = editing.protocol === 'openai-chat' ? editing.chatPath || '/v1/chat/completions' : ''
        return path ? joinUrl(editing.baseUrl, path) : ''
      } catch (e) {
        return `（无效：${(e as Error).message}）`
      }
    })()
    const plainWarn = editing.baseUrl ? plainHttpWarn(editing.baseUrl) : null
    // 客户端 URL 有效性（http/https），无效时禁止保存（主进程 zod 仍是最终防线）
    const urlValid = (() => {
      try {
        const u = new URL(editing.baseUrl)
        return u.protocol === 'http:' || u.protocol === 'https:'
      } catch {
        return false
      }
    })()

    return (
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>{editing.name ? '编辑服务商' : '添加服务商'}</h2>

        <div className="row">
          <div style={{ flex: 1, minWidth: 220 }}>
            <label className="field">显示名称</label>
            <input
              type="text"
              value={editing.name}
              placeholder="如：本地模拟服务"
              onChange={(e) => upd({ name: e.target.value })}
            />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label className="field">协议类型</label>
            <select value={editing.protocol} onChange={(e) => upd({ protocol: e.target.value as ProtocolKind })}>
              {PROTOCOLS.map((k) => (
                <option key={k} value={k}>
                  {PROTOCOL_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label className="field">
          Base URL <small>（如 https://api.example.com 或 http://127.0.0.1:8045；末尾是否带 /v1 均可，应用会自动处理重复路径）</small>
        </label>
        <input
          type="text"
          value={editing.baseUrl}
          placeholder="https://api.example.com"
          onChange={(e) => upd({ baseUrl: e.target.value.trim() })}
        />
        {plainWarn && <div className="notice warn">{plainWarn}</div>}

        <div className="row" style={{ marginTop: 10 }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label className="field">超时时间（毫秒）</label>
            <input type="number" min={1000} max={600000} value={editing.timeoutMs} onChange={(e) => upd({ timeoutMs: Number(e.target.value) })} />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label className="field">
              模型目录路径覆盖 <small>（可选，默认 /v1/models）</small>
            </label>
            <input type="text" value={editing.modelsPath ?? ''} placeholder="/v1/models" onChange={(e) => upd({ modelsPath: e.target.value || undefined })} />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label className="field">
              API 路径覆盖 <small>（可选，默认 /v1/chat/completions）</small>
            </label>
            <input type="text" value={editing.chatPath ?? ''} placeholder="/v1/chat/completions" onChange={(e) => upd({ chatPath: e.target.value || undefined })} />
          </div>
        </div>

        <h2>自定义请求头</h2>
        <p className="muted">值为敏感信息（如另一套网关的 Key）请勾选"敏感"，日志与报告会将其脱敏。</p>
        <table className="list">
          <thead>
            <tr>
              <th style={{ width: '30%' }}>名称</th>
              <th>值</th>
              <th style={{ width: 70 }}>敏感</th>
              <th style={{ width: 60 }} />
            </tr>
          </thead>
          <tbody>
            {headers.map((h, i) => (
              <tr key={i}>
                <td>
                  <input
                    type="text"
                    value={h.name}
                    onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={h.value}
                    onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={h.sensitive}
                    onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, sensitive: e.target.checked } : x)))}
                  />
                </td>
                <td>
                  <button className="danger small" onClick={() => setHeaders(headers.filter((_, j) => j !== i))}>
                    删
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="secondary small" style={{ marginTop: 6 }} onClick={() => setHeaders([...headers, { name: '', value: '', sensitive: false }])}>
          ＋ 添加请求头
        </button>

        <h2>API Key</h2>
        <div className="row">
          <input
            type="password"
            className="grow"
            placeholder="粘贴密钥（保存到系统安全存储，不会显示原文）"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <button className="primary" onClick={() => void saveKey(editing)}>
            保存密钥
          </button>
        </div>
        <div className="muted" style={{ marginTop: 4 }}>
          密钥不会写入配置文件、日志或导出报告；保存后只显示末 4 位预览。
        </div>

        <h2>最终请求地址预览</h2>
        {urlPreview && (
          <div className="row">
            <pre className="code grow" style={{ margin: 0 }}>
              {urlPreview}
            </pre>
            <CopyButton text={urlPreview} />
          </div>
        )}
        <div className="muted">密钥等敏感参数不会出现在预览中。</div>

        <div className="row" style={{ marginTop: 16 }}>
          <button className="primary" onClick={onSave} disabled={!editing.name || !editing.baseUrl || !urlValid}>
            保存配置
          </button>
          <button className="secondary" onClick={() => setEditing(undefined)}>
            取消
          </button>
        </div>
      </div>
    )
  }
}

function plainHttpWarn(url: string): string | null {
  try {
    const u = new URL(url)
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1' || u.hostname.startsWith('127.')
    if (u.protocol === 'http:' && !loopback) {
      return '⚠️ 该地址为明文 HTTP 且非本机服务，密钥与内容可能被网络中间人窃听。建议使用 HTTPS。'
    }
    return null
  } catch {
    return null
  }
}
