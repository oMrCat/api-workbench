# API Workbench

**Local-first AI API compatibility & diagnostics workbench for Windows and macOS.**

中文版:[首页](首页)

## What is it

A diagnostics tool for people who integrate AI APIs — not a chat app:

**configure providers → sync models → send test requests → analyze failures → export sanitized reports**

## Feature matrix

| Area | What you get |
| --- | --- |
| Protocols | OpenAI Chat Completions · Anthropic Messages · OpenAI Responses |
| Request testing | Non-streaming + true incremental streaming, cancel, timeout, parameter minimalism |
| Tool calls | Fixed side-effect-free example tools, whitelist enforcement, per-step visualization |
| Compare | Same prompt to ≤5 providers concurrently: status / latency / TTFB / first token / usage |
| Performance | User-initiated only, concurrency ≤4, request & time caps, stops on 429, zero auto-retry |
| Diagnostics | Facts / ranked causes / suggested steps / explicit uncertainty, raw evidence kept |
| Reports | Markdown / JSON export, sanitized by default, sanitized curl sample |
| Config | JSON export/import (key-free by design), per-entry validation |
| Keys | OS secure storage (Keychain / DPAPI), session-memory fallback with explicit notice |
| Safety | Renderer sandboxed, CSP `connect-src 'none'`, all HTTP in main process, TLS never disabled |

## Quick start

1. Start the built-in mock server (Overview page, one click)
2. Providers page → add `http://127.0.0.1:<port>` + any key starting with `sk-mock`
3. Models page → sync
4. Test page → try `mock-chat-mini`, or fault-injection models: `mock-500`, `mock-hang`, `mock-break`
5. History page → export a sanitized report

## Quality

- 157 automated tests (unit + integration, offline, real localhost network stack)
- 24 DOM-driven UI scenarios with screenshots
- CI on every push: tests on Windows + Ubuntu, installers built, **packaged app smoke-tested on clean machines**

## Pages

- [Architecture](Architecture) — structure, decisions, extension points
- [Testing-and-Verification](Testing-and-Verification) — what is verified, how
- [FAQ-and-Known-Issues](FAQ-and-Known-Issues) — limits, pitfalls, troubleshooting
