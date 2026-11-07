import { describe, it, expect } from 'vitest'
import { joinUrl, isLoopbackHost, plainHttpWarning, UrlJoinError } from '@shared/url'

describe('URL 拼接（场景 16）', () => {
  it('常规拼接 /v1', () => {
    expect(joinUrl('https://api.example.com/v1', '/v1/chat/completions')).toBe('https://api.example.com/v1/chat/completions')
  })

  it('base 不带 /v1', () => {
    expect(joinUrl('https://api.example.com', '/v1/chat/completions')).toBe('https://api.example.com/v1/chat/completions')
  })

  it('base 带 /v1 且 path 不带', () => {
    expect(joinUrl('https://api.example.com/v1/', 'chat/completions')).toBe('https://api.example.com/v1/chat/completions')
  })

  it('base 带尾斜杠与 path 带头斜杠不产生双斜杠', () => {
    expect(joinUrl('https://api.example.com/v1/', '/chat/completions')).toBe('https://api.example.com/v1/chat/completions')
  })

  it('自定义路径覆盖不受 /v1 干扰', () => {
    expect(joinUrl('https://gateway.example.com/openai', '/v1/models')).toBe('https://gateway.example.com/openai/v1/models')
  })

  it('末段与首段相同时去重（api/api）', () => {
    expect(joinUrl('https://x.example.com/api', '/api/models')).toBe('https://x.example.com/api/models')
  })

  it('末段与首段不同则不去重', () => {
    expect(joinUrl('https://x.example.com/v1', '/chat/completions')).toBe('https://x.example.com/v1/chat/completions')
  })

  it('base 含查询参数时报错（避免密钥被误导出）', () => {
    expect(() => joinUrl('https://x.example.com?key=abc', '/v1/models')).toThrow(UrlJoinError)
  })

  it('拒绝非 http/https 协议', () => {
    expect(() => joinUrl('file:///etc/passwd', '/v1')).toThrow(UrlJoinError)
    expect(() => joinUrl('ftp://x.com', '/v1')).toThrow(UrlJoinError)
  })

  it('非法 URL 报错', () => {
    expect(() => joinUrl('not a url', '/v1')).toThrow(UrlJoinError)
  })
})

describe('本地回环与明文 HTTP 风险（场景：安全要求）', () => {
  it('localhost 是回环', () => {
    expect(isLoopbackHost('http://localhost:8045/x')).toBe(true)
    expect(isLoopbackHost('http://127.0.0.1:8045/x')).toBe(true)
    expect(isLoopbackHost('http://[::1]:8045/x')).toBe(true)
  })

  it('公网地址不是回环', () => {
    expect(isLoopbackHost('https://api.example.com')).toBe(false)
    expect(isLoopbackHost('http://192.168.1.5:8045')).toBe(false)
  })

  it('明文 HTTP + 非本地 → 有风险提示', () => {
    expect(plainHttpWarning('http://api.example.com')).toContain('明文 HTTP')
    expect(plainHttpWarning('http://localhost:8045')).toBeNull()
    expect(plainHttpWarning('https://api.example.com')).toBeNull()
  })
})
