# Testing & Verification

中文版:[测试与验证](测试与验证)

## Automated tests (offline, every push)

- **157 tests**: unit (SSE parser, URL join, redaction, diagnosis rules, stores, export, adapters, example tools) + integration (full request loop against the real mock server over localhost)
- **24 UI scenarios** (`npm run uitest`): DOM-driven, screenshot-reviewed — forms, streaming, cancel button, diagnosis panel, compare, performance, min-window layout, no embedded webviews

## CI on every push (`.github/workflows/windows-build.yml`)

| Job | What happens |
| --- | --- |
| Tests (ubuntu + windows) | typecheck + all tests, real run on both OS |
| macOS build | build dmg → **run packaged `.app --smoke` (9 steps)** |
| Windows build | build NSIS + win-unpacked → **run packaged `.exe --smoke` (9 steps)** |

Smoke steps: window load → React mount → CSP → key-store mode → config loop → mock server child process → non-stream loop (asserts redaction) → stream loop → 401 + diagnosis → clean exit.

## Verified vs not verified (honest list)

**Verified**: everything above — automated tests, packaged-artifact smoke on clean Windows/macOS machines, manual install test on macOS.

**Not verified** (requires the owner):
- Real provider API calls with real keys (all three protocols implemented per official docs; mock follows real behavior)
- Windows installer double-click UX (Smartscreen prompt, shortcuts) — the exe itself is smoke-tested on every push
- macOS signing/notarization (no developer certificate)

## The 18 required scenarios

The original project brief demanded 18 test scenarios (normal/streaming/UTF-8 split/401/403/404/429/5xx/timeout/cancel/non-JSON/empty catalog/malformed catalog/network break/redaction/URL join/config persistence/secure-storage fallback). Every one has named tests — see `docs/testing.md` in the repo for the mapping table.
