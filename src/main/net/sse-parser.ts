// 增量 SSE 解析器。
// 设计目标：正确处理
// - 网络分块 ≠ 完整事件（一个事件跨多个 TCP/HTTP 数据块）；
// - 一个数据块包含多个事件；
// - UTF-8 多字节字符被切在分块边界；
// - \n 与 \r\n 混用；
// - 流正常结束（flush 剩余缓冲）。
// 纯模块，不依赖 electron。

export interface SseEvent {
  /** data: 行聚合后的内容（多行 data 以 \n 连接，按 SSE 规范） */
  data: string
  /** event: 行（可选） */
  event?: string
  id?: string
}

const MAX_EVENT = 4 * 1024 * 1024 // 单事件 4MB 上限，防御异常上游

export class SseDecoder {
  private buffer = ''
  private decoder = new TextDecoder('utf-8')

  /** 喂入一个二进制分块，返回其中完整解析出的事件 */
  push(chunk: Uint8Array): SseEvent[] {
    // stream:true 保证跨分块的 UTF-8 序列在 TextDecoder 内部被正确拼接
    const text = this.decoder.decode(chunk, { stream: true })
    // 预先规范化行结束符。结尾残留的孤立 \r 提前换成 \n 是安全的：
    // 若下一块以 \n 开头，则正好构成空行；若是孤立 \r，其本身也是行结束符。
    this.buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    return this.drain()
  }

  /** 流结束时调用，冲出缓冲区中的最后一段（若无结尾空行） */
  flush(): SseEvent[] {
    const text = this.decoder.decode() // 冲出 decoder 内不完整序列
    this.buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const ev = this.parseBlock(this.buffer)
    this.buffer = ''
    return ev.length > 0 ? ev : []
  }

  private drain(): SseEvent[] {
    const events: SseEvent[] = []
    let idx: number
    while ((idx = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 2)
      if (block.length > MAX_EVENT) {
        throw new Error(`SSE 单事件超过 ${MAX_EVENT} 字节上限，已中止解析（防御异常上游）`)
      }
      events.push(...this.parseBlock(block))
      if (this.buffer.length > MAX_EVENT) {
        throw new Error(`SSE 缓冲超过 ${MAX_EVENT} 字节仍未见事件边界，已中止解析`)
      }
    }
    return events
  }

  /** 解析一个事件块（已去除结尾空行）。返回空数组表示注释块/空块。 */
  private parseBlock(block: string): SseEvent[] {
    if (block.length > MAX_EVENT) {
      throw new Error(`SSE 单事件超过 ${MAX_EVENT} 字节上限`)
    }
    const lines = block.split('\n')
    let data: string[] = []
    let event: string | undefined
    let id: string | undefined
    let meaningful = false
    for (const line of lines) {
      if (line === '' || line.startsWith(':')) continue // 注释行
      meaningful = true
      if (line.startsWith('data:')) {
        // 规范：去掉 data: 后仅一个前导空格
        const v = line.slice(5)
        data.push(v.startsWith(' ') ? v.slice(1) : v)
      } else if (line.startsWith('event:')) {
        const v = line.slice(6)
        event = v.startsWith(' ') ? v.slice(1) : v
      } else if (line.startsWith('id:')) {
        const v = line.slice(3)
        id = v.startsWith(' ') ? v.slice(1) : v
      }
      // 其余字段（retry 等）忽略
    }
    if (!meaningful) return []
    const out = [{ data: data.join('\n'), event, id }]
    data = []
    return out
  }
}
