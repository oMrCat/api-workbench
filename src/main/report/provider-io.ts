// 服务商配置导出/导入(P1):纯逻辑,系统对话框由 IPC 层包装。
// 安全边界:
// - API Key 本就不在配置里(独立加密存储),导出天然不含
// - 自定义请求头的值若形似密钥/命中已知密钥/被标敏感 → 导出时替换为 ***REDACTED***
// - 导入逐条 zod 校验,ID 冲突跳过,坏文件整体报错

import { providerConfigSchema } from '@shared/ipc-contract'
import type { ProviderConfig } from '@shared/types'
import type { ConfigStore } from '../store/config-store'
import { isSensitiveHeaderName, looksLikeSecret } from '../redact'

export interface ExportPayload {
  version: 1
  exportedAt: string
  keyNotice: string
  providers: ProviderConfig[]
}

/** 导出前的防御性脱敏:自定义头值按敏感规则处理 */
function sanitizeForExport(p: ProviderConfig, knownSecrets: string[]): ProviderConfig {
  const secrets = new Set(knownSecrets)
  return {
    ...p,
    headers: p.headers.map((h) => ({
      ...h,
      value: isSensitiveHeaderName(h.name) || looksLikeSecret(h.value) || secrets.has(h.value) ? '***REDACTED***' : h.value
    }))
  }
}

export function buildExportPayload(store: ConfigStore, knownSecrets: string[]): ExportPayload {
  const providers = store.listProviders().map((p) => sanitizeForExport(p, knownSecrets))
  // 防御性检查:配置对象不应出现密钥形态的属性名(发现即中止,不带病导出)
  for (const p of providers) {
    if (/"(api[_-]?key|secret|authorization|password)"\s*:/i.test(JSON.stringify(p))) {
      throw new Error('配置中发现疑似密钥字段,已中止导出')
    }
  }
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    keyNotice:
      '本文件不包含 API Key(密钥保存在系统安全存储,从不导出)。形似密钥的自定义请求头值已替换为 ***REDACTED***;导入后请重新录入密钥并检查自定义请求头。',
    providers
  }
}

export interface ImportResult {
  imported: number
  skipped: number
  invalid: { index: number; reason: string }[]
}

/** 导入:逐条 zod 校验;ID 已存在跳过;坏 JSON 整体报错 */
export function applyImportPayload(store: ConfigStore, text: string): ImportResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`文件不是有效 JSON:${String((e as Error).message)}`)
  }
  const obj = parsed as { providers?: unknown }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.providers)) {
    throw new Error('文件结构不符合导出格式(缺少 providers 数组)')
  }
  const existingIds = new Set(store.listProviders().map((p) => p.id))
  const result: ImportResult = { imported: 0, skipped: 0, invalid: [] }
  obj.providers.forEach((raw, index) => {
    const checked = providerConfigSchema.safeParse(raw)
    if (!checked.success) {
      const reason = checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      result.invalid.push({ index, reason })
      return
    }
    if (existingIds.has(checked.data.id)) {
      result.skipped++
      return
    }
    existingIds.add(checked.data.id)
    store.saveProvider(checked.data as ProviderConfig)
    result.imported++
  })
  return result
}
