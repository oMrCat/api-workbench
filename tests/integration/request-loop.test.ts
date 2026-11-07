// 集成测试：完整请求闭环 × 模拟服务（场景 1-14,15）
// 直接驱动 TestRunner（主进程编排层），HTTP 走真实 localhost 网络栈。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as http from 'node:http'
import { startMockServer, type MockHandle } from '../../mock-server/server.mjs'
import { TestRunner } from '../../src/main/runner/test-runner'
import { OpenAiChatAdapter } from '../../src/main/protocols/openai-chat'
import type { ProviderConfig } from '@shared/types'

let mock: MockHandle
let base: string
const adapter = new OpenAiChatAdapter()
const runner = new TestRunner({})

const KEY = 'sk-mock-integration-test-key'
const SECRETS = { knownSecrets: [KEY] }
const SETTINGS = { streamLogLimit: 200, streamIdleTimeoutMs: 10000 }

function provider(patch: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'mock-p',
    name: '模拟服务商',
    baseUrl: base,
    protocol: 'openai-chat',
    headers: [],
    timeoutMs: 5000,
    createdAt: 0,
    updatedAt: 0,
    ...patch
  }
}

async function run(model: string, stream: boolean, patch: Partial<ProviderConfig> = {}, prompt = '你好') {
  return runner.run(
    adapter,
    { providerId: 'mock-p', model, stream, prompt, maxTokens: 64 },
    provider(patch),
    KEY,
    SECRETS,
    SETTINGS
  )
}

beforeAll(async () => {
  mock = await startMockServer(0, () => {})
  base = `http://127.0.0.1:${mock.port}`
}, 20000)

afterAll(async () => {
  await mock.close()
})

describe('非流式（场景 1,4-8,11）', () => {
  it('正常非流式响应：文本/usage/耗时齐全，密钥脱敏', async () => {
    const r = await run('mock-chat-mini', false)
    expect(r.ok).toBe(true)
    expect(r.phase).toBe('success')
    expect(r.httpStatus).toBe(200)
    expect(r.text).toContain('【模拟回复】')
    expect(r.usage).toBeDefined()
    expect((r.usage as any).total_tokens).toBeGreaterThan(0)
    expect(r.timing.totalMs).toBeGreaterThan(0)
    // 脱敏：请求头中 Authorization 不含真实密钥
    expect(r.request.headers['Authorization']).toBe('***REDACTED***')
    expect(JSON.stringify(r.request)).not.toContain(KEY)
  })

  it('401 → 失败 + 响应体证据 + 认证诊断', async () => {
    // 用错误密钥触发 401
    const r401 = await runner.run(
      adapter,
      { providerId: 'mock-p', model: 'mock-chat-mini', stream: false, prompt: 'x' },
      provider(),
      'sk-wrong-key-999',
      { knownSecrets: ['sk-wrong-key-999'] },
      SETTINGS
    )
    expect(r401.ok).toBe(false)
    expect(r401.httpStatus).toBe(401)
    expect(r401.errorBodyPreview).toContain('invalid_api_key')
    expect(r401.diagnosis?.possibleCauses.some((c) => c.cause.includes('API Key 无效'))).toBe(true)
  })

  it('403 → 权限类诊断', async () => {
    const r = await run('mock-403', false)
    expect(r.httpStatus).toBe(403)
    expect(r.diagnosis?.possibleCauses.some((c) => c.cause.includes('授权'))).toBe(true)
  })

  it('404 → 模型不存在路径', async () => {
    const r = await run('mock-404', false)
    expect(r.httpStatus).toBe(404)
    expect(r.diagnosis?.suggestions.join()).toContain('/v1/v1')
  })

  it('429 → 限流诊断，错误体保留', async () => {
    const r = await run('mock-429', false)
    expect(r.httpStatus).toBe(429)
    expect(r.errorBodyPreview).toContain('rate_limit_exceeded')
    expect(r.diagnosis?.possibleCauses.some((c) => c.cause.includes('限流'))).toBe(true)
  })

  it('500 → 服务端错误归因', async () => {
    const r = await run('mock-500', false)
    expect(r.httpStatus).toBe(500)
    expect(r.diagnosis?.possibleCauses.some((c) => c.cause.includes('上游服务端错误'))).toBe(true)
  })

  it('502 → 不归因客户端', async () => {
    const r = await run('mock-502', false)
    expect(r.httpStatus).toBe(502)
    const c = r.diagnosis?.possibleCauses.find((x) => x.cause.includes('502'))
    expect(c?.note).toContain('服务端侧错误')
  })

  it('非 JSON 响应（HTML）→ parse 阶段失败 + 明确错误', async () => {
    const r = await run('mock-nonjson', false)
    expect(r.ok).toBe(false)
    expect(r.phase).toBe('parse')
    expect(r.errorMessage).toContain('JSON')
    expect(r.rawResponsePreview).toContain('<html>')
  })
})

describe('流式（场景 2,3,10,14）', () => {
  it('正常流式：增量文本/首个内容延迟/事件日志/usage', async () => {
    const deltas: string[] = []
    const statuses: string[] = []
    const liveRunner = new TestRunner({
      onEvent: (ev) => {
        if (ev.type === 'text-delta') deltas.push(ev.delta)
        if (ev.type === 'status') statuses.push(ev.status)
      }
    })
    const r = await liveRunner.run(
      adapter,
      { providerId: 'mock-p', model: 'mock-chat-streamer', stream: true, prompt: '测试', streamIncludeUsage: true },
      provider(),
      KEY,
      SECRETS,
      SETTINGS
    )
    expect(r.ok).toBe(true)
    expect(r.phase).toBe('success')
    expect(statuses).toContain('streaming')
    expect(statuses[statuses.length - 1]).toBe('done')
    // 增量事件确实逐块到达（>1 个 delta）
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.join('')).toBe(r.text)
    // 首个内容片段延迟 < TTFB+内容到达时间，且为有效非空内容时间（不是响应头时间）
    expect(r.timing.firstContentMs).toBeGreaterThan(0)
    expect(r.streamEvents?.length).toBeGreaterThan(5)
    // UTF-8 完整性：文本包含完整 emoji（跨分块解码正确）
    expect(r.text).toContain('🎉')
    expect(r.text).toContain('☀️')
    // usage（include_usage）
    expect(r.usage).toBeDefined()
    // [DONE] 已记录在事件日志
    expect(r.streamEvents?.some((e) => e.data === '[DONE]')).toBe(true)
  }, 20000)

  it('流式中断（上游断开）→ stream 阶段失败', async () => {
    const r = await run('mock-break', true)
    expect(r.ok).toBe(false)
    expect(r.phase).toBe('stream')
    expect(r.errorMessage).toContain('中途断开')
    // 已收到的部分内容保留为证据
    expect(r.text).toContain('前半段内容')
    expect(r.diagnosis?.possibleCauses.some((c) => c.cause.includes('流中途断开'))).toBe(true)
  }, 20000)

  it('用户取消（通过事件捕获 runId 后精确取消）→ 保留已接收内容', async () => {
    const liveRunner = new TestRunner({})
    let capturedRunId: string | undefined
    const params = { providerId: 'mock-p', model: 'mock-slow', stream: true, prompt: '慢慢说' }
    const p = liveRunner.run(
      adapter,
      params,
      provider(),
      KEY,
      SECRETS,
      SETTINGS
    )
    // 首个 status 事件携带 runId；等 300ms（首批内容已到达）再取消
    await new Promise((res) => setTimeout(res, 300))
    liveRunner['active'].forEach((_, id) => (capturedRunId = id))
    expect(capturedRunId).toBeDefined()
    expect(liveRunner.cancel(capturedRunId!)).toBe(true)
    const r = await p
    expect(r.cancelled).toBe(true)
    expect(r.phase).toBe('cancelled')
    expect(r.text).toContain('第一块') // 已接收内容保留
    expect(r.ok).toBe(false)
    expect(r.request.headers['Authorization']).toBe('***REDACTED***')
  }, 20000)

  it('cancel 未知 runId 返回 false；cancelAll 幂等', async () => {
    const liveRunner = new TestRunner({})
    expect(liveRunner.cancel('nonexistent')).toBe(false)
    liveRunner.cancelAll() // 无运行中请求，不应抛错
  })
})

describe('超时与网络错误（场景 9,14）', () => {
  it('总超时（mock-hang 挂起）→ timeout 阶段', async () => {
    const r = await run('mock-hang', false, { timeoutMs: 1500 })
    expect(r.ok).toBe(false)
    expect(r.timedOut).toBe(true)
    expect(r.phase).toBe('timeout')
    expect(r.errorCode).toBe('TIMEOUT')
    expect(r.diagnosis?.possibleCauses.some((c) => c.cause.includes('超时上限'))).toBe(true)
  }, 20000)

  it('连接拒绝（无服务端口）→ connect 阶段', async () => {
    // 先监听再关闭，获得一个必然被拒绝的端口（port 1 等属于 undici 受限端口，会报 bad port 而非 ECONNREFUSED）
    const refusedPort = await new Promise<number>((resolve) => {
      const srv = http.createServer()
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as { port: number }).port
        srv.close(() => setTimeout(() => resolve(p), 100))
      })
    })
    const r = await run('mock-chat-mini', false, { baseUrl: `http://127.0.0.1:${refusedPort}` })
    expect(r.ok).toBe(false)
    expect(r.phase).toBe('connect')
    expect(r.errorCode).toBe('ECONNREFUSED')
    expect(r.diagnosis?.possibleCauses.some((c) => c.cause.includes('TCP'))).toBe(true)
  }, 20000)

  it('DNS 失败 → dns 阶段', async () => {
    const r = await run('mock-chat-mini', false, { baseUrl: 'https://definitely-not-exist-abcxyz.invalid' })
    expect(r.ok).toBe(false)
    expect(r.phase).toBe('dns')
    expect(r.diagnosis?.possibleCauses[0].cause).toContain('域名')
  }, 20000)
})

describe('模型目录（场景 12,13）', () => {
  it('正常目录解析：capabilities 提取为"文档声明"', async () => {
    const r = adapter.parseModelsResponse(
      JSON.stringify({ data: [{ id: 'm1', owned_by: 'org', capabilities: ['chat', 'tools'] }, 'string-model'] })
    )
    expect(r.entries).toHaveLength(2)
    expect(r.entries[0].declaredCapabilities).toEqual(['chat', 'tools'])
    expect(r.entries[0].ownedBy).toBe('org')
    expect(r.entries[1].id).toBe('string-model')
  })

  it('空模型列表（场景 12）→ 空 entries 且不报错', async () => {
    const res = await fetch(`${base}/v1/models-empty`, { headers: { Authorization: `Bearer ${KEY}` } })
    const r = adapter.parseModelsResponse(await res.text())
    expect(r.entries).toEqual([])
    expect(r.error).toBeUndefined()
  })

  it('不规范目录数据（场景 13）→ 跳过畸形条目不崩溃', async () => {
    const res = await fetch(`${base}/v1/models-malformed`, { headers: { Authorization: `Bearer ${KEY}` } })
    const r = adapter.parseModelsResponse(await res.text())
    expect(r.entries.length).toBeGreaterThanOrEqual(2)
    expect(r.entries.every((e) => typeof e.id === 'string')).toBe(true)
    // capabilities 中含非字符串的条目 → 声明不提取
    expect(r.entries.find((e) => e.id === 'good-model-2')?.declaredCapabilities).toBeUndefined()
  })

  it('目录接口返回 HTML → 明确错误，不猜测', async () => {
    const res = await fetch(`${base}/v1/models-nonjson`, { headers: { Authorization: `Bearer ${KEY}` } })
    const r = adapter.parseModelsResponse(await res.text())
    expect(r.entries).toEqual([])
    expect(r.error).toContain('JSON')
  })
})

describe('协议行为（参数最小化原则）', () => {
  it('未设置的参数不出现在请求体中', () => {
    const built = adapter.buildChatRequest(provider(), 'k', {
      model: 'm',
      prompt: 'p',
      stream: false
    })
    const body = JSON.parse(built.body!)
    expect(body).toEqual({ model: 'm', messages: [{ role: 'user', content: 'p' }], stream: false })
    expect(body.temperature).toBeUndefined()
    expect(body.max_tokens).toBeUndefined()
  })

  it('明确设置才发送 max_tokens / temperature', () => {
    const built = adapter.buildChatRequest(provider(), 'k', {
      model: 'm',
      prompt: 'p',
      stream: false,
      maxTokens: 100,
      temperature: 0.5
    })
    const body = JSON.parse(built.body!)
    expect(body.max_tokens).toBe(100)
    expect(body.temperature).toBe(0.5)
  })

  it('stream_options.include_usage 仅在用户勾选时发送', () => {
    const withOpt = JSON.parse(
      adapter.buildChatRequest(provider(), 'k', { model: 'm', prompt: 'p', stream: true, streamIncludeUsage: true }).body!
    )
    expect(withOpt.stream_options).toEqual({ include_usage: true })
    const without = JSON.parse(
      adapter.buildChatRequest(provider(), 'k', { model: 'm', prompt: 'p', stream: true }).body!
    )
    expect(without.stream_options).toBeUndefined()
  })

  it('自定义头可覆盖协议头；URL 拼接正确', () => {
    const p = provider({
      headers: [{ name: 'X-Custom', value: 'v1', sensitive: true }],
      chatPath: '/v1/chat/completions'
    })
    const built = adapter.buildChatRequest(p, 'k', { model: 'm', prompt: 'p', stream: false })
    expect(built.headers['X-Custom']).toBe('v1')
    expect(built.url).toBe(`${base}/v1/chat/completions`)
    // base 带 /v1 时无重复
    const p2 = provider({ baseUrl: `${base}/v1` })
    expect(adapter.buildChatRequest(p2, 'k', { model: 'm', prompt: 'p', stream: false }).url).toBe(
      `${base}/v1/chat/completions`
    )
  })
})

// ---------- mock server 独立验证 ----------

describe('模拟服务直连验证（场景 10 补充：非 JSON 请求体）', () => {
  function post(pathname: string, body: string, key = KEY): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${base}${pathname}`,
        { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } },
        (res) => {
          let t = ''
          res.on('data', (c) => (t += c))
          res.on('end', () => resolve({ status: res.statusCode!, text: t }))
        }
      )
      req.on('error', reject)
      req.end(body)
    })
  }

  it('坏密钥 401', async () => {
    const r = await post('/v1/chat/completions', JSON.stringify({ model: 'm', messages: [] }), 'bad-key')
    expect(r.status).toBe(401)
  })

  it('非 JSON 请求体 → 400', async () => {
    const r = await post('/v1/chat/completions', 'not-json')
    expect(r.status).toBe(400)
  })

  it('未知路径 → 404', async () => {
    const r = await post('/unknown-path', '{}')
    expect(r.status).toBe(404)
  })
})
