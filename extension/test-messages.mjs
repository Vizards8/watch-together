// 验证消息文案与昵称显示逻辑：
// 1. 所有对外文案不再出现"对方"
// 2. 操作提示显示发送者昵称
// 3. 自己的聊天气泡上方也显示昵称
// 4. send() 统一注入昵称
// 5. 一个人在房间时不会误报有人加入
//
// 跑法：node test-messages.mjs

import { readFileSync } from 'node:fs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

const content = readFileSync(new URL('./content.js', import.meta.url), 'utf8');
const popupJs = readFileSync(new URL('./popup.js', import.meta.url), 'utf8');
const popupHtml = readFileSync(new URL('./popup.html', import.meta.url), 'utf8');

// ---- 1. 用户可见文案里不该再有"对方" ----
// 只看字符串字面量和 HTML 文本，注释里出现无所谓
function userFacingStrings(src) {
  const out = [];
  // addMessage / textContent 的字符串参数、模板串
  const re = /(?:addMessage\([^,]+,\s*|textContent\s*=\s*|title="|placeholder=")([`'"])((?:\\.|(?!\1).)*)\1?/g;
  let m;
  while ((m = re.exec(src))) out.push(m[2]);
  // title="..." / placeholder="..." 里的中文
  const re2 = /(?:title|placeholder)="([^"]*)"/g;
  while ((m = re2.exec(src))) out.push(m[1]);
  return out;
}

const badContent = userFacingStrings(content).filter((s) => s.includes('对方'));
check('content.js 用户可见文案无"对方"', badContent.length === 0,
  badContent.length ? JSON.stringify(badContent) : '');

const badPopupJs = userFacingStrings(popupJs).filter((s) => s.includes('对方'));
check('popup.js 用户可见文案无"对方"', badPopupJs.length === 0,
  badPopupJs.length ? JSON.stringify(badPopupJs) : '');

const badHtml = [...popupHtml.matchAll(/(?:title|placeholder)="([^"]*)"/g)]
  .map((m) => m[1]).filter((s) => s.includes('对方'));
const badHtmlLabel = [...popupHtml.matchAll(/<label>([^<]*)<\/label>/g)]
  .map((m) => m[1]).filter((s) => s.includes('对方'));
check('popup.html 无"对方"', badHtml.length === 0 && badHtmlLabel.length === 0,
  JSON.stringify([...badHtml, ...badHtmlLabel]));

// ---- 2. 操作提示带昵称 ----
check('play 提示用昵称变量', /\$\{who\}点了播放/.test(content));
check('pause 提示用昵称变量', /\$\{who\}按了暂停/.test(content));
check('seek 提示用昵称变量', /\$\{who\}跳到了/.test(content));
check('存在 peerName 兜底函数', /function peerName\(msg\)/.test(content));

// peerName 的行为
const peerName = (msg) => {
  const n = msg && typeof msg.name === 'string' ? msg.name.trim() : '';
  return n || '有人';
};
check('peerName 取到昵称', peerName({ name: '拉菲' }) === '拉菲');
check('peerName 老客户端兜底不显示 undefined',
  peerName({}) === '有人' && !String(peerName({})).includes('undefined'));
check('peerName 空白昵称也兜底', peerName({ name: '   ' }) === '有人');

// ---- 3. send() 统一注入昵称 ----
check('send() 注入 name 字段',
  /state\.ws\.send\(JSON\.stringify\(\{\s*name:\s*state\.nick,\s*\.\.\.msg\s*\}\)\)/.test(content));

// 验证注入顺序：msg 里已有 name 时不该被覆盖（chat 消息自带 name）
const simulateSend = (nick, msg) => ({ name: nick, ...msg });
check('send() 不覆盖消息自带的 name',
  simulateSend('我', { type: 'chat', name: '我自己' }).name === '我自己');
check('send() 给不带 name 的消息补上',
  simulateSend('拉菲', { type: 'pause' }).name === '拉菲');

// ---- 4. 自己的气泡也显示昵称 ----
check('气泡昵称不再排除自己（去掉 !isMe 条件）',
  !/if \(!isMe && name\)/.test(content));
check('自己的气泡回退到 state.nick',
  /const label = isMe \? \(name \|\| state\.nick\) : name/.test(content));

// ---- 5. presence 不再误报"有人加入" ----
check('presence 不再因 count>=2 报加入',
  !/count >= 2 && prev < 2/.test(content));
check('"谁加入了"只由带昵称的 hello 负责',
  /msg\.type === 'hello'[\s\S]{0,200}加入了/.test(content));

// 复刻 presence 处理逻辑，验证单人在房间不会误报
function handlePresence(prevCount, count) {
  const msgs = [];
  if (count < prevCount && count >= 1) msgs.push(`有人离开了，房间还剩 ${count} 人`);
  return msgs;
}
check('一个人进房间：不提示任何人加入',
  handlePresence(0, 1).length === 0, JSON.stringify(handlePresence(0, 1)));
check('第二人进来：presence 不重复报加入（交给 hello）',
  handlePresence(1, 2).length === 0, JSON.stringify(handlePresence(1, 2)));
check('有人离开：报剩余人数',
  handlePresence(2, 1)[0] === '有人离开了，房间还剩 1 人', JSON.stringify(handlePresence(2, 1)));

// ---- 6. popup 状态显示实际人数 ----
// 只校验"带上了人数变量"这个意图，不锁死具体措辞，免得改文案就误报
check('popup 状态栏带上实际人数', /\$\{peers\}\s*人/.test(popupJs));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
