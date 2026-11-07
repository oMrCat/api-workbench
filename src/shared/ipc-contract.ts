// IPC 契约：通道名单（自 ipc-channels 转发）+ 参数校验 Schema（zod）。
// 注意：本模块引入 zod，**不得被 preload 导入**（sandbox 限制）；preload 只用 ipc-channels。

import { z } from 'zod'

export { IPC } from './ipc-channels'

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
