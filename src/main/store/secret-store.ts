// 密钥安全存储：优先使用 Electron safeStorage（macOS Keychain / Windows DPAPI）。
// 不可用时：仅会话内存，不静默明文持久化，并明确告知用户。
// safeStorage 接口由外部注入（主进程传真实实现，测试传模拟实现）。

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { SecretStoreStatus } from '@shared/types'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

interface StoredEntry {
  /** 加密后的密文（base64）；仅内存模式下不存在此字段 */
  enc?: string
  updated: number
}

interface SecretFile {
  version: 1
  /** key = providerId */
  entries: Record<string, StoredEntry>
}

export class SecretStore {
  private memoryKeys = new Map<string, string>()
  private file: string
  private statusCache: SecretStoreStatus | undefined

  constructor(
    private dir: string,
    private safeStorage: SafeStorageLike | undefined
  ) {
    this.file = path.join(dir, 'secrets.json')
  }

  /** 每次启动时检测一次；结果缓存供 UI 展示 */
  getStatus(): SecretStoreStatus {
    if (this.statusCache) return this.statusCache
    if (!this.safeStorage) {
      this.statusCache = {
        mode: 'session-only',
        reason: '安全存储模块不可用（未在 Electron 主进程中运行）。API Key 仅保存在当前会话内存中，退出后丢失，不会明文写入磁盘。'
      }
      return this.statusCache
    }
    let available = false
    try {
      available = this.safeStorage.isEncryptionAvailable()
    } catch (e) {
      this.statusCache = {
        mode: 'session-only',
        reason: `安全存储可用性检测失败：${String((e as Error)?.message ?? e)}。API Key 仅保存在当前会话内存中。`
      }
      return this.statusCache
    }
    this.statusCache = available
      ? { mode: 'system' }
      : {
          mode: 'session-only',
          reason: '操作系统安全存储（macOS Keychain / Windows DPAPI）不可用。API Key 仅保存在当前会话内存中，退出应用后丢失。'
        }
    return this.statusCache
  }

  setSecret(providerId: string, value: string): { ok: boolean; error?: string } {
    if (!value) return this.deleteSecret(providerId)
    const status = this.getStatus()
    if (status.mode === 'system' && this.safeStorage) {
      try {
        const enc = this.safeStorage.encryptString(value)
        const f = this.readFile()
        f.entries[providerId] = { enc: enc.toString('base64'), updated: Date.now() }
        this.writeFile(f)
        this.memoryKeys.delete(providerId)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: `加密保存失败：${String((e as Error)?.message ?? e)}` }
      }
    }
    // 降级：仅内存
    this.memoryKeys.set(providerId, value)
    return { ok: true }
  }

  getSecret(providerId: string): string | undefined {
    if (this.memoryKeys.has(providerId)) return this.memoryKeys.get(providerId)
    const status = this.getStatus()
    if (status.mode !== 'system' || !this.safeStorage) return undefined
    const f = this.readFile()
    const entry = f.entries[providerId]
    if (!entry?.enc) return undefined
    try {
      return this.safeStorage.decryptString(Buffer.from(entry.enc, 'base64'))
    } catch {
      return undefined // 解密失败视为无密钥（如系统用户变更）
    }
  }

  deleteSecret(providerId: string): { ok: boolean } {
    this.memoryKeys.delete(providerId)
    const f = this.readFile()
    if (providerId in f.entries) {
      delete f.entries[providerId]
      this.writeFile(f)
    }
    return { ok: true }
  }

  /** 展示用预览：只返回末 4 位，供 UI 确认"已保存" */
  getSecretPreview(providerId: string): { exists: boolean; preview?: string; source: 'memory' | 'system' | 'none' } {
    const inMemory = this.memoryKeys.has(providerId)
    const value = this.getSecret(providerId)
    if (!value) return { exists: false, source: 'none' }
    return {
      exists: true,
      preview: `••••${value.slice(-4)}`,
      source: inMemory ? 'memory' : 'system'
    }
  }

  /** 收集所有已知密钥值（脱敏用）。仅会话内使用，不落日志。 */
  allSecretValues(): string[] {
    const values = [...this.memoryKeys.values()]
    const f = this.readFile()
    if (this.getStatus().mode === 'system' && this.safeStorage) {
      for (const id of Object.keys(f.entries)) {
        const v = this.getSecret(id)
        if (v) values.push(v)
      }
    }
    return values
  }

  private readFile(): SecretFile {
    try {
      const raw = fs.readFileSync(this.file, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
        return parsed as SecretFile
      }
    } catch {
      /* 首次读取 */
    }
    return { version: 1, entries: {} }
  }

  private writeFile(f: SecretFile): void {
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(f), 'utf-8')
    fs.renameSync(tmp, this.file)
  }
}
