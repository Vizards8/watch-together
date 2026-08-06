// 复现「只有我一个人，却提示对方已加入」的问题。
// 假设：连接没有优雅关闭（直接销毁，不发 close 帧）时，服务端 sessions 里留下僵尸连接，
// 导致下一个人进来时 count >= 2，前端就误报"对方已加入"。
//
// 跑法：node test-ghost.mjs [wss地址]

import { execFileSync } from 'node:child_process';

const WSS = process.argv[2] || 'wss://watch-together.laphi.workers.dev';
// 用一个独立房间，避免干扰真实使用
const ROOM = 'ghost-test-' + process.pid;

const script = `
(async () => {
  const BASE = ${JSON.stringify(WSS)};
  const ROOM = ${JSON.stringify(ROOM)};
  const out = [];
  const wait = ms => new Promise(r => setTimeout(r, ms));

  function open(tag) {
    const ws = new WebSocket(BASE + '?room=' + encodeURIComponent(ROOM) + '&pass=0323');
    ws.inbox = [];
    ws.tag = tag;
    ws.addEventListener('message', e => ws.inbox.push(JSON.parse(e.data)));
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('超时')), 15000);
      ws.addEventListener('open', () => { clearTimeout(t); res(ws); });
      ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('出错')); });
    });
  }

  try {
    // 第一个人进来，应该看到 count=1
    const a = await open('A');
    await wait(600);
    out.push(['第一个人进房间 count=1',
      a.inbox.length === 1 && a.inbox[0].count === 1,
      JSON.stringify(a.inbox)]);

    // 模拟"没有优雅关闭"：不调用 close()，直接让引用失效。
    // 真实场景 = 关标签页 / 切集 / 断网，客户端来不及发 close 帧。
    // 这里用 close(1006 不可用) 无法模拟，退而用直接 close 做对照组，
    // 另开一路用 terminate 语义（浏览器里没有，只能靠不 close 然后丢弃）
    a.onclose = null;
    a.onmessage = null;
    // 故意不 close，保留连接开着，然后新开一个客户端
    const b = await open('B');
    await wait(800);

    // B 是第二个真实连接，看到 2 是对的
    out.push(['A 还连着时 B 进来看到 count=2',
      b.inbox.some(m => m.count === 2),
      JSON.stringify(b.inbox)]);

    // 现在优雅关闭 A，B 应该收到 count=1
    const beforeClose = b.inbox.length;
    a.close();
    await wait(1200);
    out.push(['A 优雅关闭后 B 看到 count=1',
      b.inbox.slice(beforeClose).some(m => m.count === 1),
      JSON.stringify(b.inbox.slice(beforeClose))]);

    // 关键测试：B 自己发 hello，会不会收到自己的 hello
    const beforeHello = b.inbox.length;
    b.send(JSON.stringify({ type: 'hello', name: '我' }));
    await wait(800);
    const echoed = b.inbox.slice(beforeHello).filter(m => m.type === 'hello');
    out.push(['自己发的 hello 不会回显给自己',
      echoed.length === 0,
      '收到 ' + echoed.length + ' 条: ' + JSON.stringify(echoed)]);

    b.close();
    await wait(300);

    // 房间应该空了。重新进一个，必须看到 count=1
    const c = await open('C');
    await wait(900);
    const firstPresence = c.inbox.find(m => m.type === 'presence');
    out.push(['所有人走后重新进入 count=1（无僵尸连接）',
      firstPresence && firstPresence.count === 1,
      JSON.stringify(c.inbox)]);
    c.close();
  } catch (e) {
    out.push(['执行出错', false, e.message]);
  }
  return JSON.stringify(out);
})()
`;

execFileSync('agent-browser', ['open', WSS.replace('wss://', 'https://')], { stdio: 'ignore' });
execFileSync('agent-browser', ['wait', '--load', 'networkidle'], { stdio: 'ignore' });
const raw = execFileSync('agent-browser', ['eval', script], { encoding: 'utf8', timeout: 120000 });

const m = raw.match(/\[\[.*\]\]/s);
if (!m) { console.error('解析失败:\n' + raw); process.exit(1); }
let results;
try {
  results = JSON.parse(JSON.parse('"' + m[0].replace(/"/g, '\\"').replace(/\\\\"/g, '\\"') + '"'));
} catch {
  results = JSON.parse(m[0].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
}
for (const [name, ok, detail] of results) {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}
const failed = results.filter(r => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
