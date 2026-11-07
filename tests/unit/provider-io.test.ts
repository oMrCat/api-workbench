import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ConfigStore } from '../../src/main/store/config-store'
import { applyImportPayload, buildExportPayload } from '../../src/main/report/provider-io'
import type { ProviderConfig } from '@shared/types'

let tmp: string
let store: ConfigStore

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apilens-pio-'))
  store = new ConfigStore(tmp)
})

function provider(id: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id,
    name: `服务商 ${id}`,
    baseUrl: 'https://api.example.com',
    protocol: 'openai-chat',
    headers: [],
    timeoutMs: 60000,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('配置导出/导入(P1,无密钥)', () => {
  it('导出负载含版本/时间/提示,providers 完整', () => {
    store.saveProvider(provider('p1'))
    const payload = buildExportPayload(store, [])
    expect(payload.version).toBe(1)
    expect(payload.keyNotice).toContain('不包含 API Key')
    expect(payload.providers).toHaveLength(1)
    expect(payload.providers[0].id).toBe('p1')
  })

  it('导出内容不含 API Key 字段(防御性属性名检查)', () => {
    store.saveProvider(provider('p1'))
    const json = JSON.stringify(buildExportPayload(store, []))
    expect(json).not.toMatch(/"(api[_-]?key|secret|authorization|password)"\s*:/i)
  })

  it('自定义头值形似密钥 → 导出时替换为 ***REDACTED***', () => {
    store.saveProvider(
      provider('p1', {
        headers: [
          { name: 'X-Gateway-Auth', value: 'sk-proj-abcdef12345678901234', sensitive: false },
          { name: 'X-Trace', value: 'normal-value', sensitive: false }
        ]
      })
    )
    const payload = buildExportPayload(store, [])
    const h = payload.providers[0].headers
    expect(h[0].value).toBe('***REDACTED***')
    expect(h[1].value).toBe('normal-value')
  })

  it('自定义头值命中已知密钥(与 API Key 相同)→ 脱敏', () => {
    store.saveProvider(provider('p1', { headers: [{ name: 'X-Auth', value: 'sk-the-real-api-key', sensitive: false }] }))
    const payload = buildExportPayload(store, ['sk-the-real-api-key'])
    expect(payload.providers[0].headers[0].value).toBe('***REDACTED***')
  })

  it('导入:合法条目入库', () => {
    const payload = { version: 1, providers: [provider('imp1')] }
    const r = applyImportPayload(store, JSON.stringify(payload))
    expect(r.imported).toBe(1)
    expect(r.skipped).toBe(0)
    expect(store.listProviders()[0].id).toBe('imp1')
  })

  it('导入:ID 已存在跳过', () => {
    store.saveProvider(provider('p1'))
    const payload = { version: 1, providers: [provider('p1', { name: '重复' })] }
    const r = applyImportPayload(store, JSON.stringify(payload))
    expect(r.skipped).toBe(1)
    expect(r.imported).toBe(0)
    expect(store.listProviders()[0].name).toBe('服务商 p1') // 未被覆盖
  })

  it('导入:非法条目计数并给原因,合法条目照常入库', () => {
    const payload = {
      version: 1,
      providers: [provider('good'), { id: 'bad', baseUrl: 'ftp://x', protocol: 'openai-chat' }]
    }
    const r = applyImportPayload(store, JSON.stringify(payload))
    expect(r.imported).toBe(1)
    expect(r.invalid).toHaveLength(1)
    expect(r.invalid[0].reason).toContain('仅支持 http/https')
  })

  it('导入:坏 JSON / 缺 providers 数组 → 明确报错', () => {
    expect(() => applyImportPayload(store, 'not json')).toThrow(/JSON/)
    expect(() => applyImportPayload(store, '{"foo":1}')).toThrow(/providers/)
  })
})
