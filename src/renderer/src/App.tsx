import { useEffect } from 'react'
import { useApp, handleRunEvent, type Page } from './store'
import type { RunEvent } from '@shared/types'
import OverviewPage from './pages/Overview'
import ProvidersPage from './pages/Providers'
import ModelsPage from './pages/Models'
import TestPage from './pages/Test'
import ComparePage from './pages/Compare'
import PerfPage from './pages/Perf'
import HistoryPage from './pages/History'
import SettingsPage from './pages/Settings'

const NAV: { key: Page; label: string }[] = [
  { key: 'overview', label: '概览' },
  { key: 'providers', label: '服务商' },
  { key: 'models', label: '模型' },
  { key: 'test', label: '请求测试' },
  { key: 'compare', label: '对比' },
  { key: 'perf', label: '性能' },
  { key: 'history', label: '诊断历史' },
  { key: 'settings', label: '设置' }
]

export default function App() {
  const page = useApp((s) => s.page)
  const setPage = useApp((s) => s.setPage)
  const toast = useApp((s) => s.toast)
  const setAllAppInfo = useApp((s) => s.setAppInfo)
  const setProviders_ = useApp((s) => s.setProviders)
  const setSettings_ = useApp((s) => s.setSettings)

  // 启动初始化：应用信息 + 服务商 + 设置 + 运行事件订阅
  useEffect(() => {
    void window.api.getAppInfo().then(setAllAppInfo)
    void window.api.listProviders().then(setProviders_)
    void window.api.getSettings().then(setSettings_)
    const off = window.api.onRunEvent((ev) => handleRunEvent(ev as RunEvent))
    return off
    // 仅初始化一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="app">
      <nav className="nav">
        <div className="brand">API Workbench</div>
        {NAV.map((n) => (
          <button key={n.key} className={page === n.key ? 'active' : ''} onClick={() => setPage(n.key)}>
            {n.label}
          </button>
        ))}
      </nav>
      <main className="content">
        {page === 'overview' && <OverviewPage />}
        {page === 'providers' && <ProvidersPage />}
        {page === 'models' && <ModelsPage />}
        {page === 'test' && <TestPage />}
        {page === 'compare' && <ComparePage />}
        {page === 'perf' && <PerfPage />}
        {page === 'history' && <HistoryPage />}
        {page === 'settings' && <SettingsPage />}
      </main>
      {toast && <Toast kind={toast.kind} text={toast.text} />}
    </div>
  )
}

function Toast({ kind, text }: { kind: 'ok' | 'err' | 'info'; text: string }) {
  const setToast = useApp((s) => s.setToast)
  useEffect(() => {
    const t = setTimeout(() => setToast(undefined), 4000)
    return () => clearTimeout(t)
  }, [text, setToast])
  return <div style={{ position: 'fixed', bottom: 18, right: 18, maxWidth: 380 }}><div className={`notice ${kind}`}>{text}</div></div>
}
