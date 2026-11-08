# 已知问题与限制

诚实清单。每项含位置、影响、复现方式与修复建议。

## 平台与打包

0a. **~~Release 的 Windows 包为免安装 zip~~（已解决 2026-11-08）**
   - 原因:macOS 本地产 NSIS 失败(makensis x86_64 需 Rosetta)
   - 解决:已在 Windows 11 真机执行 `npm run dist:win` 成功产出 `API Workbench Setup 0.1.0.exe`,并已上传至 Release
0b. **safeStorage 弃用告警已消除**:探测改用 `isAsyncEncryptionAvailable`(Electron 45 新 API),旧版本回退同步 API

0. **网络受限环境需配置镜像**
   - 位置：构建环境（本机实测；`npm install` 时 Electron 二进制下载与 `electron-builder` 资源下载默认走 GitHub releases）
   - 影响：GitHub 直连超时时，安装依赖/打包失败（fetch failed / ETIMEDOUT）。
   - 复现：在 GitHub 受限网络执行 `npm ci` 或 `npm run dist:mac`。
   - 修复：设置环境变量 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 与 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`（GitHub Actions 环境无需此步）。
1. ~~**Windows 真机安装体验未验证**~~（✅ 已验证 2026-11-08，Windows 11 x64 真机）
   - vitest 157/157 全绿（Windows runner 与本机一致）；`npm run smoke` 9/9；`npm run uitest` 24 场景全过。
   - **NSIS 安装器真机安装/卸载实测通过**：per-user 装至 `%LOCALAPPDATA%\Programs\API Workbench`（无 UAC）；未签名有 SmartScreen「更多信息 → 仍要运行」提示（预期行为）；开始菜单/桌面快捷方式正常生成；卸载后程序/快捷方式/注册表项全部清除、userData 按惯例保留。
   - 实测发现并修复：uitest 截图目录硬编码 `/tmp/uitest` 在 Windows 落盘根 `C:	mp`（已改 `os.tmpdir()`）。
   - 数据目录实测为 `%APPDATA%\API Workbench`（productName；旧文档写的 `api-workbench` 不存在）。
2. **macOS 包未签名未公证**
   - 位置：`electron-builder.yml`（`identity: null`）
   - 影响：其他机器首次打开需右键 → 打开绕过 Gatekeeper（本机 ad-hoc 可直接运行）。
   - 建议：有 Apple Developer 账号后在 CI 加签名 + 公证。
3. **npm audit 有告警未处理**
   - 位置：`npm ls` 依赖树（来自 vite/electron-builder 的传递依赖）
   - 影响：无已知运行时风险；未执行 `audit fix --force` 以避免破坏依赖兼容性。
   - 建议：锁定版本下按需点升级，跑回归测试。

## 功能边界（P0 明确不含）

4. **Responses / Anthropic Messages 协议未实现**（P1 计划）
   - 位置：`src/main/protocols/` 仅 openai-chat；UI 协议下拉只有一项。
   - 影响：配置为其他协议的服务商无法测试。
5. **工具调用测试未实现**（P1）：模型页可"标记支持工具"，但无实际验证流程。
6. **能力标注不会自动从测试记录回写 `verifiedCapabilities`**（P1）：目前 verified 徽章预留，数据流已定义。
7. **模拟服务按模型名注入故障**：真实服务商的错误响应格式千差万别，诊断规则以通用模式 + 响应体证据为准，无法保证全部服务商准确归类（诊断面板始终展示不确定性声明）。

## 技术细节

8. **渲染进程首包 714 KB**（未做代码分割）
   - 位置：`out/renderer/assets/index-*.js`
   - 影响：首次加载略慢，本地加载实际无感。
   - 建议：如在意可做路由级懒加载。
9. **流事件日志默认 200 条**：超大流式响应只保留前 200 条事件（文本内容完整显示，不受影响）；可在设置调整上限。
10. **并发限制**：同时只支持一个进行中的请求测试（UI 防重复提交）；P1 性能测试会引入受控并发。
11. **undici 受限端口**：Base URL 端口若属于浏览器受限端口（如 1、7、23 等），Node fetch 直接报 "bad port"，诊断归类为"未知错误"。真实服务商不受影响。
12. **集成测试对 DNS 失败用例依赖 `.invalid` TLD**：隔离网络环境（无 DNS）下 `definitely-not-exist-abcxyz.invalid` 的失败阶段可能表现为 connect 而非 dns。
13. **undici 对"响应头后长时间无数据"的流没有应用层心跳提示**：本应用以流空闲超时（默认 30s,可配置）兜底判定流中断；上游若在空闲超时内静默,用户会看到较长的等待,超时后有明确诊断。（GUI 测试曾发现 mock 服务器误判 `req.destroyed` 导致的永久挂起,已修复为只检查 `res.destroyed`。）

## 依赖决策记录

- **electron-builder 而非 Electron Forge**：单一打包体系；builder 对 NSIS/DMG 支持成熟，与 electron-vite 组合文档充分。
- **TS 5.9 而非 7.0**：TS 7 为大版本重构，工具链兼容风险高，48 小时冲刺不追新。
- **Electron 45.2.3 精确锁定**：npm registry dist-tags.latest；vite 7 + plugin-react 5 的 peer 兼容已核实。
- **标准 fetch 而非 Electron net 模块**：主进程与测试环境代码同一份，可离线测试；代价是代理支持依赖系统级配置（记录为限制）。
