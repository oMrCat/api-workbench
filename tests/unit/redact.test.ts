import { describe, it, expect } from 'vitest'
import {
  looksLikeSecret,
  redactHeader,
  redactUrl,
  redactText,
  redactCapturedRequest
} from '../../src/main/redact'

describe('脱敏（场景 15：日志与报告密钥脱敏）', () => {
  const secrets = ['sk-mock-real-secret-key-123', 'my-custom-header-secret']

  it('Authorization 头脱敏', () => {
    expect(redactHeader('Authorization', 'Bearer sk-abc', new Set())).toBe('***REDACTED***')
    expect(redactHeader('authorization', 'Bearer x', new Set())).toBe('***REDACTED***')
  })

  it('Cookie / Set-Cookie 脱敏', () => {
    expect(redactHeader('Cookie', 'session=abc', new Set())).toBe('***REDACTED***')
    expect(redactHeader('set-cookie', 'x=1', new Set())).toBe('***REDACTED***')
  })

  it('x-api-key 等变体脱敏', () => {
    expect(redactHeader('x-api-key', 'k', new Set())).toBe('***REDACTED***')
    expect(redactHeader('X-API-KEY', 'k', new Set())).toBe('***REDACTED***')
  })

  it('自定义敏感头脱敏（已知密钥值）', () => {
    expect(redactHeader('X-Gateway-Auth', 'my-custom-header-secret', new Set(secrets))).toBe('***REDACTED***')
  })

  it('常见密钥形态识别（sk- 前缀）', () => {
    expect(looksLikeSecret('sk-proj-abcdef12345678901234')).toBe(true)
    expect(looksLikeSecret('sk-ant-api03-abcdef1234567890')).toBe(true)
    expect(looksLikeSecret('ordinary text')).toBe(false)
  })

  it('形态像密钥的头值即使头名无害也脱敏', () => {
    expect(redactHeader('X-Trace', 'sk-proj-abcdef12345678901234', new Set())).toBe('***REDACTED***')
  })

  it('普通头保留', () => {
    expect(redactHeader('Content-Type', 'application/json', new Set())).toBe('application/json')
  })

  it('URL 中敏感查询参数脱敏', () => {
    const out = redactUrl('https://x.com/v1/models?key=SECRET123&page=2', new Set())
    expect(out).toContain('page=2')
    expect(out).not.toContain('SECRET123')
    expect(out).toContain('key=***REDACTED***')
  })

  it('URL 中已知密钥值脱敏', () => {
    const out = redactUrl('https://x.com/path?token=sk-mock-real-secret-key-123', new Set(secrets))
    expect(out).not.toContain('sk-mock-real-secret-key-123')
  })

  it('文本中已知密钥字符串整体抹除', () => {
    const out = redactText('请求头是 sk-mock-real-secret-key-123 请检查', secrets)
    expect(out).not.toContain('sk-mock-real-secret-key-123')
    expect(out).toContain('***REDACTED***')
  })

  it('文本中未知的 sk- 形态密钥也抹除（防御未知配置泄漏）', () => {
    const out = redactText('key=sk-unknown-abcdef12345678', new Set())
    expect(out).not.toContain('sk-unknown-abcdef12345678')
  })

  it('普通文本不受影响', () => {
    expect(redactText('普通回复内容，无密钥', new Set())).toBe('普通回复内容，无密钥')
  })

  it('完整请求对象脱敏：headers + url + body', () => {
    const req = {
      url: 'https://x.com/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: 'Bearer sk-mock-real-secret-key-123',
        'Content-Type': 'application/json'
      },
      body: '{"model":"m","meta":"my-custom-header-secret"}'
    }
    const out = redactCapturedRequest(req, secrets)
    expect(out.headers['Authorization']).toBe('***REDACTED***')
    expect(out.headers['Content-Type']).toBe('application/json')
    expect(String(out.body)).not.toContain('my-custom-header-secret')
    expect(out.url).toBe('https://x.com/v1/chat/completions')
  })
})
