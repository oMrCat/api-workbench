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

**执行命令**：`npm run build && npx electron . --smoke`（构建产物运行，无头模式）

**最近一次结果**：**退出码 0，9/9 步全部通过**，**真实执行**（2026-11-07，本机）：

```
[smoke] ✅ 窗口与渲染进程加载完成
[smoke] ✅ React 应用挂载成功
[smoke] ✅ CSP 已生效
[smoke] ✅ 密钥存储模式：system          ← macOS Keychain 实测可用
[smoke] ✅ 服务商配置保存/读取闭环
[smoke] ✅ 模拟服务子进程启动（端口 62925）
[smoke] ✅ 非流式请求闭环（HTTP 200，耗时 107ms，文本 61 字符，已脱敏）
[smoke] ✅ 流式请求闭环（事件 9 条，首内容 35ms）
[smoke] ✅ 错误场景与诊断生成（401）
[smoke] 🎉 全部 9 步通过
```

验证内容：窗口加载、React 挂载、CSP 生效、safeStorage 状态、配置保存/恢复、
模拟服务子进程启动、非流式完整闭环（含脱敏断言）、流式完整闭环（事件日志+首内容延迟）、
401 错误场景与诊断生成、退出清理。

## 本机打包

**执行命令**：`npx electron-builder --mac --arm64`（含 `ELECTRON_MIRROR` 环境变量，见下）

**产物**：`dist/API Workbench-0.1.0-arm64.dmg` + `dist/mac-arm64/API Workbench.app`（真实产出）

**打包产物冒烟验证**：对打包后的 `.app` 二进制直接执行 `--smoke`，**退出码 0，9/9 步全过**
（端口 63014 的模拟服务子进程从 extraResources 正确解析——验证了 asar 打包与资源路径）：

```
[smoke] ✅ 窗口与渲染进程加载完成 → … → 密钥存储模式：system
[smoke] ✅ 非流式请求闭环（HTTP 200，耗时 112ms，已脱敏）
[smoke] ✅ 流式请求闭环（事件 9 条，首内容 35ms）
[smoke] 🎉 全部 9 步通过
```

**签名状态**：未签名未公证（identity: null，无开发者证书），本机可直接运行；
分发到其他 Mac 需右键 → 打开。未引导关闭 Gatekeeper。

环境备注：本机网络 GitHub releases 直连超时，Electron 二进制与
electron-builder 资源需走 npmmirror 镜像：

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

## 真实服务商接口测试

**状态：未验证。** 本环境无真实 API Key，按要求不将真实密钥提交到仓库或对话。
用户可自行操作：启动应用 → 服务商页配置真实服务商与密钥 → 请求测试页发起。
真实接口计费行为（usage 字段差异、4xx 响应体格式差异）可能与模拟服务有出入，遇问题请导出脱敏报告反馈。

## CI 构建（Windows / macOS）

**状态：✅ 已验证。** 仓库已推送 GitHub（https://github.com/oMrCat/api-workbench，private），
run [42367661321](https://github.com/oMrCat/api-workbench/actions/runs/42367661321)（2026-11-07）四 job 全绿：

| Job | 结果 | 耗时 |
| --- | --- | --- |
| 类型检查 + 测试 (ubuntu-latest) | ✅ | 32s |
| 类型检查 + 测试 (windows-latest) | ✅ **103 项测试在 Windows 上真实通过** | 1m6s |
| macOS arm64 打包 | ✅ 产出 DMG | 42s |
| Windows x64 打包 | ✅ **产出 NSIS 安装包** | 3m22s |

**产物**（Actions Artifacts，已用 API 确认存在）：
- `api-workbench-win-x64`（121,749,147 字节，含 NSIS 安装包）
- `api-workbench-mac-arm64`（123,381,617 字节，含 DMG）

CI 期间修复的两个工作流问题（均有 commit 记录）：
1. `macos-14` runner 镜像 2026-11-02 退役 → job 无日志直接 cancelled → 改 `macos-latest`
2. 检测到 GitHub origin 后 electron-builder 要求 GH_TOKEN → 显式 `--publish never`

**边界（如实）**：CI 构建成功 ≠ Windows 真机安装验收。安装包尚未在真实 Windows 机器上
安装、启动、跑模拟闭环——此项仍标注"未验证"，见 known-issues.md。
