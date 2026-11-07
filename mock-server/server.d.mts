// mock-server/server.mjs 的类型声明（供 TypeScript 测试与主进程引用）
export interface MockHandle {
  port: number
  close(): Promise<void>
}
export function startMockServer(port?: number, log?: (msg: string) => void): Promise<MockHandle>
