// 全局状态：zustand。渲染进程不持久化任何密钥；历史默认来自主进程。
import { create } from 'zustand'
import type { AppInfo, AppSettings, ModelCatalog, ProviderConfig, RunEvent, TestRunRecord } from '@shared/types'

export type Page = 'overview' | 'providers' | 'models' | 'test' | 'compare' | 'perf' | 'history' | 'settings'

export interface RunningTest {
  runId: string
  status: string
  text: string
  startedAt: number
}

interface AppState {
  page: Page
  setPage: (p: Page) => void

  appInfo?: AppInfo
  setAppInfo: (i: AppInfo) => void

  providers: ProviderConfig[]
  setProviders: (p: ProviderConfig[]) => void

  catalogs: Record<string, ModelCatalog>
  setCatalog: (c: ModelCatalog) => void

  settings: AppSettings | undefined
  setSettings: (s: AppSettings) => void

  /** 会话内测试历史（无论是否持久化，先显示在界面） */
  sessionHistory: TestRunRecord[]
  addRecord: (r: TestRunRecord) => void
  setSessionHistory: (rs: TestRunRecord[]) => void

  /** 当前运行中的测试（只支持一个并发测试窗口，防重复提交） */
  running: RunningTest | undefined
  startRun: (runId: string) => void
  updateRun: (partial: Partial<RunningTest>) => void
  finishRun: () => void

  toast: { kind: 'ok' | 'err' | 'info'; text: string } | undefined
  setToast: (t: AppState['toast']) => void
}

export const useApp = create<AppState>((set) => ({
  page: 'overview',
  setPage: (page) => set({ page }),

  appInfo: undefined,
  setAppInfo: (appInfo) => set({ appInfo }),

  providers: [],
  setProviders: (providers) => set({ providers }),

  catalogs: {},
  setCatalog: (c) => set((s) => ({ catalogs: { ...s.catalogs, [c.providerId]: c } })),

  settings: undefined,
  setSettings: (settings) => set({ settings }),

  sessionHistory: [],
  addRecord: (r) => set((s) => ({ sessionHistory: [r, ...s.sessionHistory] })),
  setSessionHistory: (sessionHistory) => set({ sessionHistory }),

  running: undefined,
  startRun: (runId) => set({ running: { runId, status: 'connecting', text: '', startedAt: Date.now() } }),
  updateRun: (partial) => set((s) => (s.running ? { running: { ...s.running, ...partial } } : {})),
  finishRun: () => set({ running: undefined }),

  toast: undefined,
  setToast: (toast) => set({ toast })
}))

/** 处理来自主进程的运行事件（最终记录由 runTest 的 Promise 返回） */
export function handleRunEvent(ev: RunEvent): void {
  const st = useApp.getState()
  if (ev.type === 'status') {
    if (st.running?.runId === ev.runId) {
      st.updateRun({ status: ev.status })
    }
  } else if (ev.type === 'text-delta') {
    if (st.running?.runId === ev.runId) {
      st.updateRun({ text: st.running.text + ev.delta, status: 'streaming' })
    }
  }
}
