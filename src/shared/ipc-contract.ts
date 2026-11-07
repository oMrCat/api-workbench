// IPC 契约：通道名单 + 参数校验 Schema（zod）。
// 渲染进程只能通过 preload 暴露的白名单方法触达这里定义的通道。

import { z } from 'zod'

export const IPC = {
  AppInfo: 'app:get-info',
  ProvidersList: 'providers:list',
  ProvidersSave: 'providers:save',
  ProvidersDelete: 'providers:delete',
  SecretsStatus: 'secrets:status',
  SecretSet: 'secrets:set',
  SecretGetPreview: 'secrets:get-preview',
  SecretDelete: 'secrets:delete',
  ModelsSync: 'models:sync',
  ModelsGet: 'models:get',
  ModelsSaveEntry: 'models:save-entry',
  ModelsDeleteEntry: 'models:delete-entry',
  TestRun: 'test:run',
  TestCancel: 'test:cancel',
  RunEvent: 'test:event', // main -> renderer 推送
  HistoryList: 'history:list',
  HistoryDelete: 'history:delete',
  HistoryClear: 'history:clear',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  ExportReport: 'export:report',
  CurlSample: 'report:curl',
  OpenExternal: 'window:open-external',
  MockStart: 'mock:start',
  MockStop: 'mock:stop',
  MockStatus: 'mock:status'
} as const

// ---------- 校验 Schema ----------

const headerSchema = z.object({
  name: z.string().min(1).max(200),
  value: z.string().max(8192),
  sensitive: z.boolean().default(false)
})

export const providerConfigSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1).max(100),
  baseUrl: z
    .string()
    .min(1)
    .max(2048)
    .refine((v) => {
      try {
        const u = new URL(v)
        return u.protocol === 'http:' || u.protocol === 'https:'
      } catch {
        return false
      }
    }, '仅支持 http/https 地址'),
  protocol: z.enum(['openai-chat', 'openai-responses', 'anthropic-messages']),
  headers: z.array(headerSchema).max(32),
  timeoutMs: z.number().int().min(1000).max(600000),
  modelsPath: z.string().max(500).optional(),
  chatPath: z.string().max(500).optional(),
  createdAt: z.number(),
  updatedAt: z.number()
})

export const testParamsSchema = z.object({
  providerId: z.string().min(1).max(64),
  model: z.string().min(1).max(300),
  stream: z.boolean(),
  prompt: z.string().min(1).max(32000),
  maxTokens: z.number().int().min(1).max(100000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  streamIncludeUsage: z.boolean().optional()
})

export const exportOptionsSchema = z.object({
  recordIds: z.array(z.string().min(1).max(64)).min(1).max(500),
  format: z.enum(['markdown', 'json']),
  includeBodies: z.boolean()
})

export const urlSchema = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v)
      return u.protocol === 'http:' || u.protocol === 'https:'
    } catch {
      return false
    }
  }, '仅支持 http/https 链接')
