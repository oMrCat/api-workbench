// API Workbench 模拟服务：零依赖 Node HTTP 服务，覆盖全部测试场景。
// 运行：node mock-server/server.mjs（默认端口 8045，可用 MOCK_PORT 环境变量覆盖）
// 编程启动：import { startMockServer } from './server.mjs' → { port, close() }

import * as http from 'node:http'
import * as path from 'node:path'

const VALID_KEY_PREFIX = 'sk-mock' // 任何以 sk-mock 开头的 Key 均有效，便于测试

const CATALOG_MODELS = [
  { id: 'mock-chat-mini', owned_by: 'api-workbench', capabilities: ['chat'] },
  { id: 'mock-chat-pro', owned_by: 'api-workbench', capabilities: ['chat', 'tools'] },
  { id: 'mock-chat-vision', owned_by: 'api-workbench', capabilities: ['chat', 'vision'] },
  { id: 'mock-chat-streamer', owned_by: 'api-workbench', capabilities: ['chat', 'streaming'] },
  { id: 'mock-403', owned_by: 'api-workbench' },
  { id: 'mock-404', owned_by: 'api-workbench' },
  { id: 'mock-429', owned_by: 'api-workbench' },
  { id: 'mock-500', owned_by: 'api-workbench' },
  { id: 'mock-502', owned_by: 'api-workbench' },
  { id: 'mock-502-html', owned_by: 'api-workbench' },
  { id: 'mock-hang', owned_by: 'api-workbench' },
  { id: 'mock-slow', owned_by: 'api-workbench' },
  { id: 'mock-break', owned_by: 'api-workbench' },
  { id: 'mock-nonjson', owned_by: 'api-workbench' }
]

function json(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

/** 非流式 Chat Completions 响应体 */
function chatResponse(model, prompt, usageOverride) {
  return {
    id: `chatcmpl-mock-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: `【模拟回复】模型 ${model} 已收到提示词（${prompt.length} 字符）。本条消息由本地模拟服务生成，未连接任何真实模型。` },
        finish_reason: 'stop'
      }
    ],
    usage: usageOverride ?? {
      prompt_tokens: Math.ceil(prompt.length / 4),
      completion_tokens: 24,
      total_tokens: Math.ceil(prompt.length / 4) + 24
    }
  }
}

/** 流式事件序列（OpenAI Chat 格式）。includeUsage 控制是否发送 usage 事件。 */
function streamChunksFor(model, prompt, includeUsage) {
  const evts = []
  const id = `chatcmpl-mock-stream-${Date.now().toString(36)}`
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
  evts.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
  // 用一段含多字节 UTF-8 的文本验证跨分块解析（emoji + 中文 + 日文混排）
  const text = '你好！这是流式模拟回复：朵朵葵花向太阳☀️、日本語テキスト、emoji 🎉🚀。所有多字节字符将跨网络分块发送。'
  // 按 UTF-8 码点切成 6 段，随后按字节随机切分制造跨块字符
  const parts = []
  const seg = Math.ceil(text.length / 6)
  for (let i = 0; i < text.length; i += seg) parts.push(text.slice(i, i + seg))
  for (const p of parts) {
    evts.push({ ...base, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] })
  }
  evts.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  if (includeUsage) {
    evts.push({
      id,
      object: 'chat.completion.chunk',
      created: base.created,
      model,
      choices: [],
      usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: 42, total_tokens: Math.ceil(prompt.length / 4) + 42 }
    })
  }
  evts.push('[DONE]')
  return evts
}

/** 把事件序列编码为 SSE 文本 */
function encodeSse(evts) {
  return evts
    .map((e) => (e === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(e)}\n\n`))
    .join('')
}

/**
 * 把 SSE 文本按指定字节数切分并延迟写出。
 * 切分按 UTF-8 字节边界进行，可故意落在多字节字符中间（验证渲染端解码）。
 * splitOffset：分块大小（字节）；为 0 时整段一次发出。
 */
async function writeSseSplit(res, sseText, chunkBytes, delayMs) {
  const buf = Buffer.from(sseText, 'utf-8')
  if (!chunkBytes || chunkBytes <= 0) {
    res.write(buf)
    return
  }
  let off = 0
  while (off < buf.length) {
    // 找到下一个切割点；若落在多字节字符中间也照切（这正是要测的场景）
    let end = Math.min(off + chunkBytes, buf.length)
    res.write(buf.subarray(off, end))
    off = end
    if (delayMs > 0) await sleep(delayMs)
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export function startMockServer(port = 0, log = () => {}) {
  const server = http.createServer((req, res) => {
    void handle(req, res, log)
  })
  // 客户端取消/断开时不要崩溃
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })
  // 默认 5s 的 keep-alive 空闲超时会与 undici 连接复用发生竞态
  // （POST 不重试，恰好在关闭瞬间复用会得到 UND_ERR_SOCKET），延长之
  server.keepAliveTimeout = 300000
  server.headersTimeout = 310000
  // 任何意外异常都留下痕迹再退出，绝不静默死亡
  process.on('uncaughtException', (err) => {
    console.error(`[mock] uncaughtException: ${err?.stack ?? err}`)
    process.exit(1)
  })
  process.on('unhandledRejection', (err) => {
    console.error(`[mock] unhandledRejection: ${err?.stack ?? err}`)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      log(`mock server listening on 127.0.0.1:${actual}`)
      resolve({
        port: actual,
        close: () =>
          new Promise((done) => {
            // 销毁所有残留连接（hang 场景会挂住连接）
            server.closeAllConnections?.()
            server.close(() => done())
          })
      })
    })
  })
}

async function handle(req, res, log) {
  const urlPath = new URL(req.url, 'http://localhost').pathname
  const auth = req.headers['authorization'] ?? ''
  const keyOk = auth.startsWith('Bearer ') && auth.slice(7).startsWith(VALID_KEY_PREFIX)
  log(`${req.method} ${urlPath}`)

  // ---------- 模型目录 ----------
  // 认证:OpenAI 风格 Bearer 或 Anthropic 风格 x-api-key 均接受(目录端点两种协议共用)
  const anthropicKey = req.headers['x-api-key'] ?? ''
  const keyOkAny = keyOk || (typeof anthropicKey === 'string' && anthropicKey.startsWith(VALID_KEY_PREFIX))
  if (req.method === 'GET' && urlPath.startsWith('/v1/models')) {
    if (!keyOkAny) return json(res, 401, { error: { message: 'Invalid API key (mock)', code: 'invalid_api_key' } })
    if (urlPath === '/v1/models-empty') return json(res, 200, { object: 'list', data: [] })
    if (urlPath === '/v1/models-malformed') {
      return json(res, 200, {
        object: 'list',
        data: [
          { id: 'good-model-1' },
          'plain-string-model',
          { no_id_field: true },
          { id: 12345 },
          null,
          { id: 'good-model-2', owned_by: 'someone', capabilities: ['chat', 42, 'tools'] }
        ]
      })
    }
    if (urlPath === '/v1/models-nonjson') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      return res.end('<html><body><h1>Oops</h1></body></html>')
    }
    return json(res, 200, { object: 'list', data: CATALOG_MODELS })
  }

  // ---------- Chat Completions ----------
  if (req.method === 'POST' && urlPath.includes('/chat/completions')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      void handleChat(req, res, body, keyOk, log)
    })
    return
  }

  // ---------- Anthropic Messages ----------
  if (req.method === 'POST' && urlPath.includes('/messages')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      void handleAnthropic(req, res, body, log)
    })
    return
  }

  // ---------- 其他路径 ----------
  if (urlPath === '/' || urlPath === '/health') {
    return json(res, 200, { ok: true, service: 'api-workbench-mock' })
  }
  json(res, 404, { error: { message: `未知路径 ${urlPath}（模拟服务）`, code: 'not_found' } })
}

async function handleChat(req, res, body, keyOk, log) {
  let parsed = {}
  try {
    parsed = JSON.parse(body)
  } catch {
    return json(res, 400, { error: { message: '请求体不是 JSON（模拟服务）', code: 'bad_request' } })
  }
  const model = String(parsed.model ?? '')
  const prompt = String(parsed.messages?.[0]?.content ?? '')
  const stream = Boolean(parsed.stream)

  // 故障注入（按模型名）
  if (!keyOk) return json(res, 401, { error: { message: 'Invalid API key (mock)。请使用以 sk-mock 开头的测试密钥。', code: 'invalid_api_key' } })

  if (model === 'mock-403') {
    return json(res, 403, { error: { message: 'You are not allowed to access this model (mock). Key 有效但无权限。', code: 'model_access_denied' } })
  }
  if (model === 'mock-404') {
    return json(res, 404, { error: { message: `The model '${model}' does not exist (mock)`, code: 'model_not_found' } })
  }
  if (model === 'mock-429') {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '2' })
    return res.end(JSON.stringify({ error: { message: 'Rate limit exceeded (mock)', code: 'rate_limit_exceeded' } }))
  }
  if (model === 'mock-500') {
    return json(res, 500, { error: { message: 'Internal server error (mock upstream)', code: 'internal_error' } })
  }
  if (model === 'mock-502') {
    return json(res, 502, { error: { message: 'Bad gateway: upstream connector failed (mock)', code: 'bad_gateway' } })
  }
  if (model === 'mock-502-html') {
    res.writeHead(502, { 'Content-Type': 'text/html' })
    return res.end('<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1><p>nginx/1.24 (mock)</p></body></html>')
  }
  if (model === 'mock-nonjson') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end('<html><body>我是一段网页而不是 JSON</body></html>')
  }
  if (model === 'mock-hang') {
    // 永不响应：客户端应通过超时或取消断开。30 秒后服务端主动断开兜底。
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write(' ') // 发半个响应头+一个字节，模拟"连上了但没结果"
    await sleep(30000)
    return res.destroy()
  }
  if (model === 'mock-break') {
    // 开始流式传输，然后中途暴力断开
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }) + '\n\n')
    res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '前半段内容已发出，' }, finish_reason: null }] }) + '\n\n')
    await sleep(100)
    log('mock-break: 强制断开连接')
    return res.destroy()
  }
  if (model === 'mock-slow') {
    // 慢速流：每块 200ms，共 5 块（用于取消测试：用户可中途取消）
    // 注意：只检查 res.destroyed。req.destroyed 在客户端(undici)完成请求体后会变 true,
    // 与响应通道是否存活无关——误判会导致服务器中途放弃响应,客户端永久挂起。
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const parts = ['第一块', '第二块', '第三块', '第四块', '第五块']
    for (const p of parts) {
      if (res.destroyed) return
      res.write(`data: ${JSON.stringify({ id: 'slow', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: p }, finish_reason: null }] })}\n\n`)
      await sleep(200)
    }
    res.write('data: [DONE]\n\n')
    return res.end()
  }

  // 工具调用测试(P1):mock-tools 两轮行为
  // 第 1 轮(无 tool 消息)→ 请求调用 calculate_sum(2,3);第 2 轮(有 tool 消息)→ 最终回答
  if (model === 'mock-tools' && !stream) {
    const msgs = Array.isArray(parsed.messages) ? parsed.messages : []
    const toolMsg = msgs.find((m) => m.role === 'tool')
    if (!toolMsg) {
      return json(res, 200, {
        id: `chatcmpl-tool-${Date.now().toString(36)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_mock_1',
                  type: 'function',
                  function: { name: 'calculate_sum', arguments: '{"a":2,"b":3}' }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
      })
    }
    // 第 2 轮:回传结果后给最终答案
    let toolContent = ''
    try {
      toolContent = String(JSON.parse(toolMsg.content).sum ?? '')
    } catch {
      toolContent = String(toolMsg.content ?? '')
    }
    return json(res, 200, {
      id: `chatcmpl-tool-final-${Date.now().toString(36)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: `工具调用链路验证成功:calculate_sum(2,3) = ${toolContent}。这是回传结果后的最终回答。`
          },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 }
    })
  }

  // 正常模型（流式/非流式）
  if (stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const sseText = encodeSse(streamChunksFor(model, prompt, parsed.stream_options?.include_usage === true))
    // 按字节切成 7 块、每块间隔 30ms：制造跨块 UTF-8 与跨块事件
    await writeSseSplit(res, sseText, Math.max(16, Math.floor(Buffer.byteLength(sseText, 'utf8') / 7)), 30)
    return res.end()
  }
  // 非流式：轻微延迟模拟真实感
  await sleep(80)
  return json(res, 200, chatResponse(model, prompt))
}

// ---------- Anthropic Messages 处理 ----------
/** Anthropic 流式事件序列 */
function anthropicStreamEvents(model, prompt) {
  const id = `msg_mock_${Date.now().toString(36)}`
  const inputTokens = Math.ceil(prompt.length / 4)
  return [
    { event: 'message_start', data: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, usage: { input_tokens: inputTokens, output_tokens: 0 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好！这是 Anthropic 格式的流式模拟回复：葵花向阳☀️、テキスト、🎉。' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '分块之间有 150ms 间隔,用于验证流式解析与取消。' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 33 } } },
    { event: 'message_stop', data: { type: 'message_stop' } }
  ]
}

function anthropicSse(evts) {
  return evts.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('')
}

function anthropicNonStream(model, prompt) {
  return {
    id: `msg_mock_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: `【模拟回复·Anthropic】模型 ${model} 已收到提示词(${prompt.length} 字符)。本条由本地模拟服务生成,未连接任何真实模型。` }],
    stop_reason: 'end_turn',
    usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: 28 }
  }
}

function anthropicError(res, status, type, message) {
  return json(res, status, { type: 'error', error: { type, message } })
}

async function handleAnthropic(req, res, body, log) {
  const key = req.headers['x-api-key'] ?? ''
  if (!(typeof key === 'string' && key.startsWith(VALID_KEY_PREFIX))) {
    return anthropicError(res, 401, 'authentication_error', 'invalid x-api-key (mock)。请使用以 sk-mock 开头的测试密钥。')
  }
  let parsed = {}
  try {
    parsed = JSON.parse(body)
  } catch {
    return anthropicError(res, 400, 'invalid_request_error', '请求体不是 JSON(模拟服务)')
  }
  if (parsed.stream !== true && parsed.stream !== false) {
    return anthropicError(res, 400, 'invalid_request_error', '缺少 stream 字段(模拟服务校验)')
  }
  if (typeof parsed.max_tokens !== 'number') {
    // Anthropic 协议必填 max_tokens;模拟服务按真实行为拒绝
    return anthropicError(res, 400, 'invalid_request_error', 'max_tokens: field required (Anthropic 协议必填)')
  }
  const model = String(parsed.model ?? '')
  const prompt = String(parsed.messages?.[0]?.content ?? '')

  // 与 OpenAI 端点同一套故障注入(错误体用 Anthropic 格式)
  if (model === 'mock-403') return anthropicError(res, 403, 'permission_error', 'You are not allowed to access this model (mock).')
  if (model === 'mock-404') return anthropicError(res, 404, 'not_found_error', `The model '${model}' does not exist (mock)`)
  if (model === 'mock-429') {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '2' })
    return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limit exceeded (mock)' } }))
  }
  if (model === 'mock-500') return anthropicError(res, 500, 'api_error', 'Internal server error (mock upstream)')
  if (model === 'mock-502') return anthropicError(res, 502, 'api_error', 'Bad gateway: upstream connector failed (mock)')
  if (model === 'mock-nonjson') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end('<html><body>我是一段网页而不是 JSON</body></html>')
  }
  if (model === 'mock-hang') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write(' ')
    await sleep(30000)
    return res.destroy()
  }
  if (model === 'mock-slow') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const e of anthropicStreamEvents(model, prompt)) {
      if (res.destroyed) return
      res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
      await sleep(300)
    }
    return res.end()
  }

  if (parsed.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const sseText = anthropicSse(anthropicStreamEvents(model, prompt))
    await writeSseSplit(res, sseText, Math.max(16, Math.floor(Buffer.byteLength(sseText, 'utf8') / 7)), 30)
    return res.end()
  }
  await sleep(80)
  return json(res, 200, anthropicNonStream(model, prompt))
}

// CLI 直接运行(平台无关:Windows 下 argv[1] 是反斜杠路径,不能用 split('/') 判断)
import { fileURLToPath } from 'node:url'
const thisFile = fileURLToPath(import.meta.url)
const isDirectRun = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(thisFile)
if (isDirectRun && process.env.NODE_ENV !== 'test-import') {
  const port = Number(process.env.MOCK_PORT ?? 8045)
  startMockServer(port, (m) => console.log(`[mock] ${m}`)).then((h) => {
    console.log(`[mock] 模拟服务已启动：http://127.0.0.1:${h.port}`)
    console.log('[mock] 有效密钥：任何以 sk-mock 开头的字符串（如 sk-mock-test-key）')
    console.log('[mock] Ctrl+C 停止')
  })
  process.on('SIGINT', () => process.exit(0))
}
