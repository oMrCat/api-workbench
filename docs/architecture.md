# API Workbench 架构

## 总体结构

```
┌─────────────────────────────────────────────┐
│ Renderer（React 19 + zustand）              │
│  - 六页面 UI，无网络请求、无 Node 能力        │
│  - CSP: connect-src 'none'                  │
└──────────────┬──────────────────────────────┘
               │ contextBridge（preload 白名单 API）
┌──────────────▼──────────────────────────────┐
│ Preload（sandbox: true, contextIsolation）   │
│  - 只暴露命名方法，不暴露 ipcRenderer 原始对象 │
└──────────────┬──────────────────────────────┘
               │ ipcRenderer.invoke（zod 参数校验）
┌──────────────▼──────────────────────────────┐
│ Main（Electron 45）                          │
│  - 协议适配器层（openai-chat，P0）            │
│  - TestRunner（请求编排：超时/取消/SSE/记录） │
│  - ConfigStore / SecretStore（用户数据目录）  │
│  - 脱敏 → 历史存储 → 导出（MD/JSON/curl）     │
│  - 诊断规则引擎                              │
│  - 模拟服务子进程管理（ELECTRON_RUN_AS_NODE） │
└─────────────────────────────────────────────┘
```

## 目录结构

| 路径 | 职责 |
| --- | --- |
| `src/shared/types.ts` | 主/渲染进程共享类型（不依赖 electron） |
| `src/shared/ipc-contract.ts` | IPC 通道名单 + zod 校验 Schema |
| `src/shared/url.ts` | URL 拼接/回环判断（双侧共用） |
| `src/main/index.ts` | 入口：窗口、IPC 注册、生命周期、冒烟模式 |
| `src/main/net/http-client.ts` | fetch 封装：计时/超时/取消/错误分类/流读取 |
| `src/main/net/sse-parser.ts` | SSE 增量解析（跨块/UTF-8/\r\n） |
| `src/main/protocols/` | 协议适配器（P0: openai-chat；P1: responses/anthropic） |
| `src/main/runner/test-runner.ts` | 请求闭环编排（捕获→脱敏→诊断→记录） |
| `src/main/store/config-store.ts` | 服务商/模型/历史/设置（原子写入 JSON） |
| `src/main/store/secret-store.ts` | 密钥存储（safeStorage / 会话内存降级） |
| `src/main/redact.ts` | 脱敏（头/URL/文本/请求对象） |
| `src/main/diagnosis.ts` | 诊断规则（事实/原因/建议/不确定性） |
| `src/main/report/export.ts` | Markdown / JSON 报告 + curl 示例 |
| `src/renderer/` | React UI（六页面 + zustand） |
| `mock-server/server.mjs` | 零依赖模拟服务（故障注入） |
| `tests/unit/` | 单元测试（解析器/脱敏/诊断/存储/导出） |
| `tests/integration/` | 请求闭环集成测试（18 场景） |

## 关键设计决策

1. **网络只在主进程**：渲染进程 CSP `connect-src 'none'`，一切请求经 IPC。TLS 校验使用系统默认，不提供关闭选项。
2. **密钥与配置分离**：`secrets.json`（加密）独立于 `providers.json`（普通）。渲染进程永远拿不到密钥原文，只有末 4 位预览。
3. **降级明确**：safeStorage 不可用 → 仅会话内存 + UI 明示，绝不静默明文落盘（有测试覆盖）。
4. **参数最小化**：请求体只包含用户明确设置的字段（有测试断言请求体内容）。
5. **脱敏在捕获点**：记录创建时立即脱敏，原始密钥只在请求头内存中存活一次请求的时长。
6. **原子写入**：所有 JSON 存储使用 tmp+rename，避免写入中断损坏配置。
7. **流式解析容错**：SSE 解码器处理跨块事件、跨块 UTF-8、\r\n 变体；流事件日志有上限（默认 200 条）防内存失控。
8. **模拟服务子进程**：应用内一键启动/停止，ELECTRON_RUN_AS_NODE 复用 Electron 二进制运行零依赖脚本；退出时 kill。

## 模拟服务故障注入约定

| 模型 ID | 行为 |
| --- | --- |
| `mock-chat-mini` 等 | 正常响应（非流式/流式） |
| `mock-403 / mock-404 / mock-429 / mock-500 / mock-502` | 对应 HTTP 错误 |
| `mock-502-html` | HTML 错误页（网关形态） |
| `mock-nonjson` | 200 但返回 HTML（端点配错形态） |
| `mock-hang` | 响应头后挂起（超时测试） |
| `mock-slow` | 每块 200ms（取消测试） |
| `mock-break` | 流中途断开（中断测试） |
| `/v1/models-empty` `/v1/models-malformed` `/v1/models-nonjson` | 目录异常场景 |

密钥：任何 `sk-mock` 开头字符串有效；其他 → 401。

## P1 扩展点

- 新协议：实现 `ProtocolAdapter` 接口（`src/main/protocols/types.ts`），在 `CHAT_ADAPTERS` 注册，前端协议下拉放开。
- 能力验证结果回写：模型目录的 `verifiedCapabilities` 由测试记录驱动（P0 已有数据结构）。
