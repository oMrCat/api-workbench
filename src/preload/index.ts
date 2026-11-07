// Preload：以最小面暴露主进程能力。
// 只有白名单方法，不暴露 ipcRenderer 原始对象，不暴露任意文件/命令接口。

import { contextBridge, ipcRenderer } from 'electron'
// sandbox 下 preload 只能 require('electron')：通道名必须来自零依赖模块
import { IPC } from '@shared/ipc-channels'

// 所有方法名与通道固定白名单；参数由主进程侧 zod 校验二次把关
const api = {
  // 应用信息
  getAppInfo: () => ipcRenderer.invoke(IPC.AppInfo),

  // 服务商配置
  listProviders: () => ipcRenderer.invoke(IPC.ProvidersList),
  saveProvider: (p: unknown) => ipcRenderer.invoke(IPC.ProvidersSave, p),
  deleteProvider: (id: string) => ipcRenderer.invoke(IPC.ProvidersDelete, id),

  // 密钥（只传明文给主进程，绝不从主进程拿回明文；预览仅末 4 位）
  getSecretsStatus: () => ipcRenderer.invoke(IPC.SecretsStatus),
  setSecret: (providerId: string, value: string) => ipcRenderer.invoke(IPC.SecretSet, providerId, value),
  getSecretPreview: (providerId: string) => ipcRenderer.invoke(IPC.SecretGetPreview, providerId),
  deleteSecret: (providerId: string) => ipcRenderer.invoke(IPC.SecretDelete, providerId),

  // 模型目录
  syncModels: (providerId: string) => ipcRenderer.invoke(IPC.ModelsSync, providerId),
  getModels: (providerId: string) => ipcRenderer.invoke(IPC.ModelsGet, providerId),
  saveModelEntry: (providerId: string, entry: unknown) => ipcRenderer.invoke(IPC.ModelsSaveEntry, providerId, entry),
  deleteModelEntry: (providerId: string, modelId: string) => ipcRenderer.invoke(IPC.ModelsDeleteEntry, providerId, modelId),

  // 请求测试
  runTest: (params: unknown) => ipcRenderer.invoke(IPC.TestRun, params),
  cancelTest: (runId: string) => ipcRenderer.invoke(IPC.TestCancel, runId),
  onRunEvent: (handler: (ev: unknown) => void) => {
    const listener = (_e: unknown, ev: unknown) => handler(ev)
    ipcRenderer.on(IPC.RunEvent, listener)
    return () => {
      ipcRenderer.removeListener(IPC.RunEvent, listener)
    }
  },

  // 历史
  listHistory: () => ipcRenderer.invoke(IPC.HistoryList),
  deleteHistory: (id: string) => ipcRenderer.invoke(IPC.HistoryDelete, id),
  clearHistory: () => ipcRenderer.invoke(IPC.HistoryClear),

  // 设置
  getSettings: () => ipcRenderer.invoke(IPC.SettingsGet),
  setSettings: (s: unknown) => ipcRenderer.invoke(IPC.SettingsSet, s),

  // 导出与报告
  exportReport: (opts: unknown) => ipcRenderer.invoke(IPC.ExportReport, opts),
  curlSample: (recordId: string) => ipcRenderer.invoke(IPC.CurlSample, recordId),

  // 受控外链
  openExternal: (url: string) => ipcRenderer.invoke(IPC.OpenExternal, url),

  // 模拟服务
  mockStart: () => ipcRenderer.invoke(IPC.MockStart),
  mockStop: () => ipcRenderer.invoke(IPC.MockStop),
  mockStatus: () => ipcRenderer.invoke(IPC.MockStatus)
} as const

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
