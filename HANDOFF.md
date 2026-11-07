# HANDOFF — 交接状态

> 新会话先读本文件 + TASKS.md + docs/known-issues.md，再按需读代码。不要无差别读整个仓库。

## 当前阶段

**P0 全部完成（阶段 1-4 ✅），已推送远程仓库。**

- 远程：https://github.com/oMrCat/api-workbench（**private**，2026-11-07 推送，用户完成 gh 认证后授权推送）
- CI（Build & Test）：推送自动触发；Windows x64 / macOS arm64 打包与双平台测试矩阵的**实际运行结果**见 `docs/testing.md` 与 CI 页面
- git remote origin 已配置；后续提交直接 `git push`

## 实测验收状态（2026-11-07，本机）

| 验收项 | 状态 |
| --- | --- |
| 安装依赖并启动桌面应用 | ✅ dev 冒烟 9/9 |
| 添加模拟服务商 → 获取目录 → 非流式 → 流式 → 取消 → 错误诊断 | ✅ 冒烟 + 103 项测试 |
| 导出无密钥报告 | ✅ 单元测试断言脱敏 |
| 退出重开配置符合设计 | ✅ 跨实例存储测试 |
| 自动化测试 | ✅ 103/103 |
| 本机打包 | ✅ DMG 产出 + 打包后 .app 冒烟 9/9 |
| Windows 构建工作流 | ✅ 配置就绪；**实际 CI 运行未验证**（未推送远程） |

## 下一条具体任务

1. （需用户操作）配置 git identity 并推送远程仓库 → CI 跑 Windows/macOS 打包
2. （时间富余）P1 按序：anthropic-messages 适配器 → openai-responses → 工具调用测试 → 结果对比
3. 真实服务商验证需用户自带 Key 操作（密钥不进仓库/对话）

## 常用命令

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"   # 本机 node 路径
npm run dev          # 开发启动（概览页可一键启动内置模拟服务）
npm run mock         # 独立模拟服务 :8045
npm test             # 103 项测试
npm run typecheck    # tsc 双配置
npm run smoke        # 构建 + 冒烟（无头，退出码 0 = 通过）
npm run dist:mac     # arm64 dmg（受限网络需先 export ELECTRON_MIRROR，见 known-issues #0）
```

## 关键上下文

- **镜像**：本机 GitHub releases 直连超时。Electron 二进制 / electron-builder 资源需 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`（已实测可用）
- 冒烟模式：`src/main/index.ts` `runSmokeTest()`，`--smoke` 开关，经 `executeJavaScript` 驱动 window.api
- 会话中修过的关键缺陷（勿回退）：
  1. **preload sandbox 只能 require('electron')** → IPC 通道名必须在 `ipc-channels.ts`（零依赖），zod Schema 在 `ipc-contract.ts`（主进程用）
  2. 取消在流读取中表现为"流正常结束"→ runner 在流结束后检查 abort 信号
  3. 非流式 body 读取无整体超时 → `withDeadline` 包裹
  4. undici 错误形态（AggregateError / UND_ERR_SOCKET / terminated）→ `classifyFetchError` 已适配
  5. 中途断开归类 stream 而非 connect；失败/取消保留部分内容作证据
- git identity 未配置：提交用 `-c user.name=... -c user.email=...`

## 尚未解决的问题

见 `docs/known-issues.md`（13 项）。

## 测试状态摘要

- `npm test`：103/103 通过 · `npm run typecheck`：双配置通过 · 冒烟：dev 9/9 + 打包产物 9/9（均退出码 0）
- 真实服务商接口：**未验证**（无真实 Key，按约定不提交密钥）
- Windows CI：**未运行**（仓库未推送远程）
