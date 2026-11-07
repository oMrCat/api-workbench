// 配置存储：服务商配置、模型目录、历史记录、设置。
// 普通数据存于系统用户数据目录（app.getPath('userData')），路径由外部注入。
// 只使用 node:fs，不依赖 electron，可用临时目录测试。

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ModelCatalog, ModelEntry, ProviderConfig, TestRunRecord, AppSettings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'

interface StoreFile<T> {
  version: 1
  data: T
}

function readJson<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as StoreFile<T>
    if (parsed && parsed.version === 1) return parsed.data
    return fallback
  } catch {
    return fallback
  }
}

function writeJson<T>(file: string, data: T): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, data } satisfies StoreFile<T>), 'utf-8')
  fs.renameSync(tmp, file) // 原子替换，避免写入中断导致配置损坏
}

export class ConfigStore {
  private providersFile: string
  private modelsFile: string
  private historyFile: string
  private settingsFile: string

  constructor(dir: string) {
    this.providersFile = path.join(dir, 'providers.json')
    this.modelsFile = path.join(dir, 'models.json')
    this.historyFile = path.join(dir, 'history.json')
    this.settingsFile = path.join(dir, 'settings.json')
  }

  // ---------- 服务商 ----------

  listProviders(): ProviderConfig[] {
    return readJson<ProviderConfig[]>(this.providersFile, [])
  }

  saveProvider(p: ProviderConfig): ProviderConfig[] {
    const list = this.listProviders()
    const idx = list.findIndex((x) => x.id === p.id)
    if (idx >= 0) list[idx] = p
    else list.push(p)
    writeJson(this.providersFile, list)
    return list
  }

  deleteProvider(id: string): ProviderConfig[] {
    const list = this.listProviders().filter((p) => p.id !== id)
    writeJson(this.providersFile, list)
    // 级联清理该服务商的目录与密钥相关元数据（密钥值由 SecretStore 自行删除）
    this.deleteCatalog(id)
    return list
  }

  getProvider(id: string): ProviderConfig | undefined {
    return this.listProviders().find((p) => p.id === id)
  }

  // ---------- 模型目录 ----------

  private catalogs(): Record<string, ModelCatalog> {
    return readJson<Record<string, ModelCatalog>>(this.modelsFile, {})
  }

  getCatalog(providerId: string): ModelCatalog | undefined {
    return this.catalogs()[providerId]
  }

  saveCatalog(catalog: ModelCatalog): void {
    const all = this.catalogs()
    all[catalog.providerId] = catalog
    writeJson(this.modelsFile, all)
  }

  upsertManualModel(providerId: string, entry: ModelEntry): ModelCatalog {
    const all = this.catalogs()
    const catalog: ModelCatalog =
      all[providerId] ?? { providerId, entries: [], status: 'idle' }
    const idx = catalog.entries.findIndex((m) => m.id === entry.id)
    if (idx >= 0) catalog.entries[idx] = { ...catalog.entries[idx], ...entry }
    else catalog.entries.push(entry)
    all[providerId] = catalog
    writeJson(this.modelsFile, all)
    return catalog
  }

  deleteModelEntry(providerId: string, modelId: string): ModelCatalog | undefined {
    const all = this.catalogs()
    const catalog = all[providerId]
    if (!catalog) return undefined
    catalog.entries = catalog.entries.filter((m) => m.id !== modelId)
    all[providerId] = catalog
    writeJson(this.modelsFile, all)
    return catalog
  }

  deleteCatalog(providerId: string): void {
    const all = this.catalogs()
    if (providerId in all) {
      delete all[providerId]
      writeJson(this.modelsFile, all)
    }
  }

  // ---------- 历史记录 ----------

  listHistory(): TestRunRecord[] {
    return readJson<TestRunRecord[]>(this.historyFile, [])
  }

  appendHistory(records: TestRunRecord[], limit: number, persist: boolean): TestRunRecord[] {
    if (!persist) return records
    const all = [...this.listHistory(), ...records]
    const trimmed = all.slice(-limit) // 只保留最近 N 条
    writeJson(this.historyFile, trimmed)
    return trimmed
  }

  deleteHistory(id: string): TestRunRecord[] {
    const all = this.listHistory().filter((r) => r.id !== id)
    writeJson(this.historyFile, all)
    return all
  }

  clearHistory(): void {
    writeJson(this.historyFile, [])
  }

  // ---------- 设置 ----------

  getSettings(): AppSettings {
    return { ...DEFAULT_SETTINGS, ...readJson<Partial<AppSettings>>(this.settingsFile, {}) }
  }

  saveSettings(s: AppSettings): AppSettings {
    writeJson(this.settingsFile, s)
    return s
  }
}
