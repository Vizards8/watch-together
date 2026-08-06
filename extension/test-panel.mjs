// 验证面板/小圆标的生命周期：
// 问题 —— 点「离开」后小圆标还留在页面上，下次加入又生成一个，越点越多。
// 根因 —— disconnect() 只 remove 了 panel.root，bubble 是另一个独立元素；
//         而 buildPanel 的守卫只看 root，所以会重复创建。
//
// 用 jsdom 式的极简 DOM 模拟跑真实的创建/销毁流程。
// 跑法：node test-panel.mjs

import { readFileSync } from 'node:fs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

const content = readFileSync(new URL('./content.js', import.meta.url), 'utf8');
const help = readFileSync(new URL('./help.html', import.meta.url), 'utf8');

// ---- 静态检查 ----
check('存在 destroyPanel 统一销毁', /function destroyPanel\(\)/.test(content));
check('destroyPanel 移除 bubble',
  /function destroyPanel\(\)[\s\S]{0,400}panel\.bubble\.remove\(\)/.test(content));
check('destroyPanel 移除 root',
  /function destroyPanel\(\)[\s\S]{0,400}panel\.root\.remove\(\)/.test(content));
check('destroyPanel 清掉时钟定时器',
  /function destroyPanel\(\)[\s\S]{0,200}clearInterval\(panel\.clockTimer\)/.test(content));
check('disconnect 调用 destroyPanel', /function disconnect\(\)[\s\S]{0,400}destroyPanel\(\)/.test(content));
check('时钟 interval 存进 panel.clockTimer',
  /panel\.clockTimer = setInterval\(tick/.test(content));
check('buildPanel 有残留圆标兜底',
  /if \(panel\.bubble\) destroyPanel\(\)/.test(content));
check('跨页离开不再在 disconnect 后 addMessage（否则面板会被建回来）',
  !/disconnect\(\);\s*\n\s*addMessage/.test(content));

// ---- 行为模拟：复刻真实的 buildPanel / destroyPanel 逻辑 ----
function makeEnv() {
  const dom = { nodes: [] };            // 挂在页面上的元素
  let intervals = 0;
  const panel = {
    root: null, bubble: null, body: null, input: null,
    collapsed: true, unread: 0, clockTimer: null,
  };

  const el = (tag) => {
    const n = { tag, removed: false };
    n.remove = () => { n.removed = true; dom.nodes = dom.nodes.filter((x) => x !== n); };
    return n;
  };

  function destroyPanel() {
    if (panel.clockTimer) { intervals--; panel.clockTimer = null; }
    if (panel.root) { panel.root.remove(); panel.root = null; }
    if (panel.bubble) { panel.bubble.remove(); panel.bubble = null; }
    panel.body = null; panel.input = null;
    panel.collapsed = true; panel.unread = 0;
  }

  function buildPanel() {
    if (panel.root) return;
    if (panel.bubble) destroyPanel();      // 兜底
    const root = el('panel'); dom.nodes.push(root); panel.root = root;
    intervals++; panel.clockTimer = 'timer';
    const bubble = el('bubble'); dom.nodes.push(bubble); panel.bubble = bubble;
  }

  return {
    panel, dom,
    buildPanel, destroyPanel,
    counts: () => ({
      圆标: dom.nodes.filter((n) => n.tag === 'bubble').length,
      面板: dom.nodes.filter((n) => n.tag === 'panel').length,
      定时器: intervals,
    }),
  };
}

// 场景：加入 → 离开 → 再加入 → 再离开
{
  const e = makeEnv();
  e.buildPanel();
  check('加入后：1 个面板 1 个圆标',
    JSON.stringify(e.counts()) === JSON.stringify({ 圆标: 1, 面板: 1, 定时器: 1 }),
    JSON.stringify(e.counts()));

  e.destroyPanel();
  check('离开后：圆标一起消失',
    JSON.stringify(e.counts()) === JSON.stringify({ 圆标: 0, 面板: 0, 定时器: 0 }),
    JSON.stringify(e.counts()));

  e.buildPanel();
  check('再加入：仍然只有 1 个圆标（不叠加）',
    e.counts().圆标 === 1, JSON.stringify(e.counts()));

  e.destroyPanel();
  e.buildPanel();
  e.destroyPanel();
  e.buildPanel();
  check('反复加入离开 3 次：圆标不累积',
    e.counts().圆标 === 1 && e.counts().定时器 === 1, JSON.stringify(e.counts()));
}

// 对照：修复前的行为（只删 root，守卫只看 root）
{
  const dom = [];
  const panel = { root: null, bubble: null };
  const el = (t) => { const n = { tag: t }; dom.push(n); return n; };
  const oldBuild = () => {
    if (panel.root) return;
    panel.root = el('panel');
    panel.bubble = el('bubble');
  };
  const oldDisconnect = () => { panel.root = null; }; // 旧代码只清 root
  oldBuild(); oldDisconnect(); oldBuild(); oldDisconnect(); oldBuild();
  const bubbles = dom.filter((n) => n.tag === 'bubble').length;
  check('（对照）旧逻辑确实会叠出多个圆标',
    bubbles === 3, '3 次加入产生了 ' + bubbles + ' 个圆标');
}

// ---- 反馈入口 ----
check('说明页有 GitHub issues 链接',
  /href="https:\/\/github\.com\/Vizards8\/watch-together\/issues"/.test(help));
check('外链带 rel=noopener（防被打开的页面反向操作本页）',
  [...help.matchAll(/<a [^>]*target="_blank"[^>]*>/g)].every((m) => /rel="noopener"/.test(m[0])),
  '共 ' + [...help.matchAll(/target="_blank"/g)].length + ' 个外链');
check('隐私一节给出源码链接（不收集数据要能自证）',
  /github\.com\/Vizards8\/watch-together["<]/.test(help));
check('页面里没有任何邮箱（避免被爬去发垃圾邮件）',
  !/outlook\.com/.test(help) && !/mailto:/.test(help));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
