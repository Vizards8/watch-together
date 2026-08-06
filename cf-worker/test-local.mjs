// 本地验证脚本：模拟两个插件客户端，检查转发 / presence / 密码隔离
// 跑法：先 npx wrangler dev --port 8787 --local，另开一个终端 node test-local.mjs

const BASE = 'ws://localhost:8787';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

function open(room, pass) {
  const ws = new WebSocket(
    `${BASE}?room=${encodeURIComponent(room)}&pass=${encodeURIComponent(pass)}`
  );
  ws.inbox = [];
  ws.addEventListener('message', (e) => ws.inbox.push(JSON.parse(e.data)));
  return new Promise((res, rej) => {
    ws.addEventListener('open', () => res(ws));
    ws.addEventListener('error', rej);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 健康检查
const health = await fetch('http://localhost:8787').then((r) => r.text());
check('HTTP 健康检查', health.includes('running'), health.trim());

// 场景 1：同房间同密码，双向转发
const me = await open('我俩的小屋', '0520');
const her = await open('我俩的小屋', '0520');
await wait(400);

check(
  'presence 报出 2 人',
  me.inbox.some((m) => m.type === 'presence' && m.count === 2),
  JSON.stringify(me.inbox)
);

me.send(JSON.stringify({ type: 'pause', time: 123.4 }));
await wait(300);
check(
  '我按暂停，对方收到',
  her.inbox.some((m) => m.type === 'pause' && m.time === 123.4)
);
check(
  '不回发给自己',
  !me.inbox.some((m) => m.type === 'pause')
);

her.send(JSON.stringify({ type: 'chat', text: '这段好看', name: '她' }));
await wait(300);
check(
  '对方发聊天，我收到',
  me.inbox.some((m) => m.type === 'chat' && m.text === '这段好看')
);

// 心跳 sync（你的 content.js 每 4 秒发一次）
her.send(JSON.stringify({ type: 'sync', time: 456.7, paused: false }));
await wait(300);
check(
  'sync 心跳转发正常',
  me.inbox.some((m) => m.type === 'sync' && m.time === 456.7)
);

// 场景 2：密码不对 —— 应该进不了同一个房间
const stranger = await open('我俩的小屋', 'wrong-pass');
await wait(400);
const before = her.inbox.length;
stranger.send(JSON.stringify({ type: 'chat', text: '我是陌生人' }));
await wait(400);
check(
  '密码不对的人收不到我们的消息',
  !her.inbox.slice(before).some((m) => m.text === '我是陌生人')
);
check(
  '陌生人自己房间里只有 1 人',
  stranger.inbox.filter((m) => m.type === 'presence').every((m) => m.count === 1),
  JSON.stringify(stranger.inbox)
);

// 场景 3：断开后 presence 下降
const beforeClose = me.inbox.length;
her.close();
await wait(600);
check(
  '对方离开后 presence 变 1',
  me.inbox.slice(beforeClose).some((m) => m.type === 'presence' && m.count === 1),
  JSON.stringify(me.inbox.slice(beforeClose))
);

// 场景 4：非法 JSON 不应该炸掉连接
me.send('这不是 json');
await wait(300);
check('收到非法消息后连接仍存活', me.readyState === 1);

me.close();
stranger.close();
await wait(200);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
