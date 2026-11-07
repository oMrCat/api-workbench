// 设置页
import { useState } from 'react'
import type { AppSettings } from '@shared/types'
import { useApp } from '../store'

export default function SettingsPage() {
  const settings = useApp((s) => s.settings)
  const setSettings = useApp((s) => s.setSettings)
  const appInfo = useApp((s) => s.appInfo)
  const setToast = useApp((s) => s.setToast)
  const [local, setLocal] = useState<AppSettings | undefined>(undefined)

  if (!settings) {
    return (
      <div>
        <h1>设置</h1>
        <div>
          <span className="spin" /> 读取中…
        </div>
      </div>
    )
  }

  const s = local ?? settings

  const save = async () => {
    const saved = await window.api.setSettings(s)
    setSettings(saved)
    setLocal(undefined)
    setToast({ kind: 'ok', text: '设置已保存' })
  }

  return (
    <div>
      <h1>设置</h1>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>历史记录</h2>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={s.persistHistory}
            onChange={(e) => setLocal({ ...s, persistHistory: e.target.checked })}
          />
          持久化历史记录到磁盘（记录已脱敏，不包含密钥；提示词正文仍会写入本地，如介意请关闭）
        </label>
        <label className="field">历史条数上限</label>
        <input
          type="number"
          min={10}
          max={5000}
          value={s.historyLimit}
          onChange={(e) => setLocal({ ...s, historyLimit: Number(e.target.value) })}
          style={{ width: 160 }}
        />
        <div className="muted">超出后自动丢弃最旧记录。</div>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>流式响应</h2>
        <label className="field">流事件日志上限（条）</label>
        <input
          type="number"
          min={10}
          max={5000}
          value={s.streamLogLimit}
          onChange={(e) => setLocal({ ...s, streamLogLimit: Number(e.target.value) })}
          style={{ width: 160 }}
        />
        <div className="muted">超过上限的流事件不再记录（响应内容仍完整显示），防止大响应撑爆内存。</div>

        <label className="field">流空闲超时（毫秒）</label>
        <input
          type="number"
          min={3000}
          max={300000}
          step={1000}
          value={s.streamIdleTimeoutMs}
          onChange={(e) => setLocal({ ...s, streamIdleTimeoutMs: Number(e.target.value) })}
          style={{ width: 160 }}
        />
        <div className="muted">连续无数据超过该时长判定为流中断，防止上游挂起无响应。</div>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>数据与安全</h2>
        <div className="kv">
          <span className="k">配置存储位置</span>
          <span className="v muted">{appInfo?.userDataPath ?? '—'}</span>
          <span className="k">密钥存储</span>
          <span className="v">{appInfo?.secretStore.mode === 'system' ? '系统安全存储' : '仅会话内存（系统安全存储不可用）'}</span>
        </div>
        {appInfo?.secretStore.reason && <div className="notice warn">{appInfo.secretStore.reason}</div>}
        <div className="muted" style={{ marginTop: 8, lineHeight: 1.7 }}>
          普通配置（providers.json）、模型目录（models.json）、历史（history.json）、设置（settings.json）以普通 JSON
          存储于用户数据目录；密钥（secrets.json）单独存储且加密。历史记录与导出报告默认脱敏。
        </div>
      </div>

      {local && (
        <div className="row">
          <button className="primary" onClick={() => void save()}>
            保存设置
          </button>
          <button className="secondary" onClick={() => setLocal(undefined)}>
            还原
          </button>
        </div>
      )}
      {!local && <div className="muted">修改任意项后出现保存按钮。</div>}
    </div>
  )
}
