// 在真实视频页面上验证 frame 守卫：
// 问题现象 —— 一个人进房间却提示"对方已加入"、反复"加入/离开"刷屏。
// 根因 —— manifest 的 all_frames:true 让同源 iframe 也注入 content.js，各开一条 WebSocket。
// 修复 —— content.js 顶部的 isTopFrame 守卫，非顶层直接 return。
//
// 跑法：node test-frame-guard.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

const contentSrc = readFileSync(new URL('./content.js', import.meta.url), 'utf8');

// 静态检查：守卫必须在建立连接之前
const guardPos = contentSrc.indexOf('if (!isTopFrame) return;');
const wsPos = contentSrc.indexOf('new WebSocket(');
check('存在 isTopFrame 守卫', guardPos > 0);
check('守卫位置在建立 WebSocket 之前', guardPos > 0 && guardPos < wsPos,
  `守卫@${guardPos} < WebSocket@${wsPos}`);

const SITES = [
  ['腾讯视频', 'https://v.qq.com/x/cover/mzc00200mp8vo9b/g0047sxvz4a.html', /(^|\.)qq\.com$/],
  ['B站', 'https://www.bilibili.com/video/BV1GJ411x7h7', /(^|\.)bilibili\.com$/],
];

for (const [label, url, hostRe] of SITES) {
  try {
    execFileSync('agent-browser', ['open', url], { stdio: 'ignore', timeout: 90000 });
    execFileSync('agent-browser', ['wait', '--load', 'networkidle'], { stdio: 'ignore', timeout: 60000 });
    execFileSync('agent-browser', ['eval', 'new Promise(r => setTimeout(r, 9000))'], { stdio: 'ignore', timeout: 30000 });

    // 模拟 content.js 的注入判定：统计有多少个 frame 会执行到建立连接那一步
    const probe = `
    (() => {
      const hostRe = ${hostRe.toString()};
      // manifest 匹配的 frame（含顶层）
      let injected = 0;      // 会被注入 content.js 的 frame 数
      let wouldConnect = 0;  // 加了守卫后真正会建连接的 frame 数
      const detail = [];

      function consider(win, isTop) {
        let host;
        try { host = win.location.hostname; } catch { return; } // 跨域读不到 = 不会被注入
        if (!hostRe.test(host)) return;
        injected++;
        // 复刻 content.js 的守卫逻辑
        let isTopFrame;
        try { isTopFrame = win.top === win.self; } catch { isTopFrame = false; }
        if (isTopFrame) wouldConnect++;
        detail.push((isTop ? '[顶层] ' : '[iframe] ') + host + ' → ' + (isTopFrame ? '建连接' : '被守卫挡住'));
      }

      consider(window, true);
      for (let i = 0; i < window.frames.length; i++) consider(window.frames[i], false);

      // video 是否都在顶层（守卫成立的前提）
      let videoInFrames = 0;
      for (let i = 0; i < window.frames.length; i++) {
        try { videoInFrames += window.frames[i].document.querySelectorAll('video').length; } catch {}
      }

      return JSON.stringify({
        injected, wouldConnect, detail,
        顶层video: document.querySelectorAll('video').length,
        iframe内video: videoInFrames,
      });
    })()`;

    const raw = execFileSync('agent-browser', ['eval', probe], { encoding: 'utf8', timeout: 60000 });
    const m = raw.match(/\{.*\}/s);
    if (!m) { check(`${label} 探测`, false, '无法解析: ' + raw.slice(0, 120)); continue; }
    const r = JSON.parse(JSON.parse('"' + m[0].replace(/"/g, '\\"').replace(/\\\\"/g, '\\"') + '"'));

    check(`${label}：修复后只有 1 条连接`, r.wouldConnect === 1,
      `会被注入 ${r.injected} 个 frame，建连接 ${r.wouldConnect} 个`);
    if (r.injected > 1) {
      check(`${label}：确认存在重复注入（修复前的 bug 来源）`, true,
        r.detail.join('; '));
    }
    check(`${label}：video 都在顶层（守卫不会漏掉播放器）`,
      r.iframe内video === 0 && r.顶层video >= 1,
      `顶层 ${r.顶层video} 个，iframe 内 ${r.iframe内video} 个`);
  } catch (e) {
    check(`${label} 探测`, false, e.message.slice(0, 120));
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
