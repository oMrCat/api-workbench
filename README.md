<div align="center">

# API Workbench

**本地优先的 AI 接口兼容性与诊断桌面工作台(Windows / macOS)**

**简体中文** | [English](README.en.md)

</div>

---

# API Workbench

本地优先的 AI 接口兼容性与诊断桌面工作台（Windows / macOS）。

帮助用户：配置多个 AI 服务商 → 同步模型目录 → 发送测试请求 → 分析失败原因 → 导出脱敏诊断报告。

**这不是聊天软件**，也不是"万能客户端"。核心闭环：**配置接口 → 同步模型 → 发送测试 → 查看诊断 → 导出报告**。

## 功能（P0 已实现）

- ✅ 服务商配置:多服务商、三种协议(OpenAI Chat / Anthropic Messages / OpenAI Responses)、自定义头、超时、路径覆盖
- ✅ 密钥安全：系统安全存储（macOS Keychain / Windows DPAPI），不可用时仅会话内存并明确告知；永不进入日志/报告/配置文件/localStorage
- ✅ 模型目录：接口同步 + 手动添加、搜索、原始数据查看、能力标注四态（文档声明/用户标记/已验证/尚未验证）
- ✅ 请求测试：非流式 + 流式（真增量解析，跨块 UTF-8 正确）、取消、超时、参数最小化（只发送明确设置的字段）
- ✅ 工具调用测试（P1）：固定无副作用示例工具，白名单外一律拒绝，每步可视化
- ✅ 诊断：事实 / 可能原因（带可能性）/ 建议步骤 / 不确定性声明，保留原始证据
- ✅ 报告导出：Markdown / JSON，默认脱敏（Authorization/Key/Cookie/敏感头/URL 参数/已知密钥串），默认不含提示词正文，包含时二次确认
- ✅ 脱敏 curl 复现示例（占位符，不含真实密钥）
- ✅ 内置模拟服务（一键启动，无 Key 也能测全部流程）
- ✅ 103 项自动化测试（单元 + 集成，离线运行）

**P1 已全部完成**:Anthropic Messages ✓、OpenAI Responses ✓、工具调用测试 ✓、多服务商对比 ✓、性能测试 ✓、配置导出导入 ✓。

## 快速开始（开发）

要求：Node.js ≥ 22。

```bash
npm ci          # 安装锁定依赖
npm run mock    # 终端 A：启动模拟服务（端口 8045）
npm run dev     # 终端 B：启动桌面应用
```

应用内也可以直接在「概览」页一键启动内置模拟服务。

### 验证

```bash
npm run typecheck   # 类型检查
npm test            # 103 项自动化测试
npm run smoke       # 桌面冒烟测试（无头执行，退出码 0 = 通过）
npm run dist:mac    # macOS arm64 dmg 打包
```

### 使用模拟服务

1. 概览页 →「启动模拟服务」
2. 服务商页 → 添加：名称随意，Base URL `http://127.0.0.1:<端口>`，协议 OpenAI 兼容 Chat Completions，密钥填任意 `sk-mock` 开头的字符串（如 `sk-mock-test-key`）
3. 模型页 → 同步模型目录
4. 请求测试页 → 选模型（可试 `mock-500`、`mock-hang`、`mock-break` 等故障模型）→ 发起
5. 诊断历史页 → 导出脱敏报告

## 使用真实服务商

服务商页配置真实 Base URL 与密钥即可。注意：
- 明文 HTTP 非本机地址会收到风险提示；
- 密钥保存进系统安全存储，报告中只出现 `***REDACTED***`；
- 不同服务商对参数支持差异大——本应用只发送你明确勾选的参数，遇到 4xx 请看错误响应体证据。

## 打包产物

- macOS arm64：`npm run dist:mac` → `dist/API Workbench-0.1.0-arm64.dmg`（未签名，本机可用；分发到其他 Mac 需右键 → 打开）
- Windows x64：`npm run dist:win`（需 Windows 环境）或推送到 GitHub 使用 `.github/workflows/windows-build.yml` 构建（未签名）

## 文档

- [架构说明](docs/architecture.md)
- [测试记录](docs/testing.md)（只记录真实执行过的验证）
- [已知问题](docs/known-issues.md)
- [任务看板](TASKS.md) / [交接状态](HANDOFF.md)

## 安全模型

- 渲染进程：sandbox + contextIsolation + CSP（connect-src 'none'），无 Node 能力，无网络能力
- 主进程：zod 校验全部 IPC 参数；网络请求统一经主进程；TLS 校验不可关闭
- 密钥：safeStorage 加密存储；脱敏发生在记录捕获点；导出前二次提示
- 数据：全部存于系统用户数据目录（macOS `~/Library/Application Support/api-workbench`，Windows `%APPDATA%/api-workbench`），无写死路径

## 许可

私有项目，未设开源许可。
