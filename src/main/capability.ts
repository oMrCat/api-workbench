// 能力验证回写(P1):测试成功后把实测通过的能力写回模型目录,
// 让"对话已验证 / 工具已验证"徽章来自真实测试记录而非文档声明。
// 幂等:重复验证不产生重复条目。

import type { TestRunRecord } from '@shared/types'
import type { ConfigStore } from './store/config-store'

/** 从一条成功的测试记录提取已验证能力 */
export function verifiedFromRecord(record: TestRunRecord): string[] {
  const verified = new Set<string>()
  if (record.ok) verified.add('chat')
  if (record.ok && record.toolSteps && record.toolSteps.length > 0 && record.toolSteps.every((s) => s.status === 'ok')) {
    verified.add('tools')
  }
  return [...verified]
}

/**
 * 把 record 的验证结果回写到 provider 的模型目录。
 * - 目录中已有该模型:merge(保留 origin 与既有标注)
 * - 目录中没有(手输模型):以 manual 落盘,便于用户看到它已被验证
 * - 失败/取消的记录不回写
 */
export function recordCapabilityVerification(store: ConfigStore, record: TestRunRecord): void {
  if (!record.ok) return
  const verified = verifiedFromRecord(record)
  if (verified.length === 0) return
  const catalog = store.getCatalog(record.providerId)
  const existing = catalog?.entries.find((m) => m.id === record.model)
  const merged = new Set([...(existing?.verifiedCapabilities ?? []), ...verified])
  store.upsertManualModel(record.providerId, {
    id: record.model,
    origin: existing?.origin ?? 'manual',
    verifiedCapabilities: [...merged]
  })
}
