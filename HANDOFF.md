# HANDOFF — 交接状态

> 新会话先读本文件 + TASKS.md + docs/known-issues.md，再按需读代码。不要无差别读整个仓库。

## 当前阶段

阶段 3（测试与修复）✅ → 阶段 4（交付）进行中。

- **已完成**：P0 全部功能 + 103 项自动化测试全绿 + 类型检查通过 + 文档
- **进行中**：桌面冒烟测试 + macOS 打包验证（等 Electron 二进制下载）
- **阻塞**：GitHub releases 直连超时 → 已改用 npmmirror（ELECTRON_MIRROR）

## 下一条具体任务

1. 确认 `node_modules/electron/dist/Electron.app` 存在（后台任务 exec_7278a8bc）
2. `npm run build && npx electron . --smoke` → 期望 9 步全过、退出码 0
3. `npm run dist:mac` → 验证 `dist/*.dmg` 产出
4. git 按阶段提交
5. （时间富余）P1：先做 anthropic-messages 适配器（复用现有接口，工作量最小）

## 常用命令

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"   # 本机 node 路径
npm run dev          # 开发启动（需先启动模拟服务或用概览页内置启动）
npm run mock         # 模拟服务 :8045
npm test             # 103 项测试
npm run typecheck    # tsc 双配置
npm run smoke        # 构建 + 冒烟（无头，退出码 0 = 通过）
npm run dist:mac     # arm64 dmg
npm run dist:win     # Windows NSIS（需 Windows 环境，本机勿跑）
```

## 关键上下文

- Electron 二进制必须走镜像：`ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js`（GitHub 直连在当前网络超时）
- 冒烟模式实现于 `src/main/index.ts` 的 `runSmokeTest()`，经 `--smoke` 开关触发，渲染进程交互全部走 `executeJavaScript`（window.api）
- 测试基础设施：`tests/integration/request-loop.test.ts` 直接驱动 TestRunner + 真实 localhost mock；模拟服务类型声明在 `mock-server/server.d.mts`
- 会话中修过的关键缺陷（勿回退）：
  1. 取消在流读取中表现为"流正常结束"→ runner 在流结束后检查 abort 信号（`test-runner.ts` 流分支）
  2. 非流式 body 读取没有整体超时 → `withDeadline` 包裹 `response.text()`
  3. undici 错误是 AggregateError/UND_ERR_SOCKET → `classifyFetchError` 检查 `cause.errors` 并接受 UND_ERR_SOCKET
  4. 中途断开的阶段应为 stream 而非 connect → `enteredStreaming` 标记
  5. 失败/取消时保留部分文本与事件日志作为诊断证据
- git identity 未配置：提交用 `-c user.name=... -c user.email=...`（或用户自行配置）

## 尚未解决的问题

见 `docs/known-issues.md`（12 项，含 Windows 未真机验证、未签名、受限端口等）。

## 测试状态摘要

- `npm test`：103/103 通过（2026-11-07 实测）
- `npm run typecheck`：node + web 双配置通过
- 桌面冒烟：已实现，待 Electron 二进制就绪后执行
- 真实服务商接口：**未验证**（无真实 Key，按约定不提交密钥）
