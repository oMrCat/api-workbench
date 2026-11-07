<div align="center">

# API Workbench

**Local-first AI API compatibility & diagnostics workbench for Windows and macOS**

[简体中文](README.md) | **English**

CI status: every push runs 157 automated tests on Windows + Ubuntu, builds installers for both platforms, and **runs the packaged app itself through a 9-step smoke loop** on clean CI machines.

</div>

---

API Workbench is **not a chat app** and not a "universal client". It is a diagnostics tool for people who integrate AI APIs:

**configure providers → sync models → send test requests → analyze failures → export sanitized reports**

## Features (P0 + P1, all verified)

- ✅ **Provider configuration** — multiple providers, three protocols (**OpenAI Chat Completions** / **Anthropic Messages** / **OpenAI Responses**), custom headers, timeout, path overrides, plain-HTTP risk warning, delete confirmation
- ✅ **Key security** — keys stored in OS secure storage (macOS Keychain / Windows DPAPI); falls back to session-memory **explicitly** if unavailable; never touches logs, reports, config files, or localStorage
- ✅ **Model catalog** — sync from provider or manual entry, search, raw payload viewer, capability badges in four states (declared / user-marked / **verified by real test runs** / unverified)
- ✅ **Request testing** — non-streaming + streaming (true incremental SSE parsing, correct across chunk-split UTF-8), cancel, timeout, **parameter minimalism** (only fields you explicitly enable are sent)
- ✅ **Diagnostics** — observed facts / ranked possible causes / suggested steps / explicit uncertainty statement; raw evidence preserved (a 502 is never blamed on the client, a 400 is never blamed on "model unsupported" without evidence)
- ✅ **Tool-call testing (P1)** — two fixed side-effect-free example tools; anything outside the whitelist is **rejected and logged**; each step visualized (model's argument JSON → local execution → result fed back)
- ✅ **Multi-provider compare (P1)** — same prompt sent concurrently (≤5) to several providers; table with status / HTTP / latency / TTFB / first-token / usage / fastest badge
- ✅ **Performance testing (P1)** — user-initiated only, default concurrency 1 (max 4), request & time caps, **stops dispatching immediately on 429**, **zero automatic retries** (failures may already be billed), min/median/p95/max latency summary
- ✅ **Sanitized report export** — Markdown / JSON; `Authorization`, API keys, cookies, sensitive custom headers, sensitive URL params and known key strings are replaced with `***REDACTED***`; prompt/response bodies excluded by default (explicit confirmation required to include); sanitized curl reproduction sample with a placeholder instead of any real key
- ✅ **Config export/import (P1)** — providers as JSON, naturally key-free; sensitive-looking header values redacted on export; per-entry validation on import
- ✅ **Built-in mock API server** — one click, no real key needed; 15+ fault-injection scenarios (401/403/404/429/500/502/HTML/hang/slow/broken stream, malformed catalogs)
- ✅ **157 automated tests + 24 UI scenarios** — offline, run on every push against real localhost network stack

## Quick start (development)

Requires Node.js ≥ 22.

```bash
npm ci          # install locked dependencies
npm run mock    # terminal A: mock server on :8045
npm run dev     # terminal B: the desktop app
```

You can also start the built-in mock server from the app's Overview page with one click.

### Using the mock server

1. Overview page → "Start mock server"
2. Providers page → add: Base URL `http://127.0.0.1:<port>`, protocol *OpenAI-compatible Chat Completions*, any key starting with `sk-mock` (e.g. `sk-mock-test-key`)
3. Models page → sync
4. Test page → try `mock-chat-mini` (normal), `mock-500` / `mock-hang` / `mock-break` (fault injection)
5. History page → export a sanitized report

### Verify

```bash
npm run typecheck   # tsc, two configs
npm test            # 157 automated tests
npm run smoke       # headless 9-step desktop smoke, exit code 0 = pass
npm run uitest      # 24 DOM-driven UI scenarios with screenshots
npm run dist:mac    # macOS arm64 dmg
```

## Real providers

Enter a real Base URL + key on the Providers page. Plain HTTP to non-local addresses triggers a warning; keys go into OS secure storage and appear as `***REDACTED***` everywhere else. The app only sends parameters you explicitly enable — different providers support different subsets, and any 4xx shows the raw error body as evidence.

## Packaging

- macOS arm64: `npm run dist:mac` → `dist/API Workbench-<version>-arm64.dmg` (unsigned; on other Macs right-click → Open)
- Windows x64: `npm run dist:win` or the GitHub workflow (NSIS, unsigned)
- CI (`.github/workflows/windows-build.yml`): tests on Windows + Ubuntu, builds both installers, then **runs the packaged .exe/.app through the smoke loop on clean machines**

## Documentation

- [架构说明 / Architecture](docs/architecture.md)
- [测试记录 / Testing log](docs/testing.md)
- [已知问题 / Known issues](docs/known-issues.md)
- [任务看板 / Task board](TASKS.md) · [交接状态 / Handoff](HANDOFF.md)
- Wiki: bilingual pages (Home / 首页, Architecture / 架构, Testing / 测试, FAQ)

## Security model

- Renderer: sandbox + contextIsolation + CSP (`connect-src 'none'`) — no Node, no network
- Main process: zod-validated IPC, all HTTP via main, TLS verification never disabled
- Keys: safeStorage-encrypted; redaction happens at record-capture time; double confirmation before exporting bodies
- Data: system user-data directory only, no hardcoded paths

## Status

Original development plan (P0 + P1) **fully completed and verified**. Remaining items require the owner: real-provider verification with real keys, Windows installer UX on a real machine, and optional P2 features (image APIs, more diagnosis rules, request templates) driven by real-world feedback.

## License

Private project, no open-source license attached.
