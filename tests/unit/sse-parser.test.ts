import { describe, it, expect } from 'vitest'
import { SseDecoder } from '../../src/main/net/sse-parser'

const enc = (s: string) => new TextEncoder().encode(s)

describe('SSE 增量解析器（场景 3：跨分块事件与 UTF-8）', () => {
  it('单块单事件', () => {
    const d = new SseDecoder()
    const evts = d.push(enc('data: hello\n\n'))
    expect(evts).toHaveLength(1)
    expect(evts[0].data).toBe('hello')
  })

  it('一个数据块包含多个事件', () => {
    const d = new SseDecoder()
    const evts = d.push(enc('data: a\n\ndata: b\n\ndata: [DONE]\n\n'))
    expect(evts.map((e) => e.data)).toEqual(['a', 'b', '[DONE]'])
  })

  it('事件跨多个数据块（分块不等于事件边界）', () => {
    const d = new SseDecoder()
    expect(d.push(enc('data: he'))).toHaveLength(0)
    expect(d.push(enc('llo wo'))).toHaveLength(0)
    const evts = d.push(enc('rld\n\n'))
    expect(evts).toHaveLength(1)
    expect(evts[0].data).toBe('hello world')
  })

  it('事件边界恰好落在 data: 行中间', () => {
    const d = new SseDecoder()
    expect(d.push(enc('data: first\n\nda'))).toHaveLength(1)
    const evts = d.push(enc('ta: second\n\n'))
    expect(evts.map((e) => e.data)).toEqual(['second'])
  })

  it('UTF-8 多字节字符跨分块（emoji 与中文被字节切割）', () => {
    const d = new SseDecoder()
    const full = enc('data: 你好🎉世界\n\n')
    // 在字节 5 处切割——必然落在多字节字符中间
    const cut = 5
    expect(d.push(full.subarray(0, cut))).toHaveLength(0)
    const evts = d.push(full.subarray(cut))
    expect(evts).toHaveLength(1)
    expect(evts[0].data).toBe('你好🎉世界')
  })

  it('\\r\\n 行结束符与空行分隔（事件间 \r\n\r\n）', () => {
    const d = new SseDecoder()
    const evts = d.push(enc('data: a\r\n\r\ndata: b\r\n\r\n'))
    expect(evts.map((e) => e.data)).toEqual(['a', 'b'])
  })

  it('\\r 与 \\n 混用', () => {
    const d = new SseDecoder()
    const evts = d.push(enc('data: a\r\ndata: b\n\n'))
    expect(evts).toHaveLength(1)
    expect(evts[0].data).toBe('a\nb') // 多行 data 以 \n 连接
  })

  it('data: 后的前导空格按规范去除一个', () => {
    const d = new SseDecoder()
    const evts = d.push(enc('data:  two-spaces\n\n'))
    expect(evts[0].data).toBe(' two-spaces')
  })

  it('注释行被忽略', () => {
    const d = new SseDecoder()
    const evts = d.push(enc(': keep-alive\ndata: x\n\n'))
    expect(evts).toHaveLength(1)
    expect(evts[0].data).toBe('x')
  })

  it('event 与 id 字段解析', () => {
    const d = new SseDecoder()
    const evts = d.push(enc('event: message\nid: 42\ndata: {"a":1}\n\n'))
    expect(evts[0].event).toBe('message')
    expect(evts[0].id).toBe('42')
    expect(evts[0].data).toBe('{"a":1}')
  })

  it('flush 冲出无结尾空行的最后事件', () => {
    const d = new SseDecoder()
    expect(d.push(enc('data: [DONE]\n'))).toHaveLength(0)
    const evts = d.flush()
    expect(evts).toHaveLength(1)
    expect(evts[0].data).toBe('[DONE]')
  })

  it('分割字符残余序列在 flush 中冲出', () => {
    // "好"的 UTF-8 是 3 字节：给前 2 字节，flush 时 decoder.decode() 会补出替换字符
    const d2 = new SseDecoder()
    d2.push(enc('data: 好'.slice(0, 7)))
    const evts = d2.flush()
    expect(evts).toHaveLength(1)
    expect(evts[0].data.length).toBeGreaterThan(0)
  })

  it('超长事件触发防御性中止', () => {
    const d = new SseDecoder()
    const huge = 'x'.repeat(4 * 1024 * 1024 + 1)
    expect(() => d.push(enc(`data: ${huge}\n\n`))).toThrow(/上限/)
  })

  it('字节级随机切割的压力场景：完整文本最终一致', () => {
    const d = new SseDecoder()
    const text = 'data: ' + '混合文本Mixed Content🌷🌞🚀'.repeat(20) + '\n\n'
    const buf = enc(text)
    // 按 3 字节一切，模拟最恶劣的 TCP 分块；累积所有分块产出的事件
    const collected: string[] = []
    for (let i = 0; i < buf.length; i += 3) {
      collected.push(...d.push(buf.subarray(i, i + 3)).map((e) => e.data))
    }
    collected.push(...d.flush().map((e) => e.data))
    expect(collected).toHaveLength(1)
    expect(collected[0]).toBe(text.slice(6, -2))
  })
})
