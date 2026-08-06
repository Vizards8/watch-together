// 真正执行 content.js 的启动路径，抓运行时错误。
//
// 起因：BUBBLE_SIZE 之外的几个 const（COLLAPSED_KEY / ANCHOR_KEY 等）曾声明在
// buildPanel 之后。函数声明会提升、const 不会，于是 buildPanel() 里调
// loadCollapsed() 读 COLLAPSED_KEY 时抛 ReferenceError（TDZ），面板建不出来，
// 表现就是"点了加入房间没反应"。这种错误 node --check 和正则检查都发现不了，
// 必须真的跑一遍。
//
// 跑法：node test-runtime.mjs

import { readFileSync } from 'node:fs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

const src = readFileSync(new URL('./content.js', import.meta.url), 'utf8');

// ---- 极简 DOM / chrome / localStorage 桩 ----
function makeSandbox() {
  const store = {};
  const listeners = {};

  const el = (tag = 'div') => {
    const n = {
      tagName: tag.toUpperCase(),
      style: {}, children: [], dataset: {},
      _attrs: {}, _listeners: {},
      innerHTML: '', textContent: '', title: '', placeholder: '', value: '',
      offsetWidth: tag === 'div' ? 260 : 44,
      offsetHeight: tag === 'div' ? 320 : 44,
      scrollTop: 0, scrollHeight: 0,
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      addEventListener(t, f) { (this._listeners[t] ||= []).push(f); },
      removeEventListener() {},
      setAttribute(k, v) { this._attrs[k] = v; },
      getAttribute(k) { return this._attrs[k]; },
      querySelector() { return el('span'); },
      querySelectorAll() { return []; },
      getBoundingClientRect() {
        const left = parseFloat(this.style.left) || 0;
        const top = parseFloat(this.style.top) || 0;
        return {
          left, top,
          right: left + this.offsetWidth,
          bottom: top + this.offsetHeight,
          width: this.offsetWidth, height: this.offsetHeight,
        };
      },
    };
    return n;
  };

  const documentElement = el();
  const document = {
    documentElement,
    fullscreenElement: null,
    webkitFullscreenElement: null,
    createElement: el,
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    removeEventListener() {},
  };

  const win = {
    innerWidth: 1280, innerHeight: 577,
    document,
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    removeEventListener() {},
    location: { href: 'https://www.bilibili.com/video/BV1x' },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    WebSocket: class {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        WS_URLS.push(url);
        // 异步触发 open，模拟真实连接
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.();
        }, 0);
      }
      send() {}
      close() { this.readyState = 3; this.onclose?.(); }
    },
    crypto: { randomUUID: () => 'uuid-test-1234' },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, TextDecoder,
  };
  win.top = win;
  win.self = win;

  const WS_URLS = [];
  const chromeStub = {
    runtime: {
      onMessage: { addListener(f) { chromeStub._onMessage = f; } },
      // 真实 API 返回 Promise，content.js 里会 .catch()，桩必须也返回
      sendMessage: () => Promise.resolve(),
      getURL: (p) => 'chrome-extension://test/' + p,
      lastError: null,
    },
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
            if (k in store) out[k] = JSON.parse(store['__' + k] ?? 'null') ?? store[k];
          });
          cb?.(out);
        },
        set(obj, cb) {
          Object.entries(obj).forEach(([k, v]) => {
            store[k] = v;
            store['__' + k] = JSON.stringify(v);
          });
          cb?.();
        },
        remove(k, cb) { delete store[k]; delete store['__' + k]; cb?.(); },
      },
      onChanged: { addListener() {} },
    },
  };

  return { win, document, chromeStub, WS_URLS, listeners, store };
}

// ---- 执行 content.js ----
let runError = null;
let sandbox;
try {
  sandbox = makeSandbox();
  const fn = new Function(
    'window', 'document', 'chrome', 'localStorage', 'crypto',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'TextDecoder', 'WebSocket', 'console',
    src
  );
  fn(
    sandbox.win, sandbox.document, sandbox.chromeStub,
    sandbox.win.localStorage, sandbox.win.crypto,
    setTimeout, clearTimeout, setInterval, clearInterval,
    TextDecoder, sandbox.win.WebSocket,
    { log() {}, warn() {}, error() {} }
  );
} catch (e) {
  runError = e;
}

check('content.js 能无错加载', !runError,
  runError ? `${runError.constructor.name}: ${runError.message}` : '');

// ---- 走一遍 join 流程，确认面板真的建起来 ----
if (!runError) {
  const handler = sandbox.chromeStub._onMessage;
  check('注册了消息监听（popup 的 join 才有人接）', typeof handler === 'function');

  if (typeof handler === 'function') {
    let replied = null;
    let threw = null;
    try {
      handler(
        { type: 'join', serverUrl: 'wss://x.test', room: '0323', pass: '0323', nick: '我' },
        {},
        (r) => { replied = r; }
      );
    } catch (e) {
      threw = e;
    }
    check('处理 join 消息不抛错', !threw,
      threw ? `${threw.constructor.name}: ${threw.message}` : '');
    check('join 回了 ok（popup 靠这个判断是否成功）',
      replied?.ok === true, JSON.stringify(replied));

    // 等异步的 ensureClientId → connect → onopen 跑完
    await new Promise((r) => setTimeout(r, 60));

    check('确实发起了 WebSocket 连接',
      sandbox.WS_URLS.length > 0, sandbox.WS_URLS[0] || '(没有任何连接)');
    if (sandbox.WS_URLS.length) {
      const u = sandbox.WS_URLS[0];
      check('连接 URL 带上 room / pass / client',
        /room=0323/.test(u) && /pass=0323/.test(u) && /client=[^&]+/.test(u), u);
    }

    // 面板应该已经挂到 documentElement 下（onopen 里 buildPanel）
    const mounted = sandbox.document.documentElement.children.length;
    check('连上后面板已挂到页面上（这就是"没出现面板"那个 bug）',
      mounted > 0, `documentElement 下有 ${mounted} 个元素`);
  }
}

// ---- 静态兜底：常量声明集中在文件靠前处 ----
// 真正的 TDZ 风险靠上面"能否加载 + 能否走完 join"来兜；这里只做个位置约定检查，
// 避免常量散落到用它的函数后面。注释里出现同名词不算引用，所以先剥掉注释。
{
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const bad = [];
  for (const k of ['ANCHOR_KEY', 'COLLAPSED_KEY', 'BUBBLE_SIZE', 'PANEL_H_GUESS', 'BOTTOM_GAP']) {
    const decl = stripped.indexOf(`const ${k}`);
    if (decl < 0) { bad.push(`${k} 未声明`); continue; }
    // 找声明之前是否有引用
    const before = stripped.slice(0, decl);
    if (new RegExp(`\\b${k}\\b`).test(before)) bad.push(`${k} 在声明前被引用`);
  }
  check('常量都声明在使用之前', bad.length === 0, bad.join('; '));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
