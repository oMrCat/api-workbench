import { useEffect, useState } from 'react'
import { useApp } from '../store'
import { Empty } from '../components/common'

export default function OverviewPage() {
  const appInfo = useApp((s) => s.appInfo)
  const providers = useApp((s) => s.providers)
  const history = useApp((s) => s.sessionHistory)
  const setPage = useApp((s) => s.setPage)
  const setToast = useApp((s) => s.setToast)
  const [mock, setMock] = useState<{ running: boolean; port?: number; error?: string }>({ running: false })

  useEffect(() => {
    void window.api.mockStatus().then(setMock)
  }, [])

  const startMock = async () => {
    setToast({ kind: 'info', text: '正在启动模拟服务…' })
    const r = await window.api.mockStart()
    if ('error' in r && r.error) {
      setMock({ running: false, error: r.error })
      setToast({ kind: 'err', text: `模拟服务启动失败：${r.error}` })
    } else {
      setMock({ running: true, port: r.port })
      setToast({ kind: 'ok', text: `模拟服务已启动（127.0.0.1:${r.port}）` })
    }
  }

  const stopMock = async () => {
    await window.api.mockStop()
    setMock({ running: false })
    setToast({ kind: 'info', text: '模拟服务已停止' })
  }

  return (
    <div>
      <h1>概览</h1>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>快速开始</h2>
        <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 2 }}>
          <li>
            启动<b>本地模拟服务</b>（无需任何真实 API Key）：
            {mock.running ? (
              <span style={{ marginLeft: 8 }}>
                <span className="badge ok">运行中 127.0.0.1:{mock.port}</span>
                <button className="secondary small" style={{ marginLeft: 6 }} onClick={() => void stopMock()}>
                  停止
                </button>
              </span>
            ) : (
              <button className="primary small" style={{ marginLeft: 8 }} onClick={() => void startMock()}>
                启动模拟服务
              </button>
            )}
          </li>
          <li>
            在「服务商」页添加配置：Base URL 填 <code>http://127.0.0.1:{mock.port || '端口'}</code>，协议选 OpenAI 兼容 Chat
            Completions，密钥填任意 <code>sk-mock</code> 开头的字符串。
          </li>
          <li>在「模型」页同步模型目录，或在「请求测试」页直接手输模型 ID。</li>
          <li>发起非流式 / 流式测试，查看诊断与耗时；失败记录会给出排查建议。</li>
          <li>在「诊断历史」页导出脱敏报告（Markdown / JSON）。</li>
        </ol>
        {mock.error && <div className="notice err">模拟服务启动失败：{mock.error}</div>}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>环境信息</h2>
        {appInfo ? (
          <div className="kv">
            <span className="k">应用版本</span>
            <span className="v">{appInfo.appVersion}</span>
            <span className="k">平台 / 架构</span>
            <span className="v">
              {appInfo.platform} / {appInfo.arch}
            </span>
            <span className="k">Electron</span>
            <span className="v">{appInfo.electronVersion}</span>
            <span className="k">Node / Chromium</span>
            <span className="v">
              {appInfo.nodeVersion} / {appInfo.chromeVersion}
            </span>
            <span className="k">配置目录</span>
            <span className="v muted">{appInfo.userDataPath}</span>
            <span className="k">密钥存储</span>
            <span className="v">
              {appInfo.secretStore.mode === 'system' ? (
                <span className="badge ok">系统安全存储（Keychain / DPAPI）</span>
              ) : (
                <span className="badge warn">仅会话内存</span>
              )}
              {appInfo.secretStore.reason && <div className="muted" style={{ marginTop: 4 }}>{appInfo.secretStore.reason}</div>}
            </span>
          </div>
        ) : (
          <div>
            <span className="spin" /> 读取中…
          </div>
        )}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>当前状态</h2>
        <div className="row">
          <span className="badge info">服务商 {providers.length}</span>
          <span className="badge info">本次会话记录 {history.length}</span>
          <span className="badge dim">协议支持：OpenAI Chat（P0）｜Responses / Anthropic Messages（P1 计划）</span>
        </div>
        {providers.length === 0 && (
          <div className="notice info" style={{ marginTop: 10 }}>
            还没有服务商配置。<button className="secondary small" onClick={() => setPage('providers')}>去添加 →</button>
          </div>
        )}
        {providers.length === 0 && history.length === 0 && <Empty text="完成上面的快速开始后，这里会显示统计信息。" />}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>安全说明</h2>
        <div className="muted" style={{ lineHeight: 1.8 }}>
          API Key 保存在系统安全存储（macOS Keychain / Windows DPAPI）；若系统安全存储不可用，Key 仅保存在本次会话内存中，
          退出后丢失，<b>不会</b>静默写入明文文件。日志、历史与导出报告默认脱敏。渲染进程不发起网络请求，全部请求经主进程受控执行。
        </div>
      </div>
    </div>
  )
}
