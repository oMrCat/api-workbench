// Electron 主进程入口：窗口创建、IPC 注册、生命周期与退出清理。
// 安全基线：contextIsolation + sandbox + 最小 preload API + CSP。

import { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } from 'electron'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'

import type { AppInfo, AppSettings, ExportOptions, ExportResult, ModelEntry, ProviderConfig, RunEvent, TestParams } from '@shared/types'
import { IPC, providerConfigSchema, testParamsSchema, exportOptionsSchema, urlSchema } from '@shared/ipc-contract'

import { ConfigStore } from './store/config-store'
import { SecretStore, type SafeStorageLike } from './store/secret-store'
import { OpenAiChatAdapter } from './protocols/openai-chat'
import { TestRunner } from './runner/test-runner'
import { classifyFetchError, timedFetch } from './net/http-client'
import { plainHttpWarning } from '@shared/url'
import { buildCurlSample, buildJsonReport, buildMarkdownReport } from './report/export'

let win: BrowserWindow | null = null
let store: ConfigStore
let secrets: SecretStore
let runner: TestRunner
let mockChild: ChildProcess | null = null
let mockPort = 0

const CHAT_ADAPTERS = { 'openai-chat': new OpenAiChatAdapter() } as const
function adapterFor(protocol: string) {
  const a = (CHAT_ADAPTERS as Record<string, OpenAiChatAdapter | undefined>)[protocol]
  if (!a) throw new Error(`暂不支持的协议：${protocol}（P1 计划中）`)
  return a
}

// ---------- 单例 IPC 参数校验辅助 ----------

function getValidated<T>(schema: { parse: (v: unknown) => T }, data: unknown): T {
  // zod v4：parse 失败抛 ZodError，转成可读消息
  try {
    return schema.parse(data)
  } catch (e: any) {
    const issues = e?.issues?.map((i: any) => `${i.path?.join('.') ?? ''}: ${i.message}`).join('; ')
    throw new Error(`参数校验失败：${issues ?? String(e)}`)
  }
}

function senderIsTrusted(event: Electron.IpcMainInvokeEvent): boolean {
  // 只接受来自应用自身窗口的调用
  return event.senderFrame?.url.startsWith('file://') ?? false
}

function registerIpc(): void {
  const handle = (channel: string, fn: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!senderIsTrusted(event)) throw new Error('拒绝非受信来源的 IPC 调用')
      return fn(event, ...args)
    })
  }

  handle(IPC.AppInfo, (): AppInfo => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? '',
    nodeVersion: process.versions.node ?? '',
    chromeVersion: process.versions.chrome ?? '',
    platform: process.platform,
    arch: process.arch,
    userDataPath: app.getPath('userData'),
    secretStore: secrets.getStatus()
  }))

  handle(IPC.ProvidersList, () => store.listProviders())

  handle(IPC.ProvidersSave, (_e, data: unknown) => {
    const p = getValidated(providerConfigSchema, data) as ProviderConfig
    const warn = plainHttpWarning(p.baseUrl)
    const saved = store.saveProvider({ ...p, updatedAt: Date.now() })
    return { providers: saved, warning: warn }
  })

  handle(IPC.ProvidersDelete, (_e, id: unknown) => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('非法的服务商 ID')
    void secrets.deleteSecret(id) // 级联删除密钥
    return store.deleteProvider(id)
  })

  handle(IPC.SecretsStatus, () => secrets.getStatus())

  handle(IPC.SecretSet, (_e, providerId: unknown, value: unknown) => {
    if (typeof providerId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(providerId)) throw new Error('非法的服务商 ID')
    if (typeof value !== 'string' || value.length > 8192) throw new Error('非法的密钥值')
    return secrets.setSecret(providerId, value)
  })

  handle(IPC.SecretGetPreview, (_e, providerId: unknown) => {
    if (typeof providerId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(providerId)) throw new Error('非法的服务商 ID')
    return secrets.getSecretPreview(providerId)
  })

  handle(IPC.SecretDelete, (_e, providerId: unknown) => {
    if (typeof providerId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(providerId)) throw new Error('非法的服务商 ID')
    return secrets.deleteSecret(providerId)
  })

  handle(IPC.ModelsSync, async (_e, providerId: unknown) => {
    if (typeof providerId !== 'string') throw new Error('非法参数')
    const provider = store.getProvider(providerId)
    if (!provider) throw new Error('服务商不存在')
    const adapter = adapterFor(provider.protocol)
    const apiKey = secrets.getSecret(providerId)
    const built = adapter.buildModelsRequest(provider, apiKey)
    const startedAt = Date.now()
    try {
      const { response, ttfbMs } = await timedFetch(
        built.url,
        { method: built.method, headers: built.headers },
        { timeoutMs: provider.timeoutMs }
      )
      const bodyText = await response.text()
      if (!response.ok) {
        const catalog = {
          providerId,
          entries: [],
          status: 'error' as const,
          syncedAt: startedAt,
          error: `HTTP ${response.status}（响应头 ${ttfbMs}ms）`,
          rawPreview: bodyText.slice(0, 8000)
        }
        store.saveCatalog(catalog)
        return catalog
      }
      const parsed = adapter.parseModelsResponse(bodyText)
      const catalog = {
        providerId,
        entries: parsed.entries,
        status: parsed.error ? ('error' as const) : ('ok' as const),
        syncedAt: startedAt,
        error: parsed.error,
        rawPreview: bodyText.slice(0, 8000),
        rawTruncated: bodyText.length > 8000
      }
      store.saveCatalog(catalog)
      return catalog
    } catch (err) {
      const cls = classifyFetchError(err)
      const catalog = {
        providerId,
        entries: [],
        status: 'error' as const,
        syncedAt: startedAt,
        error: `${cls.message}（${cls.code}）`
      }
      store.saveCatalog(catalog)
      return catalog
    }
  })

  handle(IPC.ModelsGet, (_e, providerId: unknown) => {
    if (typeof providerId !== 'string') throw new Error('非法参数')
    return store.getCatalog(providerId)
  })

  handle(IPC.ModelsSaveEntry, (_e, providerId: unknown, entry: unknown) => {
    if (typeof providerId !== 'string' || !entry || typeof entry !== 'object') throw new Error('非法参数')
    const e = entry as ModelEntry
    if (typeof e.id !== 'string' || e.id.length === 0 || e.id.length > 300) throw new Error('模型 ID 非法')
    return store.upsertManualModel(providerId, { ...e, origin: 'manual' })
  })

  handle(IPC.ModelsDeleteEntry, (_e, providerId: unknown, modelId: unknown) => {
    if (typeof providerId !== 'string' || typeof modelId !== 'string') throw new Error('非法参数')
    return store.deleteModelEntry(providerId, modelId)
  })

  handle(IPC.TestRun, async (_e, params: unknown) => {
    const p = getValidated(testParamsSchema, params) as TestParams
    const provider = store.getProvider(p.providerId)
    if (!provider) throw new Error('服务商不存在')
    const adapter = adapterFor(provider.protocol)
    const apiKey = secrets.getSecret(p.providerId)
    const settings = store.getSettings()
    const record = await runner.run(
      adapter,
      p,
      provider,
      apiKey,
      { knownSecrets: secrets.allSecretValues() },
      { streamLogLimit: settings.streamLogLimit, streamIdleTimeoutMs: settings.streamIdleTimeoutMs }
    )
    if (settings.persistHistory) {
      store.appendHistory([record], settings.historyLimit, true)
    }
    return record
  })

  handle(IPC.TestCancel, (_e, runId: unknown) => {
    if (typeof runId !== 'string') throw new Error('非法参数')
    return runner.cancel(runId)
  })

  handle(IPC.HistoryList, () => store.listHistory())
  handle(IPC.HistoryDelete, (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('非法参数')
    return store.deleteHistory(id)
  })
  handle(IPC.HistoryClear, () => {
    store.clearHistory()
    return []
  })

  handle(IPC.SettingsGet, () => store.getSettings())
  handle(IPC.SettingsSet, (_e, s: unknown) => {
    // 设置项白名单校验
    if (!s || typeof s !== 'object') throw new Error('非法参数')
    const cur = store.getSettings()
    const next = s as Partial<AppSettings>
    const merged: AppSettings = {
      persistHistory: typeof next.persistHistory === 'boolean' ? next.persistHistory : cur.persistHistory,
      historyLimit: clampInt(next.historyLimit, 10, 5000, cur.historyLimit),
      streamLogLimit: clampInt(next.streamLogLimit, 10, 5000, cur.streamLogLimit),
      streamIdleTimeoutMs: clampInt(next.streamIdleTimeoutMs, 3000, 300000, cur.streamIdleTimeoutMs)
    }
    return store.saveSettings(merged)
  })

  handle(IPC.ExportReport, async (_e, opts: unknown): Promise<ExportResult> => {
    const o = getValidated(exportOptionsSchema, opts) as ExportOptions
    const all = store.listHistory()
    const records = o.recordIds.map((id) => all.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => Boolean(r))
    if (records.length === 0) return { ok: false, error: '没有可导出的记录' }
    if (o.includeBodies) {
      const { response } = await dialog.showMessageBox(win!, {
        type: 'question',
        buttons: ['继续导出', '取消'],
        defaultId: 1,
        cancelId: 1,
        message: '确认包含提示词与响应正文？',
        detail: '提示词和响应正文可能包含私人信息。导出文件将包含完整正文内容，请确认接收方与存放位置安全。'
      })
      if (response !== 0) return { ok: false, cancelled: true }
    }
    const ext = o.format === 'markdown' ? 'md' : 'json'
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: '导出诊断报告',
      defaultPath: path.join(app.getPath('documents'), `api-workbench-report-${Date.now()}.${ext}`),
      filters: [{ name: o.format === 'markdown' ? 'Markdown 报告' : 'JSON 报告', extensions: [ext] }]
    })
    if (canceled || !filePath) return { ok: false, cancelled: true }
    if (fs.existsSync(filePath)) {
      const { response } = await dialog.showMessageBox(win!, {
        type: 'question',
        buttons: ['覆盖', '取消'],
        defaultId: 1,
        cancelId: 1,
        message: '文件已存在，确认覆盖？',
        detail: filePath
      })
      if (response !== 0) return { ok: false, cancelled: true }
    }
    const content =
      o.format === 'markdown'
        ? buildMarkdownReport({ records, includeBodies: o.includeBodies, generatedAt: Date.now(), appVersion: app.getVersion() })
        : buildJsonReport({ records, includeBodies: o.includeBodies, generatedAt: Date.now(), appVersion: app.getVersion() })
    try {
      fs.writeFileSync(filePath, content, 'utf-8')
      return { ok: true, path: filePath }
    } catch (err) {
      return { ok: false, error: `写入失败：${String((err as Error).message)}` }
    }
  })

  handle(IPC.CurlSample, (_e, recordId: unknown) => {
    if (typeof recordId !== 'string') throw new Error('非法参数')
    const rec = store.listHistory().find((r) => r.id === recordId)
    if (!rec) throw new Error('记录不存在')
    return buildCurlSample(rec)
  })

  handle(IPC.OpenExternal, async (_e, url: unknown) => {
    const u = getValidated(urlSchema, url)
    // 只允许 http/https 外链（preload 只传文档链接）
    await shell.openExternal(u)
    return true
  })

  // ---------- 模拟服务管理 ----------

  handle(IPC.MockStatus, () => ({ running: mockChild != null && mockChild.exitCode == null }))

  handle(IPC.MockStart, async () => {
    if (mockChild && mockChild.exitCode == null) {
      return { running: true, port: mockPort, pid: mockChild.pid }
    }
    const scriptPath = app.isPackaged
      ? path.join(process.resourcesPath, 'mock-server', 'server.mjs')
      : path.join(app.getAppPath(), 'mock-server', 'server.mjs')
    if (!fs.existsSync(scriptPath)) return { running: false, error: '找不到模拟服务脚本' }
    mockPort = 0
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MOCK_PORT: '0', ELECTRON_NO_ATTACH_CONSOLE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    mockChild = child
    child.on('exit', () => {
      if (mockChild === child) mockChild = null
    })
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('模拟服务启动超时')), 8000)
      let buf = ''
      child.stdout!.on('data', (d: Buffer) => {
        buf += d.toString()
        const m = buf.match(/127\.0\.0\.1:(\d+)/)
        if (m) {
          clearTimeout(timer)
          resolve(Number(m[1]))
        }
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`模拟服务进程退出（code ${code}）`))
      })
    })
    mockPort = port
    return { running: true, port, pid: child.pid }
  })

  handle(IPC.MockStop, async () => {
    if (mockChild && mockChild.exitCode == null) {
      mockChild.kill()
      mockChild = null
      return { running: false }
    }
    return { running: false }
  })
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? Math.round(v) : NaN
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

// ---------- 窗口 ----------

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'API Workbench',
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false
    }
  })

  // CSP：渲染进程不发起任何网络请求（全部经 IPC），脚本/样式仅限自身
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'"
        ]
      }
    })
  })

  // 受控外链打开：拒绝在应用内加载远程网页
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  if (!app.isPackaged) {
    win.webContents.openDevTools({ mode: 'detach' })
  }

  void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

// ---------- 生命周期 ----------

app.whenReady().then(() => {  store = new ConfigStore(app.getPath('userData'))
  // safeStorage 在主进程始终可用；其加密能力由 SecretStore.getStatus() 检测
  const safeStorageLike: SafeStorageLike = {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (s) => safeStorage.encryptString(s),
    decryptString: (b) => safeStorage.decryptString(b)
  }
  secrets = new SecretStore(app.getPath('userData'), safeStorageLike)
  runner = new TestRunner({
    onEvent: (ev: RunEvent) => {
      if (win && !win.isDestroyed()) win.webContents.send(IPC.RunEvent, ev)
    }
  })
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // 两个平台都退出：本工具语义是"关窗即退出"，退出时统一清理
  app.quit()
})

app.on('before-quit', () => {
  // 清理：未完成请求、模拟服务子进程
  runner?.cancelAll()
  if (mockChild && mockChild.exitCode == null) {
    mockChild.kill()
    mockChild = null
  }
})
