// 验证「离开」的跨标签页行为与说明入口：
// 问题 —— popup 只给当前标签页发 leave，其他视频页还连着，它们推来的"已连接"
//         会把按钮闪回"离开"，看起来就是要点两次。
// 修复 —— autoJoin=false 作为跨页信号（content.js 监听 storage 变更各自断开），
//         外加 popup 端的 leaving 窗口挡掉断开过程中推来的状态。
//
// 跑法：node test-leave.mjs

import { readFileSync } from 'node:fs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

const content = readFileSync(new URL('./content.js', import.meta.url), 'utf8');
const popupJs = readFileSync(new URL('./popup.js', import.meta.url), 'utf8');
const popupHtml = readFileSync(new URL('./popup.html', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));

// ---- 1. 跨标签页离开 ----
check('content.js 监听 storage 变更', /storage\?\.onChanged\?\.addListener/.test(content));
check('监听到 autoJoin=false 就断开',
  /changes\.autoJoin[\s\S]{0,120}newValue === false[\s\S]{0,160}disconnect\(\)/.test(content));
check('popup 有 leaving 窗口', /let leaving = false/.test(popupJs));
check('leaving 期间忽略已连接状态',
  /if \(leaving && msg\.connected\) return/.test(popupJs));
check('未新增 tabs 权限（避免多一项审核说明）',
  !(manifest.permissions || []).includes('tabs'),
  JSON.stringify(manifest.permissions));

// ---- 加入后保留弹窗，展示连接状态 ----
// 曾经试过加入成功就自动关弹窗（为了不挡住页面面板），但用户点了「加入房间」
// 需要看到"已连接"的反馈，关掉反而不知道成没成。改为不关。
check('加入后不自动关闭弹窗（要给用户看到状态）',
  !/window\.close\(\)/.test(popupJs));
check('加入后渲染连接状态', /render\(await sendToContent\(\{ type: 'getStatus' \}\)\)/.test(popupJs));
check('连接是异步的，稍后再刷一次状态',
  /setTimeout\(async \(\) => render\(await sendToContent\(\{ type: 'getStatus' \}\)\)/.test(popupJs));

// 复刻 popup 的状态处理，模拟"两个视频页都连着，点离开"
function makePopup() {
  const st = { button: 'leave', leaving: false };
  return {
    st,
    clickLeave() {
      st.leaving = true;
      st.button = 'join';   // 立即切回"加入房间"
    },
    onStatus(msg) {
      if (st.leaving && msg.connected) return; // 挡掉还没断完的页面
      st.button = msg.connected ? 'leave' : 'join';
    },
    settle() { st.leaving = false; },
  };
}

{
  const p = makePopup();
  p.clickLeave();
  // 另一个标签页还没断完，推来"仍在连接"
  p.onStatus({ type: 'status', connected: true, peerCount: 2 });
  check('点离开后，其他页推来的"已连接"不会让按钮闪回',
    p.st.button === 'join', '按钮=' + p.st.button);

  // 它断开后推来"已断开"
  p.onStatus({ type: 'status', connected: false });
  check('全部断开后按钮停在"加入房间"', p.st.button === 'join', '按钮=' + p.st.button);

  // 窗口结束后，真正重新加入应该能正常反映
  p.settle();
  p.onStatus({ type: 'status', connected: true, peerCount: 2 });
  check('离开窗口结束后，重新加入能正常显示',
    p.st.button === 'leave', '按钮=' + p.st.button);
}

// 修复前的行为对照：没有 leaving 窗口就会闪回
{
  const st = { button: 'leave' };
  st.button = 'join';                                  // 点了离开
  const msg = { connected: true };
  st.button = msg.connected ? 'leave' : 'join';         // 其他页推来状态
  check('（对照）无 leaving 窗口时确实会闪回"离开"',
    st.button === 'leave', '这就是"要点两次"的原因');
}

// ---- 2. clientId 去重 ----
check('连接 URL 带上 client 参数', /&client=\$\{encodeURIComponent\(state\.clientId/.test(content));
check('存在 ensureClientId', /function ensureClientId\(cb\)/.test(content));
check('clientId 持久化到 storage', /set\?\.\(\{ clientId: state\.clientId \}\)/.test(content));
check('两条 connect 路径都先确保 clientId',
  (content.match(/ensureClientId\(connect\)/g) || []).length === 2,
  '找到 ' + (content.match(/ensureClientId\(connect\)/g) || []).length + ' 处');

// ---- 3. 使用说明 ----
check('存在 help.html', (() => {
  try { readFileSync(new URL('./help.html', import.meta.url)); return true; } catch { return false; }
})());
check('popup 有说明入口', /id="helpLink"[^>]*href="help\.html"/.test(popupHtml));
check('help.html 已声明为可访问资源',
  (manifest.web_accessible_resources || []).some(
    (r) => (r.resources || []).includes('help.html')));
check('面板首次连上提示说明（只提一次）',
  /helpShown/.test(content) && /addMessage\('sys', '第一次用？', 'help'\)/.test(content));
check('说明链接用 runtime.getURL（打包后路径才对）',
  /chrome\.runtime\.getURL\('help\.html'\)/.test(content));
check('sys 消息用 textContent 而非 innerHTML（不把内容当 HTML 解析）',
  /row\.textContent = text/.test(content) && !/row\.innerHTML/.test(content));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
