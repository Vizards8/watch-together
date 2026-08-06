// 验证按 clientId 去重计数：
// 问题 —— 同一个人开两个视频页，各一条连接，服务端按连接数算就成了"2 人"。
// 修复 —— 连接时带 client=<浏览器级ID>，服务端按它去重。
//
// 跑法：node test-dedup.mjs [wss地址]

import { execFileSync } from 'node:child_process';

const WSS = process.argv[2] || 'wss://watch-together.laphi.workers.dev';

const script = `
(async () => {
  const BASE = ${JSON.stringify(WSS)};
  const out = [];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let seq = 0;
  const room = () => 'dedup-' + Math.floor(performance.now()) + '-' + (seq++);

  function open(r, client) {
    let u = BASE + '?room=' + encodeURIComponent(r) + '&pass=p';
    if (client !== null) u += '&client=' + encodeURIComponent(client);
    const ws = new WebSocket(u);
    ws.inbox = [];
    ws.addEventListener('message', e => ws.inbox.push(JSON.parse(e.data)));
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('超时')), 15000);
      ws.addEventListener('open', () => { clearTimeout(t); res(ws); });
      ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('出错')); });
    });
  }
  const lastCount = ws => {
    const p = ws.inbox.filter(m => m.type === 'presence').pop();
    return p ? p.count : null;
  };

  try {
    // 场景 1：同一个人开两个标签页 —— 应该算 1 人。
    // 注意：presence 是在 fetch 里、握手完成前广播的，所以刚建立的那条连接
    // 收不到自己触发的那条 presence。要看已在房间的连接（a1）收到的值。
    {
      const r = room();
      const a1 = await open(r, 'me-browser');
      await wait(600);
      const a2 = await open(r, 'me-browser');
      await wait(1200);
      out.push(['同一人开两个页面算作 1 人',
        lastCount(a1) === 1, 'a1 看到 ' + lastCount(a1) + ' 人']);
      a1.close(); a2.close(); await wait(400);
    }

    // 场景 2：两个人各一个页面 —— 应该算 2 人
    {
      const r = room();
      const me = await open(r, 'me-browser');
      const her = await open(r, 'her-browser');
      await wait(1000);
      out.push(['两个人各开一页算作 2 人',
        lastCount(me) === 2, '实际 ' + lastCount(me) + ' 人']);
      me.close(); her.close(); await wait(400);
    }

    // 场景 3：我开两页 + 她开一页 —— 应该算 2 人
    {
      const r = room();
      const a1 = await open(r, 'me-browser');
      const a2 = await open(r, 'me-browser');
      const her = await open(r, 'her-browser');
      await wait(1200);
      out.push(['我开两页+她一页算作 2 人',
        lastCount(her) === 2, '实际 ' + lastCount(her) + ' 人']);

      // 场景 4：我关掉其中一页，她那边人数不该变
      const before = her.inbox.length;
      a2.close();
      await wait(1200);
      const after = lastCount(her);
      out.push(['我关掉一个页面，人数仍是 2',
        after === 2, '实际 ' + after + ' 人，新增消息 ' + JSON.stringify(her.inbox.slice(before))]);
      a1.close(); her.close(); await wait(400);
    }

    // 场景 5：我的操作不该回到我自己的另一个标签页
    {
      const r = room();
      const a1 = await open(r, 'me-browser');
      const a2 = await open(r, 'me-browser');
      const her = await open(r, 'her-browser');
      await wait(1000);
      const a2Before = a2.inbox.length, herBefore = her.inbox.length;
      a1.send(JSON.stringify({ type: 'pause', time: 42, name: '我' }));
      await wait(1000);
      const gotByMyOtherTab = a2.inbox.slice(a2Before).some(m => m.type === 'pause');
      const gotByHer = her.inbox.slice(herBefore).some(m => m.type === 'pause' && m.time === 42);
      out.push(['我的操作不回到我自己的另一个标签页', !gotByMyOtherTab, '']);
      out.push(['我的操作正常送到对方', gotByHer, '']);
      a1.close(); a2.close(); her.close(); await wait(400);
    }

    // 场景 6：旧版客户端不带 client 参数，退化成按连接计数（不能崩）
    {
      const r = room();
      const o1 = await open(r, null);
      const o2 = await open(r, null);
      await wait(1000);
      out.push(['旧版客户端（无 client）仍能连、按连接计数',
        lastCount(o1) === 2, '实际 ' + lastCount(o1) + ' 人']);
      o1.close(); o2.close(); await wait(400);
    }

    // 场景 7：新旧混用不串味
    {
      const r = room();
      const neu = await open(r, 'new-browser');
      const old = await open(r, null);
      await wait(1000);
      out.push(['新旧客户端混用算作 2 人',
        lastCount(neu) === 2, '实际 ' + lastCount(neu) + ' 人']);
      neu.close(); old.close();
    }
  } catch (e) {
    out.push(['执行出错', false, e.message]);
  }
  return JSON.stringify(out);
})()
`;

execFileSync('agent-browser', ['open', WSS.replace('wss://', 'https://')], { stdio: 'ignore' });
execFileSync('agent-browser', ['wait', '--load', 'networkidle'], { stdio: 'ignore' });
const raw = execFileSync('agent-browser', ['eval', script], { encoding: 'utf8', timeout: 180000 });

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
process.exit(failed.length ? 1 : 0);
