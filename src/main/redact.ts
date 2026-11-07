// 脱敏模块：日志、历史记录、导出报告共用。
// 原则：默认脱敏一切疑似密钥的内容；宁可多脱，不可泄露。
// 纯模块，不依赖 electron。

/** 默认按请求头名脱敏的列表（不区分大小写） */
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-goog-api-key',
  'x-azure-api-key',
  'api-key-header'
])

/** URL 查询参数中视为敏感的键名 */
const SENSITIVE_QUERY_KEYS = new Set([
  'key',
  'api_key',
  'apikey',
  'api-key',
  'token',
  'access_token',
  'sig',
  'signature',
  'secret'
])

/** 常见密钥格式模式（值形态识别，无论出现在哪个字段） */
const KEY_VALUE_PATTERNS: RegExp[] = [
  /^sk-[A-Za-z0-9_-]{16,}$/, // OpenAI 风格
  /^sk-ant-[A-Za-z0-9_-]{16,}$/, // Anthropic 风格
  /^[A-Za-z0-9]{4,8}\.[A-Za-z0-9_-]{20,}$/, // token.id.secret 形态（部分国产云）
  /^ey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/ // JWT
]

export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_NAMES.has(name.toLowerCase())
}

export function looksLikeSecret(value: string): boolean {
  if (value.length < 12) return false
  return KEY_VALUE_PATTERNS.some((re) => re.test(value))
}

const MASK = '***REDACTED***'

export function maskValue(value: string): string {
  return MASK
}

/** 脱敏单个请求头 */
export function redactHeader(name: string, value: string, extraSecrets: Set<string>): string {
  if (isSensitiveHeaderName(name)) return MASK
  if (looksLikeSecret(value)) return MASK
  if (extraSecrets.has(value)) return MASK
  return value
}

/** 脱敏 URL：隐藏敏感查询参数的值 */
export function redactUrl(rawUrl: string, extraSecrets: Set<string>): string {
  try {
    const u = new URL(rawUrl)
    let changed = false
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        u.searchParams.set(key, MASK)
        changed = true
      } else {
        const v = u.searchParams.get(key) ?? ''
        if (extraSecrets.has(v)) {
          u.searchParams.set(key, MASK)
          changed = true
        }
      }
    }
    return changed ? u.toString() : rawUrl
  } catch {
    // 无法解析的 URL 也扫描一遍已知密钥
    let out = rawUrl
    for (const s of extraSecrets) {
      if (s) out = out.split(s).join(MASK)
    }
    return out
  }
}

/**
 * 从文本中抹除已知密钥字符串与常见密钥形态。
 * knownSecrets：当前配置中已知的密钥值（API Key + 自定义敏感头值）。
 */
export function redactText(text: string, knownSecrets: Iterable<string>): string {
  let out = text
  for (const s of knownSecrets) {
    if (s && s.length >= 6) out = out.split(s).join(MASK)
  }
  // 常见密钥形态（长 sk- 串等）直接抹除
  out = out.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, MASK)
  out = out.replace(/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, MASK)
  return out
}

export interface RedactedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

/** 脱敏一个已捕获的请求（用于存储与导出） */
export function redactCapturedRequest(
  req: { url: string; method: string; headers: Record<string, string>; body?: unknown },
  knownSecrets: Iterable<string>
): RedactedRequest {
  const secrets = new Set(knownSecrets)
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k] = redactHeader(k, v, secrets)
  }
  const url = redactUrl(req.url, secrets)
  let body = req.body
  if (typeof body === 'string') {
    body = redactText(body, secrets)
  } else if (body != null) {
    try {
      body = JSON.parse(redactText(JSON.stringify(body), secrets))
    } catch {
      /* 保持原样 */
    }
  }
  return { url, method: req.method, headers, body }
}
