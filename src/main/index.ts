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
import { AnthropicMessagesAdapter } from './protocols/anthropic-messages'
import { OpenAiResponsesAdapter } from './protocols/openai-responses'
import type { ProtocolAdapter } from './protocols/types'
import { TestRunner } from './runner/test-runner'
import { recordCapabilityVerification } from './capability'
import { classifyFetchError, timedFetch } from './net/http-client'
import { plainHttpWarning } from '@shared/url'
import { buildCurlSample, buildJsonReport, buildMarkdownReport } from './report/export'
import { applyImportPayload, buildExportPayload, type ImportResult } from './report/provider-io'

let win: BrowserWindow | null = null
let store: ConfigStore
let secrets: SecretStore
let runner: TestRunner
let mockChild: ChildProcess | null = null
let mockPort = 0

const CHAT_ADAPTERS: Record<string, ProtocolAdapter> = {
  'openai-chat': new OpenAiChatAdapter(),
  'anthropic-messages': new AnthropicMessagesAdapter(),
  'openai-responses': new OpenAiResponsesAdapter()
}
function adapterFor(protocol: string): ProtocolAdapter {
  const a = CHAT_ADAPTERS[protocol]
  if (!a) throw new Error(`暂不支持的协议：${protocol}`)
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

  handle(IPC.ProvidersExport, async (): Promise<ExportResult> => {
    const payload = buildExportPayload(store, secrets.allSecretValues())
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: '导出服务商配置(不含密钥)',
      defaultPath: path.join(app.getPath('documents'), `api-workbench-providers-${Date.now()}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (canceled || !filePath) return { ok: false, cancelled: true }
    try {
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8')
      return { ok: true, path: filePath }
    } catch (err) {
      return { ok: false, error: `写入失败:${String((err as Error).message)}` }
    }
  })

  handle(IPC.ProvidersImport, async (): Promise<ImportResult & ExportResult> => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      title: '导入服务商配置(JSON)',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (canceled || filePaths.length === 0) return { ok: false, cancelled: true, imported: 0, skipped: 0, invalid: [] }
    let text: string
    try {
      text = fs.readFileSync(filePaths[0], 'utf-8')
    } catch (err) {
      return { ok: false, error: `读取失败:${String((err as Error).message)}`, imported: 0, skipped: 0, invalid: [] }
    }
    try {
      const result = applyImportPayload(store, text)
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: String((err as Error).message), imported: 0, skipped: 0, invalid: [] }
    }
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
      { streamLogLimit: settings.streamLogLimit, streamIdleTimeoutMs: settings.streamIdleTimeoutMs },
      { runId: p.runId, compareId: p.compareId, perfId: p.perfId }
    )
    if (settings.persistHistory) {
      store.appendHistory([record], settings.historyLimit, true)
    }
    // 能力验证回写:成功的测试把 chat/tools 写入模型目录(幂等,失败/取消不写)
    recordCapabilityVerification(store, record)
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

  handle(IPC.MockStatus, () => ({
    running: mockChild != null && mockChild.exitCode == null,
    port: mockChild && mockChild.exitCode == null ? mockPort : undefined
  }))

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
    // 持续排空管道（防止子进程 console.log 因缓冲区满而阻塞），保留尾部用于诊断
    const childLogTail: string[] = []
    const drain = (stream: NodeJS.ReadableStream, label: string) => {
      stream.on('data', (d: Buffer) => {
        childLogTail.push(`[${label}] ${d.toString().trim()}`)
        if (childLogTail.length > 50) childLogTail.shift()
      })
    }
    drain(child.stdout!, 'mock.out')
    drain(child.stderr!, 'mock.err')
    child.on('exit', (code, signal) => {
      console.log(`[mock] 子进程退出 code=${code} signal=${signal}\n${childLogTail.slice(-10).join('\n')}`)
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
    show: !app.commandLine.hasSwitch('smoke'), // 冒烟模式不弹窗干扰(uitest 需要真实显示以截图)
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

  if (!app.isPackaged && !app.commandLine.hasSwitch('smoke')) {
    win.webContents.openDevTools({ mode: 'detach' })
  }

  void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

// ---------- 生命周期 ----------

app.on('before-quit', () => {
  // 清理：未完成请求、模拟服务子进程
  runner?.cancelAll()
  if (mockChild && mockChild.exitCode == null) {
    mockChild.kill()
    mockChild = null
  }
})

// ---------- 冒烟测试模式 ----------
// electron . --smoke：验证窗口加载、IPC、密钥存储可用性，并通过模拟服务跑一次完整请求闭环。
// 全部通过 → 退出码 0；任一失败 → 退出码 1。供 CI 与本机验收使用。

async function runSmokeTest(): Promise<void> {
  const steps: string[] = []
  const fail = (msg: string): never => {
    console.error(`[smoke] ❌ ${msg}`)
    console.error(`[smoke] 已通过步骤：${steps.join(' → ') || '（无）'}`)
    app.exit(1)
    throw new Error(msg)
  }
  const pass = (msg: string) => {
    steps.push(msg)
    console.log(`[smoke] ✅ ${msg}`)
  }

  try {
    // 1. 窗口加载
    await new Promise<void>((resolve, reject) => {
      if (win!.webContents.isLoading()) {
        win!.webContents.once('did-finish-load', () => resolve())
      } else resolve()
      setTimeout(() => reject(new Error('窗口加载超时')), 15000)
    })
    pass('窗口与渲染进程加载完成')

    // 2. 渲染进程挂载成功（检查 root 有内容且无致命错误）
    const rootHasContent = await win!.webContents.executeJavaScript(
      `document.getElementById('root')?.children.length > 0`
    )
    if (!rootHasContent) fail('React 未挂载（#root 为空）')
    pass('React 应用挂载成功')

    // 3. CSP 与安全基线
    const sec = await win!.webContents.executeJavaScript(
      `({ hasCSP: !!document.querySelector('meta[http-equiv="Content-Security-Policy"]') })`
    )
    if (!sec.hasCSP) fail('CSP meta 缺失')
    pass('CSP 已生效')

    // 4. 密钥存储状态（系统或会话内存均视为可用，但必须明确非 undefined）
    const info = await win!.webContents.executeJavaScript(`window.api.getAppInfo()`)
    if (!info?.secretStore?.mode) fail('密钥存储状态未获取')
    pass(`密钥存储模式：${info.secretStore.mode}`)

    // 5. 配置保存/读取闭环（用临时 ID，不污染用户配置）
    const smokeId = 'smoke-p'
    const prov = {
      id: smokeId,
      name: '冒烟测试',
      baseUrl: 'http://127.0.0.1:0', // 占位，稍后启动模拟服务后更新
      protocol: 'openai-chat',
      headers: [],
      timeoutMs: 10000,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    const saveResult = await win!.webContents.executeJavaScript(
      `window.api.saveProvider(${JSON.stringify(prov)})`
    )
    if (!saveResult?.providers?.some((p: { id: string }) => p.id === smokeId)) fail('服务商保存失败')
    pass('服务商配置保存/读取闭环')

    // 6. 模拟服务子进程启动
    const mockInfo = await win!.webContents.executeJavaScript(`window.api.mockStart()`)
    if (!mockInfo?.running || !mockInfo.port) fail(`模拟服务启动失败：${mockInfo?.error ?? '未知'}`)
    pass(`模拟服务子进程启动（端口 ${mockInfo.port}）`)

    // 7. 更新 baseUrl → 完整请求闭环（非流式）
    const baseUrl = `http://127.0.0.1:${mockInfo.port}`
    await win!.webContents.executeJavaScript(
      `window.api.saveProvider(${JSON.stringify({ ...prov, baseUrl })})`
    )
    await win!.webContents.executeJavaScript(
      `window.api.setSecret('${smokeId}', 'sk-mock-smoke-key')`
    )
    const record = await win!.webContents.executeJavaScript(
      `window.api.runTest({ providerId: '${smokeId}', model: 'mock-chat-mini', stream: false, prompt: '冒烟测试', maxTokens: 32 })`
    )
    if (!record?.ok || record.httpStatus !== 200) fail(`非流式请求失败：${JSON.stringify(record?.errorMessage)}`)
    if (record.request.headers['Authorization'] !== '***REDACTED***') fail('请求记录未脱敏！')
    pass(`非流式请求闭环（HTTP 200，耗时 ${record.timing.totalMs}ms，文本 ${record.text?.length ?? 0} 字符，已脱敏）`)

    // 8. 流式请求闭环
    const streamRecord = await win!.webContents.executeJavaScript(
      `window.api.runTest({ providerId: '${smokeId}', model: 'mock-chat-streamer', stream: true, prompt: '冒烟流式', maxTokens: 64 })`
    )
    if (!streamRecord?.ok) fail(`流式请求失败：${JSON.stringify(streamRecord?.errorMessage)}`)
    if (!streamRecord.streamEvents?.length) fail('流事件日志为空')
    if (!streamRecord.timing?.firstContentMs) fail('首个内容片段延迟未记录')
    pass(`流式请求闭环（事件 ${streamRecord.streamEvents.length} 条，首内容 ${streamRecord.timing.firstContentMs}ms）`)

    // 9. 模拟错误场景（401）与诊断
    await win!.webContents.executeJavaScript(`window.api.setSecret('${smokeId}', 'sk-wrong-key')`)
    const errRecord = await win!.webContents.executeJavaScript(
      `window.api.runTest({ providerId: '${smokeId}', model: 'mock-chat-mini', stream: false, prompt: 'x' })`
    )
    if (errRecord?.ok || errRecord?.httpStatus !== 401) fail('401 场景未按预期失败')
    if (!errRecord.diagnosis?.possibleCauses?.length) fail('诊断缺失')
    pass('错误场景与诊断生成（401）')

    // 清理冒烟数据
    await win!.webContents.executeJavaScript(`window.api.deleteProvider('${smokeId}')`)
    await win!.webContents.executeJavaScript(`window.api.mockStop()`)

    console.log(`[smoke] 🎉 全部 ${steps.length} 步通过`)
    app.exit(0)
  } catch (e) {
    fail(String((e as Error).message ?? e))
  }
}

app.whenReady().then(async () => {
  store = new ConfigStore(app.getPath('userData'))
  // safeStorage 在主进程始终可用;其加密能力由 SecretStore.probeAvailability() 异步探测一次
  const safeStorageLike: SafeStorageLike = {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    isAsyncEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    encryptString: (s) => safeStorage.encryptString(s),
    decryptString: (b) => safeStorage.decryptString(b)
  }
  secrets = new SecretStore(app.getPath('userData'), safeStorageLike)
  await secrets.probeAvailability() // 启动探测一次,避免后续触碰弃用的同步 API
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

  if (app.commandLine.hasSwitch('smoke')) {
    void runSmokeTest()
  }
  if (app.commandLine.hasSwitch('uitest')) {
    void import('./uitest').then((m) => m.runUiTest(win!))
  }
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
