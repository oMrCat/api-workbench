# TASKS — 任务看板

状态：`[x]` 完成 · `[~]` 进行中 · `[ ]` 未开始

## 阶段 1：环境与最小骨架 ✅

- [x] 环境盘点（macOS 27.2 / M1 arm64 / Node 22.23.4 / git 2.54 / 空目录）
- [x] Node 22 LTS 安装（Homebrew，PATH 已配置）
- [x] 依赖选型与版本锁定（Electron 45.2.3 / electron-vite 6 / vite 7.3.7 / TS 5.9.3 / React 19 / zustand 5 / zod 4 / vitest 5）
- [x] 工程骨架（tsconfig ×3、electron.vite.config、electron-builder.yml）
- [x] Electron 二进制下载（npm install 时失败，已手动重跑 install.js 修复）

## 阶段 2：P0 闭环 ✅

- [x] 共享类型 + IPC 契约（zod 校验）
- [x] URL 拼接（/v1 去重）+ 明文 HTTP 风险提示
- [x] SSE 增量解析器（跨块/UTF-8/\r\n/防御上限）
- [x] HTTP 客户端（计时/超时/取消/错误分类 DNS-connect-TLS/流空闲超时/整体截止）
- [x] 协议适配器 openai-chat（参数最小化）
- [x] TestRunner 请求闭环编排（捕获→脱敏→诊断→记录）
- [x] ConfigStore（原子写入）/ SecretStore（safeStorage + 明确降级）
- [x] 脱敏模块（头/URL/文本/请求对象/密钥形态识别）
- [x] 诊断规则引擎（事实/原因/建议/不确定性，502 不归因客户端）
- [x] 报告导出（Markdown/JSON/脱敏 curl）
- [x] 模拟服务（故障注入 ×13 场景 + 3 种目录异常）
- [x] Preload 最小 API + 主进程 IPC 注册
- [x] Renderer 六页面（概览/服务商/模型/测试/历史/设置）

## 阶段 3：测试与修复 ✅

- [x] 单元测试 6 组（url-join 10 / sse 14 / redact 13 / diagnosis 17 / store 14 / export 6）
- [x] 集成测试 26 项（完整闭环 × 模拟服务异常矩阵）——合计 103 项全绿
- [x] 修复 8+ 个测试/冒烟暴露的真实缺陷（取消失效/超时盲区/错误分类/证据保留/preload sandbox 等）
- [x] 类型检查双侧通过
- [x] 桌面冒烟测试：dev 模式 9/9 通过（退出码 0）
- [x] macOS arm64 打包验证：DMG 产出 + 打包后 .app 冒烟 9/9 通过（退出码 0）

## 阶段 4：交付 ✅

- [x] GitHub Actions（Windows x64 + macOS arm64 + 测试矩阵；推送远程后生效）
- [x] 文档（README/TASKS/HANDOFF/architecture/testing/known-issues）
- [x] 无密钥示例（模拟服务即示例；仓库不含任何真实密钥）
- [x] git 提交整理（按阶段 4 次提交）

## P1（时间富余时）

- [x] anthropic-messages 适配器(119/119 测试)
- [ ] openai-responses 适配器(P1 下一个)
- [x] 工具调用测试(130/130 测试 + 22/22 UI 场景)
- [x] 多服务商结果对比(136/136 测试 + 23/23 UI)
- [ ] 性能测试（用户主动、并发 1 默认、可停止）
- [ ] verifiedCapabilities 由测试记录回写
