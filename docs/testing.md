# 测试记录

本文件记录实际执行过的验证。**只列真实执行过的**，未执行的明确标注"未验证"。

## 环境

| 项 | 值 |
| --- | --- |
| 日期 | 2026-11-07 |
| 机器 | MacBook, Apple M1 (arm64), 16 GB |
| 系统 | macOS 27.2 (26B123) |
| Node | v22.23.4（Homebrew node@22） |
| npm | 10.9.9 |
| Electron | 45.2.3 |
| 执行人 | 开发代理（ZCode 会话内执行） |

## 自动化测试

**执行命令**：`npm test`（vitest run，含单元 + 集成）

**最近一次结果**：`Test Files 7 passed (7) / Tests 103 passed (103)`，耗时约 12.5s，**真实执行**。

### 覆盖场景与用户要求的 18 项对照

| # | 场景 | 测试位置 | 状态 |
| --- | --- | --- | --- |
| 1 | 正常非流式响应 | integration/request-loop: "正常非流式响应" | ✅ 通过 |
| 2 | 正常流式响应 | integration: "正常流式：增量文本/首个内容延迟/事件日志/usage" | ✅ |
| 3 | 跨分块事件和 UTF-8 解析 | unit/sse-parser（14 个用例，含字节级 3 字节切割压力测试）+ integration 流式断言 🎉☀️ 完整性 | ✅ |
| 4 | 401 | integration: "401 → 失败 + 响应体证据 + 认证诊断" | ✅ |
| 5 | 403 | integration: "403 → 权限类诊断" | ✅ |
| 6 | 404 | integration: "404 → 模型不存在路径" | ✅ |
| 7 | 429 | integration: "429 → 限流诊断" | ✅ |
| 8 | 500/502 | integration: "500"、"502 → 不归因客户端" | ✅ |
| 9 | 超时 | integration: "总超时（mock-hang 挂起）→ timeout 阶段" | ✅ |
| 10 | 用户取消 | integration: "用户取消（通过事件捕获 runId 后精确取消）" | ✅ |
| 11 | 非 JSON 响应 | integration: "非 JSON 响应（HTML）" | ✅ |
| 12 | 空模型列表 | integration: "空模型列表 → 空 entries 且不报错" | ✅ |
| 13 | 不规范模型目录 | integration: "不规范目录数据 → 跳过畸形条目不崩溃" | ✅ |
| 14 | 网络中断 | integration: "流式中断（上游断开）"、"连接拒绝"、"DNS 失败" | ✅ |
| 15 | 日志和报告密钥脱敏 | unit/redact（13 用例）+ integration 断言 Authorization 为 ***REDACTED*** | ✅ |
| 16 | URL 拼接 | unit/url-join（10 用例，含 /v1/v1 去重） | ✅ |
| 17 | 配置保存与恢复 | unit/store（8 用例，含跨实例恢复/损坏 JSON 容错） | ✅ |
| 18 | 安全存储不可用行为 | unit/store（6 用例：降级内存/不写盘/明确告知/加密失败报错） | ✅ |

### 额外覆盖

- 参数最小化（未设置的参数不出现在请求体）：integration "协议行为" 4 用例 ✅
- 报告导出（JSON/Markdown/curl 示例脱敏）：unit/export 6 用例 ✅
- 诊断规则引擎：unit/diagnosis 17 用例（含 502 不归因客户端、invalid_api_key 证据收敛、不确定性声明）✅
- 流空闲超时、流事件日志上限：实现有防护代码；空闲超时路径由 mock-hang 的超时测试间接覆盖 ✅

## 桌面冒烟测试

**执行命令**：`npx electron . --smoke`
（构建产物运行；验证窗口加载、React 挂载、CSP、密钥存储状态、配置闭环、模拟服务子进程、非流式闭环、流式闭环、401 诊断、退出码）

**状态**：见下方"执行记录"节（在 macOS 本机执行，输出与退出码如实记录）。

## 真实服务商接口测试

**状态：未验证。** 本环境无真实 API Key，按要求不将真实密钥提交到仓库或对话。
用户可自行操作：启动应用 → 服务商页配置真实服务商与密钥 → 请求测试页发起。
真实接口计费行为（usage 字段差异、4xx 响应体格式差异）可能与模拟服务有出入，遇问题请导出脱敏报告反馈。

## Windows 构建

**状态：CI 配置已就绪（.github/workflows/windows-build.yml），尚未推送远程仓库，故 CI 实际运行状态未验证。**
无 Windows 真机，无法本地验证 Windows 安装包。限制记录于 docs/known-issues.md。
