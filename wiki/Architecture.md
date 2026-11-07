# Architecture

中文版:[架构](架构)

```
┌─────────────────────────────────────────────┐
│ Renderer (React 19 + zustand)               │
│  - 7 pages, no network, no Node             │
│  - CSP: connect-src 'none'                  │
└──────────────┬──────────────────────────────┘
               │ contextBridge (whitelisted API)
┌──────────────▼──────────────────────────────┐
│ Preload (sandbox: true, contextIsolation)   │
└──────────────┬──────────────────────────────┘
               │ ipcRenderer.invoke (zod-validated)
┌──────────────▼──────────────────────────────┐
│ Main (Electron 45)                          │
│  - Protocol adapters (openai-chat /         │
│    anthropic-messages / openai-responses)   │
│  - TestRunner (timeout/cancel/SSE/records)  │
│  - ConfigStore / SecretStore (userData)     │
│  - Redaction → history → export             │
│  - Diagnosis rule engine                    │
│  - Mock server child-process manager        │
└─────────────────────────────────────────────┘
```

## Key decisions

| Decision | Why |
| --- | --- |
| All network in main process | Renderer CSP forbids connections; TLS verification cannot be disabled |
| Keys separate from config | `secrets.json` (encrypted) vs `providers.json` (plain); renderer only ever sees last-4 preview |
| Explicit degradation | safeStorage unavailable → session memory only + visible notice, never silent plaintext |
| Parameter minimalism | Request body contains only fields the user explicitly enabled (test-enforced) |
| Redact at capture | Records are sanitized the moment they are created; raw keys live for one request lifetime |
| Atomic writes | All JSON stores use tmp+rename |
| Snapshot commits via Git Data API | Development network intermittently blocks github.com; api.github.com stays reachable |

## Adding a protocol

Implement the `ProtocolAdapter` interface in `src/main/protocols/types.ts` (chat path, model path, stream event handling, non-stream parsing, catalog parsing), register it in `CHAT_ADAPTERS` (`src/main/index.ts`), add the fault-injection endpoint to `mock-server/server.mjs`, then extend tests. See `anthropic-messages.ts` and `openai-responses.ts` as references — each landed with 10+ unit tests and end-to-end integration tests against the mock server.
