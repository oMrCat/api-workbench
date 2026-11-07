// URL 拼接：解决 base 与 path 的 /v1 重复等常见拼接问题。
// 纯函数，不依赖 electron，可独立测试。

export class UrlJoinError extends Error {}

/** 校验 base URL：必须 http/https */
export function assertHttpUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new UrlJoinError(`无法解析地址：${raw}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new UrlJoinError(`仅支持 http/https 协议，当前为 ${u.protocol}`)
  }
  return u
}

/**
 * 拼接 base 与 path，规则：
 * - 去掉 base 末尾与 path 开头的重复斜杠；
 * - 若 path 的首段与 base 末段相同（如都是 v1），只保留一份，避免 /v1/v1；
 * - 若 base 带查询串，抛错（配置不应依赖查询参数，避免密钥藏在 URL 里被误导出）。
 */
export function joinUrl(base: string, path: string): string {
  const u = assertHttpUrl(base)
  if (u.search) {
    throw new UrlJoinError('Base URL 不应包含查询参数')
  }
  const baseSegs = u.pathname.split('/').filter((s) => s.length > 0)
  const pathSegs = path.split('/').filter((s) => s.length > 0)
  if (pathSegs.length > 0 && baseSegs.length > 0 && pathSegs[0] === baseSegs[baseSegs.length - 1]) {
    pathSegs.shift()
  }
  u.pathname = [...baseSegs, ...pathSegs].join('/')
  return u.toString()
}

/** 是否为本地回环地址（允许明文 HTTP） */
export function isLoopbackHost(raw: string): boolean {
  try {
    const u = new URL(raw)
    const h = u.hostname.toLowerCase()
    return (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '::1' ||
      h === '[::1]' ||
      h.endsWith('.localhost') ||
      h.startsWith('127.')
    )
  } catch {
    return false
  }
}

/** 明文 HTTP 且非本地 → 返回风险提示；否则返回 null */
export function plainHttpWarning(raw: string): string | null {
  try {
    const u = new URL(raw)
    if (u.protocol === 'http:' && !isLoopbackHost(raw)) {
      return `该地址使用明文 HTTP 且非本机服务，密钥与内容可能被网络中间人窃取。`
    }
  } catch {
    /* 校验在别处完成 */
  }
  return null
}
