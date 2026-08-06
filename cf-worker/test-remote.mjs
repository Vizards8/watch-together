// 线上验证脚本：在浏览器页面内跑，模拟两个插件客户端连真实 Worker。
// 之所以不用 node 直连：本机 LibreSSL 对 workers.dev 握手会被 reset（办公网 TLS 干扰），
// 但 Chrome 正常，所以把测试逻辑注入浏览器执行。
// 跑法：node test-remote.mjs

import { execFileSync } from 'node:child_process';

const WSS = process.argv[2] || 'wss://watch-together.laphi.workers.dev';

// 这段代码会被丢进浏览器里执行
const browserTest = `
(async () => {
  const BASE = ${JSON.stringify(WSS)};
  const out = [];
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  function open(room, pass) {
    const ws = new WebSocket(BASE + '?room=' + encodeURIComponent(room) + '&pass=' + encodeURIComponent(pass));
    ws.inbox = [];
    ws.addEventListener('message', e => ws.inbox.push(JSON.parse(e.data)));
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('连接超时')), 15000);
      ws.addEventListener('open', () => { clearTimeout(t); res(ws); });
      ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('连接出错')); });
    });
  }

  try {
    const t0 = Date.now();
    const me = await open('我俩的小屋', '0520');
    out.push(['握手成功（真实 wss）', true, (Date.now() - t0) + 'ms']);

    const her = await open('我俩的小屋', '0520');
    await wait(800);

    out.push(['presence 报出 2 人',
      me.inbox.some(m => m.type === 'presence' && m.count === 2),
      JSON.stringify(me.inbox)]);

    me.send(JSON.stringify({ type: 'pause', time: 123.4 }));
    await wait(700);
    out.push(['我按暂停，对方收到',
      her.inbox.some(m => m.type === 'pause' && m.time === 123.4), '']);
    out.push(['不回发给自己', !me.inbox.some(m => m.type === 'pause'), '']);

    her.send(JSON.stringify({ type: 'chat', text: '这段好看', name: '她' }));
    await wait(700);
    out.push(['对方发聊天，我收到',
      me.inbox.some(m => m.type === 'chat' && m.text === '这段好看'), '']);

    // 心跳 sync，content.js 每 4 秒发一次
    her.send(JSON.stringify({ type: 'sync', time: 456.7, paused: false }));
    await wait(700);
    out.push(['sync 心跳转发正常',
      me.inbox.some(m => m.type === 'sync' && m.time === 456.7), '']);

    // 测往返延迟，看跨境到边缘节点的实际表现
    const lat = [];
    for (let i = 0; i < 5; i++) {
      const before = her.inbox.length;
      const sent = Date.now();
      me.send(JSON.stringify({ type: 'sync', time: 900 + i, paused: false }));
      while (her.inbox.length === before && Date.now() - sent < 5000) await wait(5);
      lat.push(Date.now() - sent);
    }
    const avg = Math.round(lat.reduce((a, b) => a + b, 0) / lat.length);
    out.push(['转发延迟可接受（<800ms）', avg < 800, '平均 ' + avg + 'ms  明细 ' + lat.join('/')]);

    // 密码不对的人应该进不了同一个房间
    const stranger = await open('我俩的小屋', 'wrong-pass');
    await wait(800);
    const before = her.inbox.length;
    stranger.send(JSON.stringify({ type: 'chat', text: '我是陌生人' }));
    await wait(800);
    out.push(['密码不对的人收不到我们的消息',
      !her.inbox.slice(before).some(m => m.text === '我是陌生人'), '']);
    out.push(['陌生人房间里只有 1 人',
      stranger.inbox.filter(m => m.type === 'presence').every(m => m.count === 1),
      JSON.stringify(stranger.inbox)]);

    // 断开后 presence 下降
    const beforeClose = me.inbox.length;
    her.close();
    await wait(1200);
    out.push(['对方离开后 presence 变 1',
      me.inbox.slice(beforeClose).some(m => m.type === 'presence' && m.count === 1),
      JSON.stringify(me.inbox.slice(beforeClose))]);

    // 非法 JSON 不应该炸连接
    me.send('这不是 json');
    await wait(600);
    out.push(['收到非法消息后连接仍存活', me.readyState === 1, '']);

    me.close(); stranger.close();
  } catch (e) {
    out.push(['执行出错', false, e.message]);
  }

  return JSON.stringify(out);
})()
`;

// 必须先停在一个真实页面上，file:// 或 about:blank 下 WebSocket 会被拦
execFileSync('agent-browser', ['open', WSS.replace('wss://', 'https://')], { stdio: 'ignore' });
execFileSync('agent-browser', ['wait', '--load', 'networkidle'], { stdio: 'ignore' });

const raw = execFileSync('agent-browser', ['eval', browserTest], { encoding: 'utf8', timeout: 120000 });

const m = raw.match(/\[\[.*\]\]/s);
if (!m) {
  console.error('没能解析出结果，原始输出：\n' + raw);
  process.exit(1);
}

// agent-browser eval 会把返回的字符串再转义一层，先剥掉
let json = m[0];
if (json.includes('\\"')) json = JSON.parse('"' + json.replace(/"/g, '\\"').replace(/\\\\"/g, '\\"') + '"');

let results;
try {
  results = JSON.parse(json);
} catch {
  results = JSON.parse(m[0].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
}
for (const [name, ok, detail] of results) {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}
const failed = results.filter(r => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
