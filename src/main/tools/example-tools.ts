// 固定的无副作用示例工具(P1 工具调用测试)。
// 安全边界:
// - 只有本注册表中的工具会被执行;模型给出的未知工具名一律拒绝
// - 工具实现为纯本地函数:无网络、无文件系统、无子进程、无任意代码执行
// - 参数以 JSON 解析并做类型校验,失败即返回错误,不猜测

import type { ToolDefinition } from '@shared/types'

export interface ExampleTool extends ToolDefinition {
  execute(args: Record<string, unknown>): Record<string, unknown>
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

export const EXAMPLE_TOOLS: ExampleTool[] = [
  {
    name: 'calculate_sum',
    description: '计算两个数字的和。参数:a(数字)、b(数字)。',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'number', description: '第一个加数' },
        b: { type: 'number', description: '第二个加数' }
      },
      required: ['a', 'b']
    },
    execute(args) {
      const { a, b } = args
      if (!isFiniteNumber(a) || !isFiniteNumber(b)) {
        throw new Error('参数 a、b 必须是数字')
      }
      return { sum: a + b, expression: `${a} + ${b}` }
    }
  },
  {
    name: 'get_fixed_greeting',
    description: '返回一条固定的问候语(用于验证工具回传链路,无任何外部影响)。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute() {
      return { greeting: 'Hello from API Workbench 示例工具!' }
    }
  }
]

export function toolDefinitions(): ToolDefinition[] {
  return EXAMPLE_TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }))
}

export interface ToolExecutionResult {
  status: 'ok' | 'rejected' | 'failed'
  resultJson?: string
  error?: string
}

/** 工具调用的唯一执行入口:白名单校验 → JSON 解析 → 执行 → 序列化 */
export function executeToolCall(name: string, argsJson: string): ToolExecutionResult {
  const tool = EXAMPLE_TOOLS.find((t) => t.name === name)
  if (!tool) {
    return { status: 'rejected', error: `未知工具 "${name}":不在固定示例工具白名单中,已拒绝执行` }
  }
  let args: Record<string, unknown>
  try {
    const parsed = JSON.parse(argsJson || '{}')
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'failed', error: '参数 JSON 不是对象' }
    }
    args = parsed as Record<string, unknown>
  } catch (e) {
    return { status: 'failed', error: `参数 JSON 解析失败:${String((e as Error).message)}` }
  }
  try {
    const result = tool.execute(args)
    return { status: 'ok', resultJson: JSON.stringify(result) }
  } catch (e) {
    return { status: 'failed', error: String((e as Error).message) }
  }
}
