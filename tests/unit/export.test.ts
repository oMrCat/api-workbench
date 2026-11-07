import { describe, it, expect } from 'vitest'
import { buildCurlSample, buildJsonReport, buildMarkdownReport } from '../../src/main/report/export'
import type { TestRunRecord } from '@shared/types'

function sampleRecord(): TestRunRecord {
  return {
    id: 'run-x',
    startedAt: 1700000000000,
    finishedAt: 1700000000500,
    providerId: 'p1',
    providerName: '模拟服务商',
    model: 'mock-chat-mini',
    protocol: 'openai-chat',
    stream: false,
    request: {
      url: 'https://api.example.com/v1/chat/completions',
      method: 'POST',
      headers: { Authorization: '***REDACTED***', 'Content-Type': 'application/json' },
      body: '{"model":"mock-chat-mini","messages":[{"role":"user","content":"你好"}]}'
    },
    httpStatus: 200,
    ok: true,
    phase: 'success',
    timing: { totalMs: 500, ttfbMs: 80, firstContentMs: undefined },
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    text: '模拟回复文本',
    diagnosis: {
      facts: ['请求阶段：成功'],
      possibleCauses: [],
      suggestions: ['如需验证更高阶能力请进一步测试'],
      uncertainty: '成功记录无需根因分析；以上为观察事实。'
    }
  }
}

describe('报告导出（场景：默认脱敏、不含正文）', () => {
  it('JSON 报告：包含结构化记录与提示声明', () => {
    const out = buildJsonReport({ records: [sampleRecord()], includeBodies: false, generatedAt: 1700000000600, appVersion: '0.1.0' })
    const parsed = JSON.parse(out)
    expect(parsed.tool).toBe('API Workbench')
    expect(parsed.records).toHaveLength(1)
    expect(parsed.records[0].httpStatus).toBe(200)
    expect(parsed.notice.join('')).toContain('REDACTED')
    // includeBodies=false 时不包含原始响应
    expect(parsed.records[0].rawResponsePreview).toBeUndefined()
    expect(parsed.records[0].streamEvents).toBeUndefined()
  })

  it('Markdown 报告：usage 缺失显示"上游未返回"，不伪造', () => {
    const rec = sampleRecord()
    rec.usage = undefined
    const out = buildMarkdownReport({ records: [rec], includeBodies: false, generatedAt: 1700000000600, appVersion: '0.1.0' })
    expect(out).toContain('上游未返回')
    expect(out).toContain('***REDACTED***') // 请求头脱敏保留
    expect(out).toContain('未包含在报告中')
  })

  it('Markdown 报告：有 usage 时原样展示', () => {
    const out = buildMarkdownReport({ records: [sampleRecord()], includeBodies: false, generatedAt: 1700000000600, appVersion: '0.1.0' })
    expect(out).toContain('"prompt_tokens": 10'.replace(' ', ''))
    expect(out).toContain('prompt_tokens')
  })

  it('curl 示例：不含真实密钥，含占位符警告', () => {
    const out = buildCurlSample(sampleRecord())
    expect(out).toContain("Authorization: Bearer $API_WORKBENCH_KEY")
    expect(out).not.toContain('sk-') // 占位符之外无任何密钥形态
    expect(out).toContain('替换')
    expect(out).toContain("'Content-Type: application/json'")
    expect(out).toContain('https://api.example.com/v1/chat/completions')
  })

  it('curl 示例：无 Authorization 头时不生成密钥行', () => {
    const rec = sampleRecord()
    delete rec.request.headers['Authorization']
    const out = buildCurlSample(rec)
    expect(out).not.toContain('Bearer')
  })

  it('includeBodies=true 时 JSON 包含正文（供用户明确确认后的导出）', () => {
    const rec = sampleRecord()
    rec.rawResponsePreview = '{"choices":[{"message":{"content":"全文内容"}}]}'
    rec.streamEvents = [{ seq: 0, tMs: 10, data: 'x' }]
    const out = buildJsonReport({ records: [rec], includeBodies: true, generatedAt: 1700000000600, appVersion: '0.1.0' })
    const parsed = JSON.parse(out)
    expect(parsed.includeBodies).toBe(true)
    expect(parsed.records[0].rawResponsePreview).toContain('全文内容')
    expect(parsed.records[0].streamEvents).toHaveLength(1)
  })
})
