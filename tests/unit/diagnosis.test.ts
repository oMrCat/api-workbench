import { describe, it, expect } from 'vitest'
import { diagnose } from '../../src/main/diagnosis'

const base = { timing: {} }

describe('诊断规则引擎（场景：诊断正确性与不确定性）', () => {
  it('DNS 阶段失败 → 高可能性为域名问题', () => {
    const d = diagnose({ ...base, phase: 'dns' })
    expect(d.facts.some((f) => f.includes('DNS'))).toBe(true)
    expect(d.possibleCauses[0].likelihood).toBe('high')
    expect(d.possibleCauses[0].cause).toContain('域名')
    expect(d.suggestions.length).toBeGreaterThan(0)
    expect(d.uncertainty).toContain('不足以确定唯一根因')
  })

  it('连接失败 → 提示服务未启动/防火墙', () => {
    const d = diagnose({ ...base, phase: 'connect' })
    expect(d.possibleCauses.some((c) => c.cause.includes('TCP'))).toBe(true)
  })

  it('TLS 阶段 → 证书问题', () => {
    const d = diagnose({ ...base, phase: 'tls' })
    expect(d.possibleCauses.some((c) => c.cause.includes('TLS'))).toBe(true)
  })

  it('401 → 认证失败（高可能性）', () => {
    const d = diagnose({ ...base, phase: 'response', httpStatus: 401 })
    expect(d.possibleCauses.some((c) => c.cause.includes('认证'))).toBe(true)
    expect(d.suggestions.some((s) => s.includes('API Key'))).toBe(true)
  })

  it('403 → 权限/授权问题（不是简单说认证无效）', () => {
    const d = diagnose({ ...base, phase: 'response', httpStatus: 403 })
    expect(d.possibleCauses.some((c) => c.cause.includes('授权'))).toBe(true)
  })

  it('404 → 路径拼接与模型名两个方向', () => {
    const d = diagnose({ ...base, phase: 'response', httpStatus: 404 })
    expect(d.possibleCauses.some((c) => c.cause.includes('路径'))).toBe(true)
    expect(d.possibleCauses.some((c) => c.cause.includes('模型'))).toBe(true)
    expect(d.suggestions.some((s) => s.includes('/v1/v1'))).toBe(true)
  })

  it('429 → 限流；不自动无限重试建议', () => {
    const d = diagnose({ ...base, phase: 'response', httpStatus: 429 })
    expect(d.possibleCauses.some((c) => c.cause.includes('限流'))).toBe(true)
    expect(d.suggestions.some((s) => s.includes('Retry-After') || s.includes('降低请求频率'))).toBe(true)
  })

  it('502 → 不归因于客户端，说明是服务端问题', () => {
    const d = diagnose({ ...base, phase: 'response', httpStatus: 502 })
    const c = d.possibleCauses.find((x) => x.cause.includes('502'))
    expect(c).toBeDefined()
    expect(c!.cause).toContain('服务端')
    expect(c!.note).toContain('服务端侧错误')
  })

  it('400 + 响应体提到参数 → 参数不支持（不是笼统"模型不支持"）', () => {
    const d = diagnose({
      ...base,
      phase: 'response',
      httpStatus: 400,
      errorBodyPreview: '{"error":{"message":"temperature is not supported"}}'
    })
    expect(d.possibleCauses.some((c) => c.cause.includes('参数不支持'))).toBe(true)
    expect(d.suggestions.some((s) => s.includes('取消勾选'))).toBe(true)
  })

  it('400 + 响应体提到 context → 上下文超限', () => {
    const d = diagnose({
      ...base,
      phase: 'response',
      httpStatus: 400,
      errorBodyPreview: 'maximum context length exceeded'
    })
    expect(d.possibleCauses.some((c) => c.cause.includes('上下文长度超限'))).toBe(true)
  })

  it('响应体为 HTML → 识别为打错端点', () => {
    const d = diagnose({
      ...base,
      phase: 'response',
      httpStatus: 200,
      errorBodyPreview: '<html><body>hello</body></html>'
    })
    expect(d.possibleCauses.some((c) => c.cause.includes('HTML'))).toBe(true)
  })

  it('invalid_api_key 明确证据优先，收敛原因列表', () => {
    const d = diagnose({
      ...base,
      phase: 'response',
      httpStatus: 401,
      errorBodyPreview: '{"error":{"code":"invalid_api_key","message":"Incorrect API key"}}'
    })
    expect(d.possibleCauses.some((c) => c.cause.includes('API Key 无效'))).toBe(true)
    // 收敛后不应还保留"自定义头覆盖"等猜测
    expect(d.possibleCauses.some((c) => c.cause.includes('网关剥离'))).toBe(false)
  })

  it('流中断 → 代理超时/网络抖动方向 + 非流式对照建议', () => {
    const d = diagnose({ ...base, phase: 'stream', stream: true, streamInterrupted: true })
    expect(d.possibleCauses.some((c) => c.cause.includes('流中途断开'))).toBe(true)
    expect(d.suggestions.some((s) => s.includes('非流式对照'))).toBe(true)
  })

  it('超时 → 建议调大超时或降低输出', () => {
    const d = diagnose({ ...base, phase: 'timeout', timedOut: true })
    expect(d.possibleCauses.some((c) => c.cause.includes('超时上限'))).toBe(true)
  })

  it('取消 → 明确说"取消不算失败"', () => {
    const d = diagnose({ ...base, phase: 'cancelled', cancelled: true })
    expect(d.facts.some((f) => f.includes('取消不算失败'))).toBe(true)
  })

  it('成功记录给出事实清单，不做根因臆测', () => {
    const d = diagnose({
      ...base,
      phase: 'success',
      timing: { totalMs: 123, ttfbMs: 45, firstContentMs: 67 },
      stream: true
    })
    expect(d.facts.some((f) => f.includes('123'))).toBe(true)
    expect(d.facts.some((f) => f.includes('67'))).toBe(true)
    expect(d.uncertainty).toContain('成功记录无需根因分析')
  })

  it('未知阶段有兜底归类且不确定性声明始终存在', () => {
    const d = diagnose({ ...base, phase: 'unknown' })
    expect(d.possibleCauses.some((c) => c.cause.includes('未知'))).toBe(true)
    expect(d.uncertainty.length).toBeGreaterThan(10)
  })
})
