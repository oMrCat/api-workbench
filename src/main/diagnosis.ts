// 诊断规则引擎。
// 输入：请求记录中的可观察证据（阶段、状态码、错误码、响应片段、协议层错误）。
// 输出：事实 / 可能原因（带可能性）/ 建议步骤 / 不确定性说明。
// 原则：单一状态码不能断定唯一根因；502 不全是客户端问题，400 不全是模型不支持。
// 纯模块，不依赖 electron。

import type { Diagnosis, FailurePhase, TestRunRecord } from '@shared/types'

interface RuleInput {
  phase: FailurePhase | 'success'
  httpStatus?: number
  errorCode?: string
  errorMessage?: string
  errorBodyPreview?: string
  stream?: boolean
  streamInterrupted?: boolean
  timedOut?: boolean
  cancelled?: boolean
  timing: { totalMs?: number; ttfbMs?: number; firstContentMs?: number }
}

function statusCodeFamily(status?: number): 'auth' | 'notfound' | 'rate' | 'server' | 'client' | 'ok' | undefined {
  if (status == null) return undefined
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'notfound'
  if (status === 429) return 'rate'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'ok'
}

const COMMON_UNCERTAINTY =
  '以上判断基于可观察证据（阶段、状态码、错误码、响应片段），单一状态码不足以确定唯一根因；同一状态码在不同服务商/网关下含义可能不同，请结合响应体原始证据进一步确认。'

export function diagnose(input: RuleInput): Diagnosis {
  const facts: string[] = []
  const causes: { cause: string; likelihood: 'high' | 'medium' | 'low'; note?: string }[] = []
  const suggestions: string[] = []

  // ---- 事实收集 ----
  facts.push(`请求阶段：${phaseLabel(input.phase)}`)
  if (input.httpStatus != null) facts.push(`HTTP 状态码：${input.httpStatus}`)
  if (input.timing.totalMs != null) facts.push(`总耗时 ${input.timing.totalMs} ms`)
  if (input.timing.ttfbMs != null) facts.push(`响应头到达 ${input.timing.ttfbMs} ms`)
  if (input.timing.firstContentMs != null) facts.push(`首个内容片段 ${input.timing.firstContentMs} ms`)
  if (input.errorCode) facts.push(`错误码：${input.errorCode}`)
  if (input.errorMessage) facts.push(`错误信息：${input.errorMessage}`)
  if (input.cancelled) facts.push('请求被用户主动取消')
  if (input.timedOut) facts.push(`请求超时（超过配置的超时时间）`)
  if (input.stream) facts.push('本次为流式请求')
  if (input.streamInterrupted) facts.push('流在结束标记前中断')
  if (input.errorBodyPreview) facts.push('已捕获错误响应体片段（见详情）')

  // ---- 成功 ----
  if (input.phase === 'success') {
    facts.push('请求成功完成')
    if (input.stream && input.timing.firstContentMs == null) {
      causes.push({ cause: '流式完成但未观察到内容片段（如模型仅返回空内容）', likelihood: 'medium' })
    }
    suggestions.push('如需验证工具调用等更高阶能力，请在对应测试页进一步测试')
    return {
      facts,
      possibleCauses: causes,
      suggestions,
      uncertainty: '成功记录无需根因分析；以上为观察事实。'
    }
  }

  const family = statusCodeFamily(input.httpStatus)

  // ---- 按阶段诊断 ----
  switch (input.phase) {
    case 'dns':
      causes.push({ cause: '域名解析失败：Base URL 域名拼写错误、DNS 服务器不可用或该域名未注册', likelihood: 'high' })
      suggestions.push('在终端用 nslookup 或 ping 验证域名能否解析')
      suggestions.push('检查服务商 Base URL 是否拼写正确（多一个字母、少了域名后缀都会导致此错误）')
      suggestions.push('如使用了代理/VPN，确认其 DNS 配置正常')
      break
    case 'connect':
      causes.push({ cause: 'TCP 连接失败：目标端口未开放、服务未启动或被防火墙拦截', likelihood: 'high' })
      causes.push({ cause: '本地网络不可达（断网、代理未启动）', likelihood: 'medium' })
      suggestions.push('确认 Base URL 的端口与服务已启动（本地模拟服务需先启动）')
      suggestions.push('若使用 http://localhost:端口，先在浏览器访问该地址确认服务可达')
      suggestions.push('检查系统代理设置：Electron 主进程默认读取系统代理，代理异常会中断连接')
      break
    case 'tls':
      causes.push({ cause: 'TLS 握手失败：证书过期/自签名/域名不匹配，或中间设备拦截 HTTPS', likelihood: 'high' })
      suggestions.push('在浏览器打开同一 Base URL，确认浏览器能正常建立 HTTPS 连接')
      suggestions.push('企业网络可能安装了 TLS 拦截代理，证书链会被替换——此类问题需联系网络管理员')
      suggestions.push('本应用不提供关闭证书校验的选项；自签名证书请通过系统信任链处理')
      break
    case 'timeout':
      causes.push({ cause: '上游处理时间超过配置的超时上限（长输出/慢模型常见）', likelihood: 'high' })
      causes.push({ cause: '网络链路拥塞或上游无响应（连接建立后挂起）', likelihood: 'medium' })
      suggestions.push('在服务商配置中调大超时时间后重试')
      suggestions.push('降低 max_tokens 输出上限，减少长回复耗时')
      break
    case 'cancelled':
      facts.push('用户取消不算失败')
      suggestions.push('如需继续，重新发起请求即可')
      break
  }

  // ---- 按状态码族诊断（与阶段可叠加） ----
  if (family === 'auth') {
    const authNote =
      input.httpStatus === 401
        ? '401 通常表示凭据缺失/无效/格式错误'
        : '403 通常表示凭据有效但无权访问该资源（区域限制、项目未开通、模型未授权等）'
    causes.push({ cause: `认证/授权失败。${authNote}`, likelihood: 'high' })
    causes.push({ cause: 'Authorization 头被网关剥离或自定义头覆盖了协议头', likelihood: 'low' })
    suggestions.push('确认 API Key 已在应用内保存，且与服务商控制台中的 Key 一致（注意区分不同项目的 Key）')
    suggestions.push('检查 Key 是否过期、是否被撤销、账户是否有余额/额度')
    suggestions.push('检查自定义请求头是否意外覆盖了 Authorization（如重复配置 x-api-key）')
    suggestions.push('部分服务商要求特定头（如 Anthropic 的 x-api-key / anthropic-version），确认协议类型选择正确')
  } else if (family === 'notfound') {
    causes.push({ cause: '路径不存在：Base URL 与接口路径拼接后指向了不存在的端点', likelihood: 'high' })
    causes.push({ cause: '模型不存在：部分服务商对未知模型返回 404', likelihood: 'medium' })
    suggestions.push('查看请求详情中的最终请求 URL，确认没有出现 /v1/v1 之类的重复路径')
    suggestions.push('对照服务商文档核对接口路径（如有的服务商不含 /v1 前缀，请在配置中调整路径覆盖）')
    suggestions.push('确认模型 ID 拼写正确（可先同步模型目录获取准确 ID）')
  } else if (family === 'rate') {
    causes.push({ cause: '429 触发限流：请求频率或并发超过配额', likelihood: 'high' })
    causes.push({ cause: '账户配额耗尽（部分服务商对欠费/超额也返回 429）', likelihood: 'medium' })
    suggestions.push('降低请求频率后重试；尊重 Retry-After 响应头（若有）')
    suggestions.push('在服务商控制台确认配额与计费状态')
  } else if (family === 'server') {
    const specific: string[] = []
    if (input.httpStatus === 502) specific.push('502 常见于上游网关/代理后端暂时不可用，通常是服务端问题而非客户端问题')
    if (input.httpStatus === 503) specific.push('503 表示服务暂时过载或维护')
    if (input.httpStatus === 504) specific.push('504 表示上游网关超时，处理时间过长')
    causes.push({
      cause: `上游服务端错误（5xx）。${specific.join('；') || '服务端内部错误，原因在上游'}`,
      likelihood: 'high',
      note: '5xx 属于服务端侧错误，客户端重试通常有效但应等待一段时间'
    })
    suggestions.push('稍等片刻（1-5 分钟）后重试；连续失败可在服务商状态页确认是否故障')
    suggestions.push('查看错误响应体片段：部分网关会在 5xx 响应中说明后端组件的失败原因')
  } else if (family === 'client') {
    causes.push({ cause: '请求被服务端拒绝（4xx）：可能是参数不支持、模型名错误、请求体格式不符', likelihood: 'high' })
    causes.push({ cause: '若错误体提到某个参数（如 max_tokens、temperature），说明该服务商不支持此参数或取值越界', likelihood: 'medium', note: '不同服务商支持的参数差异很大，这是兼容性问题的高发区' })
    causes.push({ cause: '若错误体提到 context/token length，属于上下文长度超限', likelihood: 'medium' })
    suggestions.push('阅读错误响应体片段：4xx 的具体原因几乎总在响应体中说明')
    suggestions.push('如提示参数不支持，取消勾选该参数后重试（本应用只发送你明确设置的参数）')
    suggestions.push('如提示模型不存在/无权限，先到模型页同步目录，确认模型 ID 准确')
  }

  // ---- 响应体证据细分 ----
  const body = (input.errorBodyPreview || '').toLowerCase()
  if (body) {
    if (
      body.includes('invalid_api_key') ||
      body.includes('invalid api key') ||
      body.includes('incorrect api key') ||
      body.includes('authentication_error') ||
      body.includes('invalid x-api-key')
    ) {
      causes.length = 0
      causes.push({ cause: 'API Key 无效(响应体明确指出认证错误)', likelihood: 'high' })
      suggestions.push('重新在服务商页保存正确的 Key;注意不要包含多余空格或换行')
      suggestions.push('确认协议类型与 Key 匹配:OpenAI 走 Authorization Bearer,Anthropic 走 x-api-key 头')
    }
    if (body.includes('quota') || body.includes('billing') || body.includes('insufficient')) {
      causes.push({ cause: '配额/计费问题（响应体提到 quota/billing）', likelihood: 'high' })
      suggestions.push('在服务商控制台检查余额与配额')
    }
    if (body.includes('context length') || body.includes('maximum context') || body.includes('too long')) {
      causes.push({ cause: '上下文长度超限（响应体提到 context length）', likelihood: 'high' })
      suggestions.push('缩短提示词或降低 max_tokens')
    }
    if (body.includes('<html') || body.includes('<!doctype')) {
      causes.push({ cause: '响应是 HTML 而非 JSON：请求很可能打到了网页端点而非 API 端点', likelihood: 'high' })
      suggestions.push('检查最终请求 URL 是否正确（通常应为 …/chat/completions 之类的 API 路径）')
    }
  }

  // ---- 流式特有 ----
  if (input.stream && input.phase === 'stream') {
    if (input.streamInterrupted) {
      causes.push({ cause: '流中途断开：网络抖动、代理超时或上游提前关闭连接', likelihood: 'high' })
      suggestions.push('检查代理/VPN 的空闲超时设置；长回复在弱网下更易中断')
      suggestions.push('重试一次；若稳定复现，改用非流式对照测试以区分"生成问题"与"流传输问题"')
    } else if (input.errorMessage) {
      causes.push({ cause: '上游在流中返回了错误事件（见错误信息）', likelihood: 'high' })
    }
  }

  if (input.phase === 'parse') {
    causes.push({ cause: '响应无法按协议解析：端点可能不是所配置的协议类型', likelihood: 'high' })
    suggestions.push('确认服务商的协议类型选择正确（如把 Responses 接口配成了 Chat Completions）')
    suggestions.push('查看原始响应预览，人工判断实际返回内容')
  }

  if (causes.length === 0) {
    causes.push({ cause: '未知错误：现有证据不足以归类', likelihood: 'low' })
    suggestions.push('复制错误详情与响应片段，对照服务商文档排查')
    suggestions.push('尝试换用非流式请求对照，缩小问题范围')
  }

  // 去重（按 cause 文本）
  const seen = new Set<string>()
  const possibleCauses = causes.filter((c) => (seen.has(c.cause) ? false : (seen.add(c.cause), true)))

  return { facts, possibleCauses, suggestions, uncertainty: COMMON_UNCERTAINTY }
}

function phaseLabel(phase: FailurePhase | 'success'): string {
  const map: Record<string, string> = {
    dns: 'DNS 解析',
    connect: 'TCP 连接',
    tls: 'TLS 握手',
    response: '等待响应',
    parse: '解析响应',
    stream: '读取流',
    timeout: '超时',
    cancelled: '用户取消',
    success: '成功',
    unknown: '未知阶段'
  }
  return map[phase] ?? phase
}

/** 从完整记录构建诊断（集成层使用） */
export function diagnoseRecord(record: TestRunRecord): Diagnosis {
  return diagnose({
    phase: record.phase,
    httpStatus: record.httpStatus,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    errorBodyPreview: record.errorBodyPreview,
    stream: record.stream,
    streamInterrupted:
      record.stream &&
      record.phase === 'stream' &&
      !record.streamEvents?.some((e) => e.data.includes('[DONE]')),
    timedOut: record.timedOut,
    cancelled: record.cancelled,
    timing: record.timing
  })
}
