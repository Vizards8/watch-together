// 验证面板与小圆标共享位置（原地收放）：
// 问题 —— 面板和圆标各存一套位置，把面板拖到别处后点收起，圆标还在原来的角落，
//         看着就是"跳"了一下，而不是原地缩成一个点。
// 修复 —— 共用一个锚点（记右下角坐标），收起/展开时都按它摆放。
//
// 跑法：node test-anchor.mjs

import { readFileSync } from 'node:fs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

const content = readFileSync(new URL('./content.js', import.meta.url), 'utf8');
const help = readFileSync(new URL('./help.html', import.meta.url), 'utf8');

// ---- 静态检查 ----
check('旧的双份位置存储已移除',
  !/loadPanelPos|saveBubblePos|watchTogetherPanelPos|watchTogetherBubblePos/.test(content));
check('使用单一锚点 key', /ANCHOR_KEY = 'watchTogetherAnchor2'/.test(content));
check('换了 key，老用户的右下角锚点自动失效（语义已不同，沿用会错位）',
  /watchTogetherAnchor2/.test(content));
check('锚点存的是 right/top（对齐右上角，即收起按钮所在处）',
  /typeof a\?\.right === 'number' && typeof a\?\.top === 'number'/.test(content));
check('圆标尺寸提成常量，不和样式里写死值分开维护',
  /const BUBBLE_SIZE = 44/.test(content) && /width:\$\{BUBBLE_SIZE\}px/.test(content));
check('下方空间不足时改为向上展开',
  /top \+ h > window\.innerHeight[\s\S]{0,120}anchor\.top \+ bubbleH - h/.test(content));
// 两个拖动函数各自把结束位置写进共享锚点。按函数体切片检查，
// 不用大跨度正则（跨度写死了容易随代码增删误报）。
function bodyOf(name) {
  const i = content.indexOf(`function ${name}(`);
  if (i < 0) return '';
  // 截到下一个顶层 function 声明为止，够覆盖整个函数体
  const rest = content.slice(i + 1);
  const j = rest.indexOf('\n  function ');
  return j < 0 ? rest : rest.slice(0, j);
}
check('面板拖动写共享锚点',
  /saveAnchor\(a\.right, a\.top\)/.test(bodyOf('enableDrag')));
check('圆标拖动写共享锚点',
  /saveAnchor\(a\.right, a\.top\)/.test(bodyOf('enableBubbleDrag')));
// 只数调用点，排除 function saveAnchor 的定义本身
check('恰好两处拖动结束时写锚点',
  (content.match(/(?<!function )saveAnchor\(/g) || []).length === 2,
  '找到 ' + (content.match(/(?<!function )saveAnchor\(/g) || []).length + ' 处调用');
check('setCollapsed 按锚点摆放两者',
  /function setCollapsed[\s\S]{0,500}placeByAnchor\(panel\.bubble[\s\S]{0,120}placeByAnchor\(panel\.root/.test(content));
check('定位在 display 生效之后（隐藏元素量不到尺寸）',
  /display = collapsed[\s\S]{0,300}placeByAnchor/.test(content));
check('窗口 resize 会重排', /addEventListener\('resize'[\s\S]{0,200}placeByAnchor/.test(content));

// ---- 行为模拟 ----
// 复刻真实实现：锚点 = 元素右上角相对视口的位置
const VW = 1440, VH = 900;
const PANEL = { w: 260, h: 320 };
const BUBBLE = { w: 44, h: 44 };

function placeByAnchor(size, anchor, bubbleH, vw = VW, vh = VH) {
  let left = vw - anchor.right - size.w;
  left = Math.max(0, Math.min(left, vw - size.w));
  let top = anchor.top;
  if (bubbleH && top + size.h > vh) top = anchor.top + bubbleH - size.h;
  top = Math.max(0, Math.min(top, vh - size.h));
  return { left, top, right: left + size.w, bottom: top + size.h };
}
function anchorOf(rect, vw = VW) {
  return { right: Math.round(vw - rect.right), top: Math.round(rect.top) };
}

// 默认位置：面板底边离视口底 GAP，按视口算而不是写死 top
const GAP = 120;        // 与 content.js 的 BOTTOM_GAP 保持一致
const CTRL_H = 100;     // B站播放器控件区从底部往上的高度（实测）
function defaultAnchorJS(vh) {
  return { right: 24, top: Math.max(12, vh - GAP - PANEL.h) };
}

// 场景 1：把面板拖到左上，收起后圆标应出现在「—」按钮那一侧（右上角）
{
  const dragged = { left: 100, top: 80, right: 100 + PANEL.w, bottom: 80 + PANEL.h };
  const anchor = anchorOf(dragged);
  const bubble = placeByAnchor(BUBBLE, anchor);

  check('收起后圆标右上角与面板右上角重合（即收起按钮处）',
    bubble.right === dragged.right && bubble.top === dragged.top,
    `面板右上(${dragged.right},${dragged.top}) vs 圆标右上(${bubble.right},${bubble.top})`);

  // 关键对比：圆标该靠近「—」（面板顶部），而不是发送按钮（面板底部）
  const distToCollapseBtn = Math.abs(bubble.top - dragged.top);
  const distToSendBtn = Math.abs(bubble.top - dragged.bottom);
  check('圆标离收起按钮比离发送按钮近得多',
    distToCollapseBtn < distToSendBtn,
    `离「—」${distToCollapseBtn}px，离发送按钮 ${distToSendBtn}px`);

  const back = placeByAnchor(PANEL, anchor, BUBBLE.h);
  check('再展开面板回到拖动后的位置',
    back.left === dragged.left && back.top === dragged.top,
    `(${back.left},${back.top})`);
}

// 场景 2：拖动圆标后展开，面板从圆标处向下展开
{
  const bubbleAt = { left: 300, top: 200, right: 344, top2: 244 };
  const anchor = anchorOf({ right: 344, top: 200 });
  const panel = placeByAnchor(PANEL, anchor, BUBBLE.h);
  check('展开的面板右上角与圆标右上角重合',
    panel.right === 344 && panel.top === 200,
    `圆标右上(344,200) vs 面板右上(${panel.right},${panel.top})`);
  check('面板向下方展开且不越界',
    panel.bottom <= VH, `面板底 ${panel.bottom} ≤ ${VH}`);
}

// 场景 3：圆标在偏下位置时，面板改为向上展开（不被硬夹到别处）
{
  const anchor = { right: 24, top: VH - 100 };  // 圆标靠底部
  const panel = placeByAnchor(PANEL, anchor, BUBBLE.h);
  const bubble = placeByAnchor(BUBBLE, anchor);
  check('圆标靠底部时面板向上展开',
    panel.top < anchor.top, `面板 top=${panel.top} < 锚点 top=${anchor.top}`);
  check('向上展开时面板底边贴着圆标底边',
    Math.abs(panel.bottom - bubble.bottom) <= 1,
    `面板底 ${panel.bottom}，圆标底 ${bubble.bottom}`);
  check('向上展开后仍在视口内',
    panel.top >= 0 && panel.bottom <= VH,
    `(${panel.top}-${panel.bottom}) in 0-${VH}`);
}

// 场景 4：窗口变小后仍在视口内
{
  const anchor = defaultAnchorJS(400);
  const small = placeByAnchor(PANEL, anchor, BUBBLE.h, 500, 400);
  check('窗口缩到 500x400 时面板仍在视口内',
    small.left >= 0 && small.top >= 0 && small.right <= 500 && small.bottom <= 400,
    `(${small.left},${small.top})-(${small.right},${small.bottom})`);
}

// 场景 5：默认位置按视口算，各种屏幕都不被插件弹窗遮、也不压播放器控件
{
  // 覆盖从极矮到大屏，含 B站实测的 1280x577
  const cases = [[1280, 577], [1440, 700], [1440, 800], [1920, 1000], [1280, 450]];
  const bad = [];
  for (const [vw, vh] of cases) {
    const a = defaultAnchorJS(vh);
    const p = placeByAnchor(PANEL, a, BUBBLE.h, vw, vh);
    if (p.bottom > vh - CTRL_H) bad.push(`${vw}x${vh} 压控件(底=${p.bottom})`);
    if (p.top < 0 || p.bottom > vh) bad.push(`${vw}x${vh} 溢出`);
  }
  check('默认位置在各种视口下都躲开播放器控件、不溢出',
    bad.length === 0, bad.join('; ') || `测了 ${cases.length} 种视口`);

  // 面板底边始终离视口底 GAP，不是固定 top —— 固定像素在矮视口会被夹回上方
  const tall = placeByAnchor(PANEL, defaultAnchorJS(1000), BUBBLE.h, 1920, 1000);
  const short = placeByAnchor(PANEL, defaultAnchorJS(577), BUBBLE.h, 1280, 577);
  check('底部间距恒定（按视口算而非写死 top）',
    1000 - tall.bottom === 577 - short.bottom,
    `大屏离底 ${1000 - tall.bottom}，矮屏离底 ${577 - short.bottom}`);

  check('默认位置落在视口下半部分（避开右上角的插件弹窗）',
    defaultAnchorJS(800).top > 800 / 3, `800 高时 top=${defaultAnchorJS(800).top}`);
}

// 对照：修复前圆标对齐面板底部（发送按钮那侧），离刚点的「—」很远
{
  const panelAt = { left: 100, top: 80, right: 360, bottom: 400 };
  const oldBubbleTop = panelAt.bottom - BUBBLE.h;   // 旧逻辑：右下角对齐
  const newBubbleTop = panelAt.top;                 // 新逻辑：右上角对齐
  check('（对照）旧逻辑圆标落在面板底部，离「—」隔了一整个面板高',
    oldBubbleTop - newBubbleTop > 200,
    `旧 top=${oldBubbleTop}，新 top=${newBubbleTop}，差 ${oldBubbleTop - newBubbleTop}px`);
}

// ---- 默认展开 ----
check('建面板时按记住的状态决定收起与否', /setCollapsed\(loadCollapsed\(\)\)/.test(content));
check('默认展开（读不到偏好时返回 false）',
  /function loadCollapsed\(\)[\s\S]{0,200}return false/.test(content));
check('切换收起状态时持久化', /function setCollapsed[\s\S]{0,120}saveCollapsed\(collapsed\)/.test(content));
check('destroyPanel 不重置 collapsed（否则会覆盖用户偏好）',
  !/panel\.collapsed = true;/.test(content));
check('首次引导那套临时方案已撤掉',
  !/maybeIntroduce|pulseBubble|introShown|introTimer/.test(content));

// 复刻收起状态的读写，验证"默认展开、手动收起后保持"
{
  let store = null;
  const loadCollapsed = () => store === '1';
  const saveCollapsed = (c) => { store = c ? '1' : '0'; };

  check('第一次用：展开', loadCollapsed() === false);

  saveCollapsed(true);                       // 用户点了「—」
  check('手动收起后，下次仍是收起', loadCollapsed() === true);

  saveCollapsed(false);                      // 用户又点开圆标
  check('再展开后，下次是展开', loadCollapsed() === false);
}

// ---- 邮箱已移除 ----
check('说明页不再出现邮箱',
  !/outlook\.com/.test(help) && !/&#64;/.test(help));
check('反馈入口仍指向 GitHub',
  /github\.com\/Vizards8\/watch-together\/issues/.test(help));
check('无残留的 .dim 样式引用',
  !/class="dim"/.test(help));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
