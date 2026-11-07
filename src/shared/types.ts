// 共享类型定义：主进程与渲染进程共同使用。
// 注意：本文件不得引入 electron 或任何 Node 专用模块。

export type ProtocolKind = 'openai-chat' | 'openai-responses' | 'anthropic-messages'

export const PROTOCOL_LABELS: Record<ProtocolKind, string> = {
  'openai-chat': 'OpenAI 兼容 Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages'
}

/** 服务商配置。API Key 不在此对象中，由密钥存储单独管理。 */
export interface ProviderConfig {
  id: string
  name: string
  baseUrl: string
  protocol: ProtocolKind
  /** 自定义请求头。值可能是敏感信息，展示与导出时必须脱敏。 */
  headers: CustomHeader[]
  timeoutMs: number
  /** 可选：模型列表路径覆盖，如 /v1/models */
  modelsPath?: string
  /** 可选：对话接口路径覆盖，如 /v1/chat/completions */
  chatPath?: string
  createdAt: number
  updatedAt: number
}

export interface CustomHeader {
  name: string
  value: string
  /** 用户标记该头的值为敏感信息（脱敏更彻底） */
  sensitive: boolean
}

/** 密钥存储状态 */
export type SecretStoreMode = 'system' | 'session-only'

export interface SecretStoreStatus {
  mode: SecretStoreMode
  /** 不可用时给用户看的解释 */
  reason?: string
}

// ---------- 模型目录 ----------

export type CapabilitySource = 'declared' | 'user-marked' | 'verified' | 'unverified'

export interface ModelEntry {
  id: string
  /** catalog = 从接口同步；manual = 用户手动输入 */
  origin: 'catalog' | 'manual'
  ownedBy?: string
  /** 供应商元数据声明的能力（仅代表文档/元数据，不代表已验证） */
  declaredCapabilities?: string[]
  /** 用户手动标记的能力 */
  userMarkedCapabilities?: string[]
  /** 实际测试通过的能力（有测试记录支撑） */
  verifiedCapabilities?: string[]
}

export type CatalogStatus = 'idle' | 'syncing' | 'ok' | 'error'

export interface ModelCatalog {
  providerId: string
  entries: ModelEntry[]
  status: CatalogStatus
  syncedAt?: number
  error?: string
  /** 原始返回数据预览（有大小上限） */
  rawPreview?: string
  /** 原始数据是否被截断 */
  rawTruncated?: boolean
}

// ---------- 工具调用(P1) ----------

/** 固定的无副作用示例工具定义(发送给模型的 JSON Schema) */
export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema(参数) */
  parameters: Record<string, unknown>
}

/** 一次工具调用步骤的完整记录(展示与导出用) */
export interface ToolCallStep {
  seq: number
  toolName: string
  /** 模型给出的原始参数 JSON */
  argumentsJson: string
  /** 本地执行结果(JSON 序列化);被拒绝时不填 */
  resultJson?: string
  /** 被拒绝或执行失败的原因 */
  error?: string
  durationMs?: number
  /** rejected = 白名单外被拒绝;failed = 执行抛错;ok = 成功 */
  status: 'ok' | 'rejected' | 'failed'
}

// ---------- 请求测试 ----------

export interface StreamEventLog {
  /** 事件序号 */
  seq: number
  tMs: number
  data: string
}

export interface RequestTiming {
  /** 总耗时 */
  totalMs?: number
  /** 收到 HTTP 响应头（TTFB） */
  ttfbMs?: number
  /** 首个有效内容片段（非响应头，协议适配层判定） */
  firstContentMs?: number
}

export interface DiagnosisCandidate {
  cause: string
  likelihood: 'high' | 'medium' | 'low'
  note?: string
}

export interface Diagnosis {
  /** 已观察到的事实 */
  facts: string[]
  /** 可能原因（按可能性排序） */
  possibleCauses: DiagnosisCandidate[]
  /** 建议排查步骤 */
  suggestions: string[]
  /** 结论不确定性说明 */
  uncertainty: string
}

export interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

export interface TestRunRecord {
  id: string
  startedAt: number
  finishedAt?: number
  providerId: string
  providerName: string
  model: string
  protocol: ProtocolKind
  stream: boolean
  request: CapturedRequest
  httpStatus?: number
  ok: boolean
  cancelled?: boolean
  timedOut?: boolean
  /** 阶段：在哪一步失败/完成 */
  phase: FailurePhase | 'success'
  timing: RequestTiming
  /** 上游返回的 usage 原始字段；未返回则为 undefined（显示"上游未返回"） */
  usage?: unknown
  /** 提取的文本（有上限） */
  text?: string
  textTruncated?: boolean
  /** 原始响应预览（有上限） */
  rawResponsePreview?: string
  rawTruncated?: boolean
  /** 流事件日志（有上限） */
  streamEvents?: StreamEventLog[]
  streamEventsTruncated?: boolean
  /** 底层错误码/异常名（不含敏感信息） */
  errorCode?: string
  errorMessage?: string
  diagnosis?: Diagnosis
  /** 错误响应体片段（有上限） */
  errorBodyPreview?: string
  /** 工具调用步骤(P1,toolsEnabled 时存在) */
  toolSteps?: ToolCallStep[]
  /** 工具循环轮数(1 = 模型直接回答,未调用工具) */
  toolRounds?: number
}

export type FailurePhase =
  | 'dns'
  | 'connect'
  | 'tls'
  | 'response'
  | 'parse'
  | 'stream'
  | 'timeout'
  | 'cancelled'
  | 'unknown'

// ---------- 测试执行参数 ----------

export interface TestParams {
  providerId: string
  model: string
  stream: boolean
  prompt: string
  /** 仅当用户设置时才发送 */
  maxTokens?: number
  temperature?: number
  /** openai 扩展：流式请求 usage（仅用户勾选时发送 stream_options.include_usage） */
  streamIncludeUsage?: boolean
  /** 渲染进程预生成的运行 ID（取消请求时按此 ID 匹配）；缺省由主进程生成 */
  runId?: string
  /** 工具调用测试(P1):启用后注入固定示例工具并自动回传结果 */
  toolsEnabled?: boolean
}

/** 运行过程中推送给渲染进程的事件 */
export type RunEvent =
  | { type: 'status'; runId: string; status: 'connecting' | 'headers-received' | 'streaming' | 'done' | 'error'; detail?: string }
  | { type: 'text-delta'; runId: string; delta: string }
  | { type: 'record'; runId: string; record: TestRunRecord }

// ---------- 应用信息与设置 ----------

export interface AppInfo {
  appVersion: string
  electronVersion: string
  nodeVersion: string
  chromeVersion: string
  platform: string
  arch: string
  userDataPath: string
  secretStore: SecretStoreStatus
}

export interface AppSettings {
  /** 是否持久化历史记录（记录本身已脱敏） */
  persistHistory: boolean
  historyLimit: number
  /** 单条流事件日志上限（条数） */
  streamLogLimit: number
  /** 流式空闲中断时间（毫秒） */
  streamIdleTimeoutMs: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  persistHistory: true,
  historyLimit: 200,
  streamLogLimit: 200,
  streamIdleTimeoutMs: 30000
}

/** 导出报告选项 */
export interface ExportOptions {
  recordIds: string[]
  format: 'markdown' | 'json'
  /** 默认不包含提示词与响应正文；包含时需用户明确确认 */
  includeBodies: boolean
}

export interface ExportResult {
  ok: boolean
  path?: string
  cancelled?: boolean
  error?: string
}

export interface MockServerStatus {
  running: boolean
  port?: number
  pid?: number
}
