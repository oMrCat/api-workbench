// UI 交互测试装置(--uitest):用真实 DOM 事件驱动 React 界面,逐场景断言 + 截图。
// 与 --smoke(走 window.api 接口层)互补,本文件验证的是**界面层**:
// 表单、按钮、导航、流式渲染、取消按钮、布局缩放。
// 运行:npm run build && electron . --uitest ;截图与报告输出到 /tmp/uitest/

import type { BrowserWindow } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'

const OUT_DIR = '/tmp/uitest'

interface UiScenarioResult {
  name: string
  ok: boolean
  detail?: string
  screenshot?: string
}

export async function runUiTest(win: BrowserWindow): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const results: UiScenarioResult[] = []
  // 表达式版:包 try/catch,把渲染进程内的真实错误带回 Node 侧(executeJavaScript 默认只给 generic message)
  const evalJs = async <T = unknown>(expr: string): Promise<T> => {
    const wrapped = `(async () => { try { return await (${expr}); } catch (e) { return { __error: String((e && e.message) || e) }; } })()`
    const out = await win.webContents.executeJavaScript(wrapped, true)
    if (out && typeof out === 'object' && '__error' in (out as Record<string, unknown>)) {
      throw new Error(String((out as Record<string, unknown>).__error))
    }
    return out as T
  }
  // 多语句脚本版:不走表达式包装(语法不同),错误只到 generic——仅用于安装辅助函数
  const evalRaw = async (script: string): Promise<void> => {
    await win.webContents.executeJavaScript(script, true)
  }

  const shot = async (name: string): Promise<string> => {
    const img = await win.webContents.capturePage()
    const file = path.join(OUT_DIR, `${name}.png`)
    fs.writeFileSync(file, img.toPNG())
    return file
  }

  const scenario = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const detail = await fn()
      results.push({ name, ok: true, detail: detail || undefined })
      console.log(`[uitest] ✅ ${name}${detail ? ` — ${detail}` : ''}`)
    } catch (e) {
      const file = await shot(`FAIL-${name.replace(/[^a-zA-Z0-9]/g, '-')}`).catch(() => undefined)
      results.push({ name, ok: false, detail: String((e as Error).message ?? e), screenshot: file })
      console.error(`[uitest] ❌ ${name} — ${String((e as Error).message ?? e)}`)
    }
  }

  // ---- 页面内工具(注入渲染进程执行) ----
  // React 受控输入需要用原生 setter 触发,否则 state 不更新
  const pageHelpers = `
    window.__t = {
      nav: (label) => {
        const btns = [...document.querySelectorAll('.nav button')];
        const b = btns.find(x => x.textContent.trim() === label);
        if (!b) throw new Error('nav button not found: ' + label);
        b.click(); return true;
      },
      clickText: (text, scope='body') => {
        const root = document.querySelector(scope);
        const els = [...root.querySelectorAll('button, a, label')];
        const el = els.find(x => x.textContent.includes(text));
        if (!el) throw new Error('clickable not found: ' + text);
        el.click(); return true;
      },
      fill: (sel, value) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error('input not found: ' + sel);
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      },
      fillPlaceholder: (ph, value) => {
        const el = [...document.querySelectorAll('input, textarea')].find(x => x.placeholder && x.placeholder.includes(ph));
        if (!el) throw new Error('input by placeholder not found: ' + ph);
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      },
      text: () => document.body.innerText,
      has: (s) => document.body.innerText.includes(s),
      waitFor: async (s, timeoutMs=8000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
          if (document.body.innerText.includes(s)) return true;
          await new Promise(r => setTimeout(r, 100));
        }
        throw new Error('waitFor timeout: ' + s);
      },
      waitGone: async (s, timeoutMs=5000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
          if (!document.body.innerText.includes(s)) return true;
          await new Promise(r => setTimeout(r, 100));
        }
        throw new Error('waitGone timeout: ' + s);
      },
      overflowX: () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      toggleStream: (on) => {
        const labels = [...document.querySelectorAll('label')];
        const lb = labels.find(x => x.textContent.includes('流式响应'));
        if (!lb) throw new Error('流式响应 label not found');
        const cb = lb.querySelector('input[type=checkbox]');
        if (cb.checked !== on) { lb.click(); }
        return cb.checked;
      }
    };
    true
  `

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  try {
    // 等待渲染进程挂载
    await evalJs(`document.getElementById('root')?.children.length > 0`)
    await evalRaw(pageHelpers)
    console.log('[uitest] React 挂载,开始场景')

    // S0 清场:删除历史遗留的测试服务商(避免 providers[0] 指向陈旧死端口)与历史记录,恢复默认设置
    await scenario('S0-清场', async () => {
      const removed = await evalJs<number>(
        `(async () => {
          const list = await window.api.listProviders();
          let n = 0;
          for (const p of list) {
            if (p.name === '界面测试服务商' || p.id === 'smoke-p' || p.id === 'cmp-second') { await window.api.deleteProvider(p.id); n++; }
          }
          await window.api.clearHistory();
          const s = await window.api.getSettings();
          await window.api.setSettings({ ...s, persistHistory: true });
          return n;
        })()`
      )
      // 让 zustand 重新拉取(重新触发 App 初始化路径:直接刷新窗口状态)
      await evalJs(`window.api.listProviders().then(() => 'refreshed')`)
      await sleep(300)
      return `清理了 ${removed} 个遗留服务商`
    })

    // S1 概览页
    await scenario('S1-概览页渲染', async () => {
      const has = await evalJs<boolean>(`window.__t.has('快速开始') && window.__t.has('环境信息')`)
      if (!has) throw new Error('概览关键内容缺失')
      return `截图见 ${await shot('S1-overview')}`
    })

    // S2 模拟服务启动(概览页按钮)
    await scenario('S2-模拟服务启动按钮', async () => {
      await evalJs(`window.__t.clickText('启动模拟服务')`)
      await evalJs(`window.__t.waitFor('运行中 127.0.0.1:', 12000)`)
      return `截图见 ${await shot('S2-mock-running')}`
    })

    // S3 添加服务商表单 + 保存
    await scenario('S3-添加服务商表单', async () => {
      await evalJs(`window.__t.nav('服务商')`)
      await evalJs(`window.__t.clickText('＋ 添加服务商')`)
      await evalJs(`window.__t.fillPlaceholder('如：本地模拟服务', '界面测试服务商')`)
      // Base URL:第一个 placeholder 为 https://api.example.com 的输入框
      await evalJs(`window.__t.fillPlaceholder('https://api.example.com', 'http://127.0.0.1:' + (await window.api.mockStatus()).port)`)
      await evalJs(`window.__t.clickText('保存配置')`)
      await evalJs(`window.__t.waitFor('界面测试服务商', 5000)`)
      return `截图见 ${await shot('S3-provider-saved')}`
    })

    // S4 非法 URL 校验(zod 阻止保存)
    await scenario('S4-非法URL被拒', async () => {
      await evalJs(`window.__t.clickText('＋ 添加服务商')`)
      await evalJs(`window.__t.fillPlaceholder('如：本地模拟服务', '坏地址服务商')`)
      await evalJs(`window.__t.fillPlaceholder('https://api.example.com', 'ftp://not-allowed')`)
      const saveDisabled = await evalJs<boolean>(
        `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '保存配置')?.disabled === true`
      )
      if (!saveDisabled) throw new Error('非法 URL 时保存按钮未被禁用')
      await evalJs(`window.__t.clickText('取消')`)
      return '非法 URL 正确阻止保存'
    })

    // S5 密钥保存后仅显示末 4 位
    await scenario('S5-密钥预览脱敏', async () => {
      // 找到第一行的"保存密钥"所在 panel:直接用 api 设定再刷新预览不可行(界面路径),
      // 这里走界面:服务商列表第一行没有输入框——密钥输入在编辑器里。重新进入编辑态:
      await evalJs(`window.__t.clickText('编辑')`)
      await evalJs(`window.__t.fillPlaceholder('粘贴密钥', 'sk-mock-gui-test-key-9999')`)
      await evalJs(`window.__t.clickText('保存密钥')`)
      await evalJs(`window.__t.waitFor('••••9999', 5000)`)
      await evalJs(`window.__t.clickText('取消')`)
      const leaked = await evalJs<boolean>(`window.__t.has('sk-mock-gui-test-key-9999')`)
      if (leaked) throw new Error('密钥原文泄漏到界面!')
      return '仅显示末 4 位,原文未出现'
    })

    // S6 URL 预览无 /v1/v1
    await scenario('S6-URL预览无重复路径', async () => {
      await evalJs(`window.__t.clickText('编辑')`)
      await evalJs(`window.__t.waitFor('最终请求地址预览', 3000)`)
      const preview = await evalJs<string>(
        `[...document.querySelectorAll('pre.code')].map(p => p.textContent).find(t => t.includes('/chat/completions')) ?? ''`
      )
      if (!preview) throw new Error('未找到 URL 预览')
      if (preview.includes('/v1/v1')) throw new Error(`URL 拼接出现重复路径: ${preview}`)
      if (!preview.includes('/v1/chat/completions')) throw new Error(`URL 预览异常: ${preview}`)
      await evalJs(`window.__t.clickText('取消')`)
      return preview.trim()
    })

    // S7 模型同步 + 表格渲染
    await scenario('S7-模型同步与列表', async () => {
      await evalJs(`window.__t.nav('模型')`)
      await evalJs(`window.__t.clickText('同步模型目录')`)
      await evalJs(`window.__t.waitFor('已同步', 10000)`)
      const ok = await evalJs<boolean>(`window.__t.has('mock-chat-mini') && window.__t.has('文档声明')`)
      if (!ok) throw new Error('模型列表或能力徽章缺失')
      return `截图见 ${await shot('S7-models-synced')}`
    })

    // S8 搜索过滤
    await scenario('S8-模型搜索过滤', async () => {
      await evalJs(`window.__t.fillPlaceholder('搜索模型 ID 或所有者', 'mock-chat')`)
      await sleep(300)
      const count = await evalJs<string>(
        `[...document.querySelectorAll('table.list tbody tr')].length + ' 行'`
      )
      const allMatch = await evalJs<boolean>(
        `[...document.querySelectorAll('table.list tbody tr td:first-child')].every(td => td.textContent.includes('mock-chat'))`
      )
      await evalJs(`window.__t.fillPlaceholder('搜索模型 ID 或所有者', '')`)
      if (!allMatch) throw new Error(`过滤结果包含无关模型: ${count}`)
      return count
    })

    // S9 手动添加模型
    await scenario('S9-手动添加模型', async () => {
      await evalJs(`window.__t.fillPlaceholder('模型 ID（如 gpt-4o-mini 或 mock-chat-mini）', 'gui-manual-model')`)
      await evalJs(`window.__t.clickText('添加')`)
      await evalJs(`window.__t.waitFor('gui-manual-model', 5000)`)
      const marked = await evalJs<boolean>(`window.__t.has('手动指定')`)
      if (!marked) throw new Error('手动模型未标注"手动指定"')
      return '已添加并正确标注'
    })

    // S10 非流式请求完整 UI 闭环
    await scenario('S10-非流式请求UI闭环', async () => {
      await evalJs(`window.__t.nav('请求测试')`)
      await evalJs(`window.__t.fillPlaceholder('如 mock-chat-mini', 'mock-chat-mini')`)
      await evalJs(`window.__t.clickText('发起请求')`)
      await evalJs(`window.__t.waitFor('提取文本', 15000)`)
      const ok = await evalJs<boolean>(
        `window.__t.has('HTTP 状态') && window.__t.has('首个内容片段') && window.__t.has('总耗时')`
      )
      if (!ok) throw new Error('结果面板字段缺失')
      return `截图见 ${await shot('S10-nonstream-result')}`
    })

    // S11 usage 显示(上游返回)
    await scenario('S11-usage显示', async () => {
      const usage = await evalJs<string>(
        `[...document.querySelectorAll('.kv .k')].find(k => k.textContent === 'usage')?.nextElementSibling?.textContent ?? ''`
      )
      if (!usage.includes('total_tokens')) throw new Error(`usage 未显示: ${usage}`)
      return usage.slice(0, 60)
    })

    // S12 流式请求:增量渲染(严格断言真实内容增长,排除占位文字)
    await scenario('S12-流式增量渲染', async () => {
      await evalJs(`window.__t.fillPlaceholder('如 mock-chat-mini', 'mock-chat-streamer')`)
      await evalJs(`window.__t.clickText('流式响应')`)
      await evalJs(`window.__t.clickText('发起流式请求')`)
      const grew = await evalJs<boolean>(
        `(async () => {
          const t0 = Date.now();
          let last = -1;
          while (Date.now() - t0 < 15000) {
            const box = document.querySelector('.stream-box');
            const text = box ? box.textContent : '';
            // 占位文字不算增长;真实内容必须持续变长
            const isPlaceholder = text.includes('等待首个内容片段');
            const len = isPlaceholder ? 0 : (text ?? '').length;
            if (last >= 0 && len > last + 5) return true;
            last = len;
            await new Promise(r => setTimeout(r, 150));
          }
          return false;
        })()`
      )
      if (!grew) throw new Error('流式文本未观察到真实内容增量增长')
      // 等待运行真正结束(发送按钮恢复),而不是匹配"结果"字样——旧结果面板会让它提前通过
      await evalJs(`window.__t.waitGone('请求进行中', 20000)`)
      await evalJs(`window.__t.waitFor('所有多字节字符将跨网络分块发送', 5000)`)
      return `截图见 ${await shot('S12-stream-result')}`
    })

    // S13 取消请求(mock-slow 慢流;自行确保流式开 + 上一次运行已结束)
    await scenario('S13-取消请求按钮', async () => {
      await evalJs(`window.__t.waitGone('请求进行中', 20000)`)
      await evalJs(`window.__t.toggleStream(true)`)
      await evalJs(`window.__t.fillPlaceholder('如 mock-chat-mini', 'mock-slow')`)
      await evalJs(`window.__t.clickText('发起流式请求')`)
      await evalJs(`window.__t.waitFor('取消请求', 5000)`)
      await evalJs(`window.__t.clickText('取消请求')`)
      await evalJs(`window.__t.waitFor('已取消', 8000)`)
      return '请求被界面按钮成功取消'
    })

    // S13b 工具调用测试 UI 闭环(mock-tools 两轮)
    await scenario('S13b-工具调用UI闭环', async () => {
      await evalJs(`window.__t.waitGone('请求进行中', 20000)`)
      await evalJs(`window.__t.toggleStream(false)`)
      await evalJs(`window.__t.clickText('工具调用测试')`)
      await evalJs(`window.__t.fillPlaceholder('如 mock-chat-mini', 'mock-tools')`)
      await evalJs(`window.__t.clickText('发起请求')`)
      await evalJs(`window.__t.waitFor('工具调用步骤', 15000)`)
      const ok = await evalJs<boolean>(
        `window.__t.has('calculate_sum') && window.__t.has('成功') && window.__t.has('"sum":5') && window.__t.has('回传结果后的最终回答')`
      )
      if (!ok) throw new Error('工具步骤表格或最终回答缺失')
      await evalJs(`window.__t.clickText('工具调用测试')`) // 还原开关
      return `截图见 ${await shot('S13b-tools-loop')}`
    })

    // S14b 多服务商对比(mock 上建两个服务商,同提示词对比)
    await scenario('S14b-多服务商对比', async () => {
      try {
      const port = await evalJs<number>(`(await window.api.mockStatus()).port`)
      // 第二个服务商(对比需要 ≥2);经 API 创建后需刷新页面让 zustand 重新拉取
      await evalJs(
        `(async () => {
          const list = await window.api.listProviders();
          if (!list.some((p) => p.id === 'cmp-second')) {
            await window.api.saveProvider({
              id: 'cmp-second', name: '对比第二家', baseUrl: 'http://127.0.0.1:' + ${port},
              protocol: 'openai-chat', headers: [], timeoutMs: 15000,
              createdAt: Date.now(), updatedAt: Date.now()
            });
            await window.api.setSecret('cmp-second', 'sk-mock-compare-key');
          }
          return 'ready';
        })()`
      )
      // 主进程侧 reload(executeJavaScript 触发导航会销毁执行上下文导致 promise 拒绝)
      win.webContents.reload()
      await new Promise<void>((resolve) => {
        win.webContents.once('did-finish-load', () => resolve())
        setTimeout(resolve, 8000)
      })
      for (let i = 0; i < 40; i++) {
        try {
          if (await win.webContents.executeJavaScript(`document.getElementById('root')?.children.length > 0`)) break
        } catch { /* 重试 */ }
        await sleep(200)
      }
      console.log('[uitest] S14b: reload 完成,重装助手')
      await evalRaw(pageHelpers)
      console.log('[uitest] S14b: 助手就绪,进入对比页')
      await evalJs(`window.__t.nav('对比')`)
      await evalJs(`window.__t.waitFor('选择服务商', 5000)`)
      // 勾选两个服务商复选框(前两个)
      await evalJs(
        `(() => { [...document.querySelectorAll('table.list tbody tr input[type=checkbox]')].slice(0,2).forEach(cb => { if (!cb.checked) cb.click(); }); return 'checked'; })()`
      )
      // 各自填模型
      await evalJs(
        `(async () => {
          const inputs = [...document.querySelectorAll('table.list tbody input[type=text]')];
          for (const inp of inputs) {
            const proto = HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(inp, 'mock-chat-mini');
            inp.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return 'filled';
        })()`
      )
      await evalJs(`window.__t.clickText('开始对比')`)
      await evalJs(`window.__t.waitFor('对比完成', 20000)`)
      const ok = await evalJs<boolean>(
        `window.__t.has('成功') && document.querySelectorAll('table.list tbody tr').length >= 2 && window.__t.has('ms')`
      )
      if (!ok) throw new Error('对比结果表缺失或不完整')
      return `截图见 ${await shot('S14b-compare')}`
      } finally {
        // 无论成败都清掉对比用第二家,避免残留死端口污染后续运行
        await evalJs(`(async () => { const l = await window.api.listProviders(); for (const p of l) if (p.id === 'cmp-second') await window.api.deleteProvider(p.id); return 'cleaned'; })()`).catch(() => {})
      }
    })

    // S14 错误模型 → 诊断面板(先回测试页并恢复非流式)
    await scenario('S14-错误场景诊断面板', async () => {
      await evalJs(`window.__t.nav('请求测试')`)
      await evalJs(`window.__t.toggleStream(false)`)
      await evalJs(`window.__t.fillPlaceholder('如 mock-chat-mini', 'mock-500')`)
      await evalJs(`window.__t.clickText('发起请求')`)
      await evalJs(`window.__t.waitFor('可能原因', 15000)`)
      const ok = await evalJs<boolean>(
        `window.__t.has('已观察到的事实') && window.__t.has('建议排查步骤') && window.__t.has('不足以确定唯一根因')`
      )
      if (!ok) throw new Error('诊断面板结构缺失')
      return `截图见 ${await shot('S14-error-diagnosis')}`
    })

    // S15 防重复点击(自行确保流式开,避免依赖前序场景状态)
    await scenario('S15-防重复点击', async () => {
      await evalJs(`window.__t.nav('请求测试')`)
      await evalJs(`window.__t.toggleStream(true)`)
      await evalJs(`window.__t.fillPlaceholder('如 mock-chat-mini', 'mock-slow')`)
      await evalJs(`window.__t.clickText('发起流式请求')`)
      await evalJs(`window.__t.waitFor('请求进行中', 5000)`)
      const disabled = await evalJs<boolean>(
        `[...document.querySelectorAll('button')].find(b => b.textContent.includes('请求进行中'))?.disabled === true`
      )
      if (!disabled) throw new Error('请求进行中发送按钮未禁用')
      await evalJs(`window.__t.clickText('取消请求')`)
      await evalJs(`window.__t.waitFor('已取消', 8000)`)
      return '运行中按钮已禁用,取消正常'
    })

    // S16 历史页 + curl 脱敏
    await scenario('S16-历史页与curl脱敏', async () => {
      await evalJs(`window.__t.nav('诊断历史')`)
      await evalJs(`window.__t.waitFor('curl', 5000)`)
      await evalJs(`window.__t.clickText('curl')`)
      await evalJs(`window.__t.waitFor('脱敏 curl 复现示例', 5000)`)
      const leaked = await evalJs<boolean>(`window.__t.has('sk-mock-gui-test-key-9999')`)
      if (leaked) throw new Error('curl 示例泄漏密钥原文!')
      const hasPlaceholder = await evalJs<boolean>(`window.__t.has('$API_WORKBENCH_KEY')`)
      if (!hasPlaceholder) throw new Error('curl 示例缺少占位符提示')
      return `截图见 ${await shot('S16-history-curl')}`
    })

    // S17 历史单条删除
    await scenario('S17-历史单条删除', async () => {
      // window.confirm 在测试里自动返回 false 会阻止删除——覆盖为 true
      await evalJs(`(() => { window.confirm = () => true; return 'overridden'; })()`)
      const before = await evalJs<number>(`[...document.querySelectorAll('table.list tbody tr')].length`)
      await evalJs(`window.__t.clickText('删除')`)
      await evalJs(`window.__t.waitFor('已删除该条记录', 5000)`)
      const after = await evalJs<number>(`[...document.querySelectorAll('table.list tbody tr')].length`)
      return `删除前 ${before} 行 → 删除后 ${after} 行`
    })

    // S18 设置页保存闭环(改一项→保存→还原→再保存,避免污染后续运行)
    await scenario('S18-设置保存闭环', async () => {
      await evalJs(`window.__t.nav('设置')`)
      await evalJs(`window.__t.waitFor('流式响应', 3000)`)
      await evalJs(`window.__t.clickText('持久化历史记录到磁盘')`)
      await evalJs(`window.__t.clickText('保存设置')`)
      await evalJs(`window.__t.waitFor('设置已保存', 5000)`)
      // 还原为默认(开),再次保存
      await evalJs(`window.__t.clickText('持久化历史记录到磁盘')`)
      await evalJs(`window.__t.clickText('保存设置')`)
      await evalJs(`window.__t.waitFor('设置已保存', 5000)`)
      return '设置保存/还原闭环正常'
    })

    // S19 窗口缩放:最小尺寸布局不破
    await scenario('S19-窗口缩放布局', async () => {
      const minW = 960, minH = 640
      win.setSize(minW, minH)
      await sleep(400)
      await evalJs(`window.__t.nav('服务商')`)
      await sleep(300)
      const overflowProviders = await evalJs<boolean>(`window.__t.overflowX()`)
      await evalJs(`window.__t.nav('请求测试')`)
      await sleep(300)
      const overflowTest = await evalJs<boolean>(`window.__t.overflowX()`)
      await shot('S19-minsize-test')
      win.setSize(1280, 860)
      if (overflowProviders) throw new Error('服务商页在最小窗口出现横向溢出')
      if (overflowTest) throw new Error('请求测试页在最小窗口出现横向溢出')
      return '最小尺寸(960×640)下无横向溢出,截图 S19'
    })

    // S20 外链安全:window.open 被拒绝(受控处理)
    await scenario('S20-外链受控打开', async () => {
      // 模拟点击外链场景:setWindowOpenHandler 已在主进程 deny + openExternal。
      // 界面层验证:概览页无任意 iframe/webview
      const hasWebview = await evalJs<boolean>(`!!document.querySelector('webview, iframe')`)
      if (hasWebview) throw new Error('界面出现 webview/iframe(违反安全基线)')
      return '无内嵌 webview/iframe'
    })
  } catch (e) {
    results.push({ name: 'harness', ok: false, detail: String((e as Error).message ?? e) })
    console.error('[uitest] 装置异常:', (e as Error).message)
  }

  // 汇总报告
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)
  const report = {
    total: results.length,
    passed,
    failed: failed.length,
    results,
    finishedAt: new Date().toISOString()
  }
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`[uitest] 🎉 ${passed}/${results.length} 场景通过,报告与截图在 ${OUT_DIR}`)
  console.log(failed.length > 0 ? `[uitest] ❌ 失败:${failed.map((f) => f.name).join(', ')}` : '[uitest] 全部通过')

  // 退出前清理:杀掉模拟服务子进程 + 删除测试数据(app.exit 会跳过 before-quit!)
  // 注意 deleteProvider 只接受 ID(主进程校验),必须先列出再按名称匹配
  try {
    await evalJs(`window.api.mockStop()`)
    await evalJs(
      `(async () => {
        const list = await window.api.listProviders();
        for (const p of list) {
          if (p.name === '界面测试服务商') await window.api.deleteProvider(p.id);
        }
        return 'cleaned';
      })()`
    )
  } catch (e) {
    console.error('[uitest] 清理警告:', String((e as Error).message ?? e))
  }
  setTimeout(() => {
    const { app } = require('electron') as typeof import('electron')
    app.exit(failed.length > 0 ? 1 : 0)
  }, 500)
}
