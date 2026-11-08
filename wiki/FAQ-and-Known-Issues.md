# FAQ & Known Issues

中文版:[常见问题与已知问题](常见问题与已知问题)

## FAQ

**Q: Why does a 502 show "server-side problem" instead of blaming my config?**
Diagnosis rules are evidence-based: 5xx is attributed to the upstream with an explicit uncertainty statement. A single status code never maps to a single root cause.

**Q: Where does usage show "上游未返回 / not returned"?**
When the upstream omits usage fields, the tool says so — it never estimates and presents guesses as real values.

**Q: Can I disable TLS verification for self-signed certs?**
No. Verification is never disabled by design. Fix the trust chain at OS level instead.

**Q: The mock server — what keys does it accept?**
Any string starting with `sk-mock`. Everything else gets a 401 with evidence.

**Q: What happens if the model returns no usage?**
The result panel shows `上游未返回 / not returned`. The performance summary counts how many successful responses returned usage.

## Known issues (highlights — full list in repo `docs/known-issues.md`)

1. ~~**Windows installer UX untested on a real machine**~~ ✅ Verified on Windows 11 x64 (2026-11-08): full NSIS install/uninstall cycle passed (per-user, no UAC; SmartScreen unsigned warning expected; shortcuts OK; clean uninstall); uitest screenshot dir moved to `os.tmpdir()` (the hardcoded `/tmp/uitest` landed on `C:	mp` on Windows).
2. **Unsigned builds** — macOS: right-click → Open on other machines; Windows: Smartscreen "More info → Run anyway". Needs a developer certificate to fix.
3. **npm audit warnings** — not force-fixed to avoid breaking the locked dependency tree.
4. **Stream event log caps at 200 entries** (configurable) — full response text is unaffected; protects memory on huge streams.
5. **One in-flight request test at a time** — compare/perf orchestrate multiple requests explicitly, user-initiated.
6. **Browser-restricted ports** (1, 7, 23 …) are rejected by the fetch stack as "bad port" — diagnosis classifies as unknown error.
7. **Network-restricted dev environments** — if github.com is blocked, set `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` and `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`.
