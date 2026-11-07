import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ConfigStore } from '../../src/main/store/config-store'
import { recordCapabilityVerification, verifiedFromRecord } from '../../src/main/capability'
import type { TestRunRecord } from '@shared/types'

let tmp: string
let store: ConfigStore

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apilens-cap-'))
  store = new ConfigStore(tmp)
})

function record(patch: Partial<TestRunRecord> = {}): TestRunRecord {
  return {
    id: 'r1',
    startedAt: Date.now(),
    providerId: 'p1',
    providerName: 'x',
    model: 'mock-chat-mini',
    protocol: 'openai-chat',
    stream: false,
    request: { url: 'u', method: 'POST', headers: {} },
    ok: true,
    phase: 'success',
    timing: {},
    ...patch
  }
}

describe('能力验证回写(P1)', () => {
  it('成功记录 → chat 写入 verifiedCapabilities', () => {
    store.saveCatalog({ providerId: 'p1', entries: [{ id: 'mock-chat-mini', origin: 'catalog' }], status: 'ok' })
    recordCapabilityVerification(store, record())
    const entry = store.getCatalog('p1')!.entries.find((m) => m.id === 'mock-chat-mini')!
    expect(entry.verifiedCapabilities).toEqual(['chat'])
    expect(entry.origin).toBe('catalog') // 既有条目保留来源
  })

  it('工具步骤全部成功 → 追加 tools(去重幂等)', () => {
    store.saveCatalog({ providerId: 'p1', entries: [{ id: 'm1', origin: 'catalog' }], status: 'ok' })
    const rec = record({
      model: 'm1',
      toolSteps: [
        { seq: 0, toolName: 'calculate_sum', argumentsJson: '{}', status: 'ok', resultJson: '{}' },
        { seq: 1, toolName: 'get_fixed_greeting', argumentsJson: '', status: 'ok', resultJson: '{}' }
      ]
    })
    recordCapabilityVerification(store, rec)
    recordCapabilityVerification(store, rec) // 幂等
    const entry = store.getCatalog('p1')!.entries[0]
    expect(entry.verifiedCapabilities).toEqual(['chat', 'tools'])
  })

  it('有被拒绝的工具步骤 → 不写 tools(只写 chat)', () => {
    store.saveCatalog({ providerId: 'p1', entries: [{ id: 'm1', origin: 'catalog' }], status: 'ok' })
    const rec = record({
      model: 'm1',
      toolSteps: [
        { seq: 0, toolName: 'unknown', argumentsJson: '{}', status: 'rejected', error: 'x' }
      ]
    })
    recordCapabilityVerification(store, rec)
    expect(store.getCatalog('p1')!.entries[0].verifiedCapabilities).toEqual(['chat'])
  })

  it('目录中没有的模型 → 以 manual 落盘并标注已验证', () => {
    recordCapabilityVerification(store, record({ model: 'hand-typed-model' }))
    const entry = store.getCatalog('p1')!.entries.find((m) => m.id === 'hand-typed-model')!
    expect(entry.origin).toBe('manual')
    expect(entry.verifiedCapabilities).toEqual(['chat'])
  })

  it('失败/取消记录不回写', () => {
    recordCapabilityVerification(store, record({ ok: false, phase: 'response', httpStatus: 500 }))
    recordCapabilityVerification(store, record({ ok: false, cancelled: true, phase: 'cancelled' }))
    expect(store.getCatalog('p1')).toBeUndefined()
  })

  it('verifiedFromRecord 纯函数:空工具步骤只给 chat', () => {
    expect(verifiedFromRecord(record({ toolSteps: [] }))).toEqual(['chat'])
  })
})
