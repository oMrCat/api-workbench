// 报告导出：Markdown / JSON / 脱敏 curl 示例。
// 原则：默认不包含提示词与响应正文；密钥绝不出现。
// 纯模块，不依赖 electron。

import type { TestRunRecord } from '@shared/types'
import { PROTOCOL_LABELS } from '@shared/types'

export interface ExportInput {
  records: TestRunRecord[]
  includeBodies: boolean
  generatedAt: number
  appVersion: string
}

export function buildJsonReport(input: ExportInput): string {
  const report = {
    reportVersion: 1,
    tool: 'API Workbench',
    toolVersion: input.appVersion,
    generatedAt: new Date(input.generatedAt).toISOString(),
    includeBodies: input.includeBodies,
    notice: [
      '本报告默认已脱敏：Authorization / API Key / Cookie / 自定义敏感头 / URL 敏感查询参数 / 已知密钥字符串均已替换为 ***REDACTED***。',
      '提示词与响应正文可能包含私人信息，默认不包含在报告中。'
    ],
    records: input.records.map((r) => ({
      id: r.id,
      startedAt: new Date(r.startedAt).toISOString(),
      finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : undefined,
      provider: { id: r.providerId, name: r.providerName },
      model: r.model,
      protocol: r.protocol,
      protocolLabel: PROTOCOL_LABELS[r.protocol],
      stream: r.stream,
      ok: r.ok,
      cancelled: r.cancelled,
      timedOut: r.timedOut,
      phase: r.phase,
      httpStatus: r.httpStatus,
      timing: r.timing,
      usage: r.usage ?? '上游未返回',
      text: r.text !== undefined && input.includeBodies ? r.text : r.text !== undefined ? `（${r.text.length} 字符，正文未包含——如需包含请在导出时勾选）` : undefined,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      request: r.request,
      rawResponsePreview: input.includeBodies ? r.rawResponsePreview : undefined,
      errorBodyPreview: input.includeBodies ? r.errorBodyPreview : undefined,
      streamEvents: r.streamEvents && input.includeBodies ? r.streamEvents : undefined,
      streamEventsTruncated: r.streamEventsTruncated,
      diagnosis: r.diagnosis
    }))
  }
  return JSON.stringify(report, null, 2)
}

function fmtMs(v?: number): string {
  return v == null ? '—' : `${v} ms`
}

export function buildMarkdownReport(input: ExportInput): string {
  const lines: string[] = []
  lines.push('# API Workbench 诊断报告')
  lines.push('')
  lines.push(`- 生成时间：${new Date(input.generatedAt).toLocaleString('zh-CN')}`)
  lines.push(`- 工具版本：${input.appVersion}`)
  lines.push(`- 记录数：${input.records.length}`)
  lines.push(`- 包含正文：${input.includeBodies ? '是（用户主动勾选）' : '否（默认脱敏）'}`)
  lines.push('')
  lines.push('> 本报告已自动脱敏：Authorization、API Key、Cookie、自定义敏感请求头、URL 中的敏感查询参数及配置中已知的密钥字符串均替换为 `***REDACTED***`。提示词与响应正文可能包含私人信息，默认不包含。')
  lines.push('')

  for (const r of input.records) {
    lines.push(`## ${r.providerName} · ${r.model}`)
    lines.push('')
    lines.push('| 项目 | 值 |')
    lines.push('| --- | --- |')
    lines.push(`| 记录 ID | \`${r.id}\` |`)
    lines.push(`| 时间 | ${new Date(r.startedAt).toLocaleString('zh-CN')} |`)
    lines.push(`| 服务商 | ${r.providerName} (${r.providerId}) |`)
    lines.push(`| 模型 | ${r.model} |`)
    lines.push(`| 协议 | ${PROTOCOL_LABELS[r.protocol]} |`)
    lines.push(`| 流式 | ${r.stream ? '是' : '否'} |`)
    lines.push(`| 结果 | ${r.ok ? '✅ 成功' : r.cancelled ? '⛔ 已取消' : '❌ 失败'} |`)
    lines.push(`| 阶段 | ${r.phase} |`)
    lines.push(`| HTTP 状态 | ${r.httpStatus ?? '—'} |`)
    lines.push(`| 总耗时 | ${fmtMs(r.timing.totalMs)} |`)
    lines.push(`| 响应头到达（TTFB） | ${fmtMs(r.timing.ttfbMs)} |`)
    lines.push(`| 首个内容片段 | ${fmtMs(r.timing.firstContentMs)} |`)
    lines.push(`| usage | ${r.usage == null ? '上游未返回' : '`' + JSON.stringify(r.usage) + '`'} |`)
    if (r.errorCode) lines.push(`| 错误码 | ${r.errorCode} |`)
    if (r.errorMessage) lines.push(`| 错误信息 | ${r.errorMessage} |`)
    lines.push('')

    lines.push('### 请求（已脱敏）')
    lines.push('')
    lines.push('```')
    lines.push(`${r.request.method} ${r.request.url}`)
    for (const [k, v] of Object.entries(r.request.headers)) lines.push(`${k}: ${v}`)
    lines.push('```')
    lines.push('')

    if (r.diagnosis) {
      lines.push('### 诊断')
      lines.push('')
      lines.push('**已观察到的事实**')
      lines.push('')
      for (const f of r.diagnosis.facts) lines.push(`- ${f}`)
      lines.push('')
      lines.push('**可能原因**')
      lines.push('')
      for (const c of r.diagnosis.possibleCauses) {
        lines.push(`- [${c.likelihood}] ${c.cause}${c.note ? `（${c.note}）` : ''}`)
      }
      lines.push('')
      lines.push('**建议排查步骤**')
      lines.push('')
      for (const s of r.diagnosis.suggestions) lines.push(`- ${s}`)
      lines.push('')
      lines.push(`> ${r.diagnosis.uncertainty}`)
      lines.push('')
    }

    if (input.includeBodies) {
      if (r.rawResponsePreview) {
        lines.push('### 原始响应片段（已脱敏）')
        lines.push('')
        lines.push('```')
        lines.push(truncate(r.rawResponsePreview, 8000))
        lines.push('```')
        lines.push('')
      }
      if (r.errorBodyPreview) {
        lines.push('### 错误响应体片段（已脱敏）')
        lines.push('')
        lines.push('```')
        lines.push(truncate(r.errorBodyPreview, 4000))
        lines.push('```')
        lines.push('')
      }
      if (r.streamEvents?.length) {
        lines.push(`### 流事件（前 ${Math.min(r.streamEvents.length, 50)} 条${r.streamEventsTruncated ? '，已截断' : ''}）`)
        lines.push('')
        lines.push('```')
        for (const e of r.streamEvents.slice(0, 50)) {
          lines.push(`#${e.seq} +${e.tMs}ms ${truncate(e.data, 300)}`)
        }
        lines.push('```')
        lines.push('')
      }
    } else if (r.text !== undefined) {
      lines.push(`> 响应正文共 ${r.text.length} 字符，未包含在报告中（导出时可主动选择包含）。`)
      lines.push('')
    }
  }

  return lines.join('\n')
}

/** 生成脱敏 curl 复现示例（不含真实密钥，占位符提示用户替换） */
export function buildCurlSample(record: TestRunRecord): string {
  const placeholder = '$API_WORKBENCH_KEY  # ← 替换为你的真实密钥后才能运行'
  const hasAuth = Object.keys(record.request.headers).some((k) => k.toLowerCase() === 'authorization')
  const headerLines = Object.entries(record.request.headers)
    .filter(([k]) => k.toLowerCase() !== 'authorization')
    .map(([k, v]) => `  -H '${k}: ${v}' \\`)
    .join('\n')
  const authLine = hasAuth ? `  -H 'Authorization: Bearer ${placeholder}' \\\n` : ''
  const body =
    record.request.body != null
      ? `  -d '${typeof record.request.body === 'string' ? record.request.body : JSON.stringify(record.request.body)}' \\`
      : ''
  const lines = [
    '# 脱敏 curl 复现示例（生成的命令不含真实密钥）',
    '# ⚠️ 运行前必须把 $API_WORKBENCH_KEY 占位符替换为你的真实密钥；',
    '# ⚠️ 在共享终端/聊天窗口运行时注意 shell 历史记录也会保存密钥。',
    '',
    'curl -i \\',
    `  '${record.request.url}' \\`,
    `  -X ${record.request.method} \\`,
    authLine + headerLines,
    body
  ]
  return lines.filter((l) => l.trim().length > 0 || l === '').join('\n').replace(/\\\n[^\n]*$/, (m) => m)
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `…（截断，共 ${s.length} 字符）` : s
}
