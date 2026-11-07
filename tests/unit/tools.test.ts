import { describe, it, expect } from 'vitest'
import { executeToolCall, toolDefinitions, EXAMPLE_TOOLS } from '../../src/main/tools/example-tools'

describe('固定示例工具(P1 工具调用安全边界)', () => {
  it('白名单只有固定的无副作用工具', () => {
    expect(toolDefinitions().map((t) => t.name)).toEqual(['calculate_sum', 'get_fixed_greeting'])
  })

  it('calculate_sum 正常执行', () => {
    const r = executeToolCall('calculate_sum', '{"a":2,"b":3}')
    expect(r.status).toBe('ok')
    expect(JSON.parse(r.resultJson!)).toEqual({ sum: 5, expression: '2 + 3' })
  })

  it('未知工具被拒绝且不执行任何东西', () => {
    const r = executeToolCall('delete_all_files', '{}')
    expect(r.status).toBe('rejected')
    expect(r.error).toContain('白名单')
    expect(r.resultJson).toBeUndefined()
  })

  it('伪装成已知工具名的变体也被拒绝(严格匹配)', () => {
    expect(executeToolCall('calculate_sum ', '{}').status).toBe('rejected')
    expect(executeToolCall('Calculate_Sum', '{}').status).toBe('rejected')
  })

  it('参数 JSON 解析失败 → failed,不抛异常', () => {
    const r = executeToolCall('calculate_sum', '{not json')
    expect(r.status).toBe('failed')
    expect(r.error).toContain('解析失败')
  })

  it('参数类型错误 → failed(工具内校验)', () => {
    const r = executeToolCall('calculate_sum', '{"a":"x","b":1}')
    expect(r.status).toBe('failed')
    expect(r.error).toContain('必须是数字')
  })

  it('参数为数组/字符串等非对象 → failed', () => {
    expect(executeToolCall('calculate_sum', '[1,2]').status).toBe('failed')
    expect(executeToolCall('calculate_sum', '"hello"').status).toBe('failed')
  })

  it('空参数按 {} 处理(get_fixed_greeting 无参数可用)', () => {
    const r = executeToolCall('get_fixed_greeting', '')
    expect(r.status).toBe('ok')
    expect(JSON.parse(r.resultJson!).greeting).toContain('API Workbench')
  })

  it('每个工具声明了合法的 JSON Schema parameters', () => {
    for (const t of EXAMPLE_TOOLS) {
      expect(t.parameters.type).toBe('object')
      expect(typeof t.description).toBe('string')
      expect(t.description.length).toBeGreaterThan(3)
    }
  })
})
