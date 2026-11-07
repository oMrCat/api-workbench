import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ConfigStore } from '../../src/main/store/config-store'
import { SecretStore, type SafeStorageLike } from '../../src/main/store/secret-store'
import type { ProviderConfig } from '@shared/types'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apilens-store-'))
})

function sampleProvider(id: string): ProviderConfig {
  return {
    id,
    name: `服务商 ${id}`,
    baseUrl: 'https://api.example.com/v1',
    protocol: 'openai-chat',
    headers: [],
    timeoutMs: 60000,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

describe('配置存储（场景 17：配置保存与恢复）', () => {
  it('保存后重开实例能完整恢复', () => {
    const s1 = new ConfigStore(tmp)
    s1.saveProvider(sampleProvider('p1'))
    s1.saveProvider(sampleProvider('p2'))

    const s2 = new ConfigStore(tmp) // 模拟应用重启
    const list = s2.listProviders()
    expect(list).toHaveLength(2)
    expect(list.find((p) => p.id === 'p1')?.baseUrl).toBe('https://api.example.com/v1')
  })

  it('更新已有服务商（同 id 覆盖）', () => {
    const s = new ConfigStore(tmp)
    s.saveProvider(sampleProvider('p1'))
    s.saveProvider({ ...sampleProvider('p1'), name: '改名' })
    expect(s.listProviders()).toHaveLength(1)
    expect(s.listProviders()[0].name).toBe('改名')
  })

  it('删除服务商级联清理模型目录', () => {
    const s = new ConfigStore(tmp)
    s.saveProvider(sampleProvider('p1'))
    s.saveCatalog({ providerId: 'p1', entries: [{ id: 'm1', origin: 'catalog' }], status: 'ok' })
    s.deleteProvider('p1')
    expect(s.listProviders()).toHaveLength(0)
    expect(s.getCatalog('p1')).toBeUndefined()
  })

  it('手动模型 upsert 与删除', () => {
    const s = new ConfigStore(tmp)
    s.upsertManualModel('p1', { id: 'm1', origin: 'manual' })
    s.upsertManualModel('p1', { id: 'm1', origin: 'manual', userMarkedCapabilities: ['tools'] })
    const c = s.getCatalog('p1')!
    expect(c.entries).toHaveLength(1)
    expect(c.entries[0].userMarkedCapabilities).toEqual(['tools'])
    s.deleteModelEntry('p1', 'm1')
    expect(s.getCatalog('p1')!.entries).toHaveLength(0)
  })

  it('历史记录追加、上限裁剪、单删、清空', () => {
    const s = new ConfigStore(tmp)
    const mk = (i: number) => ({
      id: `r${i}`,
      startedAt: i,
      providerId: 'p1',
      providerName: 'x',
      model: 'm',
      protocol: 'openai-chat' as const,
      stream: false,
      request: { url: 'u', method: 'POST', headers: {} },
      ok: true,
      phase: 'success' as const,
      timing: {}
    })
    s.appendHistory([mk(1), mk(2)], 2, true)
    s.appendHistory([mk(3)], 2, true)
    expect(s.listHistory().map((r) => r.id)).toEqual(['r2', 'r3']) // 上限 2，最旧的被裁剪
    s.deleteHistory('r2')
    expect(s.listHistory()).toHaveLength(1)
    s.clearHistory()
    expect(s.listHistory()).toHaveLength(0)
  })

  it('persist=false 不写历史', () => {
    const s = new ConfigStore(tmp)
    const r = { id: 'x', startedAt: 1, providerId: 'p', providerName: 'x', model: 'm', protocol: 'openai-chat' as const, stream: false, request: { url: 'u', method: 'POST', headers: {} }, ok: true, phase: 'success' as const, timing: {} }
    const out = s.appendHistory([r], 10, false)
    expect(out).toHaveLength(1)
    expect(s.listHistory()).toHaveLength(0)
  })

  it('设置默认值合并与保存', () => {
    const s = new ConfigStore(tmp)
    expect(s.getSettings().historyLimit).toBe(200)
    s.saveSettings({ ...s.getSettings(), historyLimit: 50 })
    expect(new ConfigStore(tmp).getSettings().historyLimit).toBe(50)
  })

  it('损坏的 JSON 不崩溃，返回默认值', () => {
    fs.writeFileSync(path.join(tmp, 'providers.json'), 'not-json{{{', 'utf-8')
    const s = new ConfigStore(tmp)
    expect(s.listProviders()).toEqual([])
  })
})

// ---------- 密钥存储 ----------

function fakeSafeStorage(available: boolean, failEncrypt = false): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => {
      if (failEncrypt) throw new Error('encrypt failed (fake)')
      return Buffer.from(`enc:${s}`, 'utf-8')
    },
    decryptString: (b: Buffer) => {
      const t = b.toString('utf-8')
      if (!t.startsWith('enc:')) throw new Error('bad data')
      return t.slice(4)
    }
  }
}

describe('密钥安全存储（场景 18：安全存储不可用时的行为）', () => {
  it('系统安全存储可用 → 加密落盘，重启可解密', () => {
    const s1 = new SecretStore(tmp, fakeSafeStorage(true))
    expect(s1.getStatus().mode).toBe('system')
    s1.setSecret('p1', 'sk-test-123456')
    expect(s1.getSecret('p1')).toBe('sk-test-123456')
    // 文件中不出现明文
    const raw = fs.readFileSync(path.join(tmp, 'secrets.json'), 'utf-8')
    expect(raw).not.toContain('sk-test-123456')
    expect(raw).toContain('"enc":') // 密文条目存在（值为 base64）
    // 重启恢复
    const s2 = new SecretStore(tmp, fakeSafeStorage(true))
    expect(s2.getSecret('p1')).toBe('sk-test-123456')
    expect(s2.getSecretPreview('p1').preview).toBe('••••3456')
  })

  it('安全存储不可用 → 仅会话内存，不写盘，明确告知', () => {
    const s = new SecretStore(tmp, fakeSafeStorage(false))
    const status = s.getStatus()
    expect(status.mode).toBe('session-only')
    expect(status.reason).toContain('仅保存在当前会话内存')
    s.setSecret('p1', 'sk-session-only-key')
    expect(s.getSecret('p1')).toBe('sk-session-only-key')
    // 不应生成 secrets.json
    expect(fs.existsSync(path.join(tmp, 'secrets.json'))).toBe(false)
  })

  it('safeStorage 缺失（非 Electron 环境）→ 降级为会话内存', () => {
    const s = new SecretStore(tmp, undefined)
    expect(s.getStatus().mode).toBe('session-only')
    s.setSecret('p1', 'abc123456789')
    expect(s.getSecret('p1')).toBe('abc123456789')
  })

  it('加密失败 → 返回明确错误，不静默明文持久化', () => {
    const s = new SecretStore(tmp, fakeSafeStorage(true, true))
    const r = s.setSecret('p1', 'sk-fail-case')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('加密保存失败')
    expect(fs.existsSync(path.join(tmp, 'secrets.json'))).toBe(false)
  })

  it('删除密钥同时清理内存与文件', () => {
    const s = new SecretStore(tmp, fakeSafeStorage(true))
    s.setSecret('p1', 'sk-del-me')
    s.deleteSecret('p1')
    expect(s.getSecret('p1')).toBeUndefined()
    expect(Object.keys(s['readFile']().entries)).toHaveLength(0)
  })

  it('allSecretValues 覆盖内存与系统两条路径（脱敏输入）', () => {
    const s1 = new SecretStore(tmp, fakeSafeStorage(true))
    s1.setSecret('p1', 'sk-system-key-1')
    const s2 = new SecretStore(tmp, undefined)
    s2.setSecret('p2', 'sk-memory-key-2')
    expect(s2.allSecretValues()).toContain('sk-memory-key-2')
    expect(s1.allSecretValues()).toContain('sk-system-key-1')
  })
})
