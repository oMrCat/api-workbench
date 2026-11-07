// 通用小组件
import { useState } from 'react'

export function Collapse({ title, children, defaultOpen = false }: { title: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button className="collapse-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {title}
      </button>
      {open && <div style={{ marginTop: 6 }}>{children}</div>}
    </div>
  )
}

/** 复制按钮：复制失败时给出行内提示 */
export function CopyButton({ text, label = '复制' }: { text: string | undefined; label?: string }) {
  const [done, setDone] = useState(false)
  const [err, setErr] = useState(false)
  if (!text) return null
  return (
    <button
      className="secondary small"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true)
            setErr(false)
          })
          .catch(() => {
            setErr(true)
          })
          .finally(() => setTimeout(() => { setDone(false); setErr(false) }, 1500))
      }}
    >
      {err ? '复制失败' : done ? '已复制' : label}
    </button>
  )
}

export function ErrorCopy({ text }: { text: string | undefined }) {
  if (!text) return null
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <pre className="code grow" style={{ margin: 0 }}>{text}</pre>
      <CopyButton text={text} label="复制错误" />
    </div>
  )
}

export function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>
}
