// 验证 serverUrl 的存取与迁移逻辑：
// 核心不变式 —— storage 里只在"用户自定义"时才有 serverUrl，
// 没有这一项就代表用内置默认。这样以后换服务器只改代码里的常量即可。
//
// 跑法：node test-storage.mjs

const DEFAULT_SERVER_URL = 'wss://watch-together.laphi.workers.dev';
const LEGACY_SERVER_URLS = [
  'wss://watch-together-production-d1c9.up.railway.app',
];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

// 模拟 chrome.storage.local
function makeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: (keys) => Object.fromEntries(
      keys.filter((k) => k in data).map((k) => [k, data[k]])
    ),
    set: (obj) => Object.assign(data, obj),
    remove: (k) => { delete data[k]; },
  };
}

// popup 点「加入房间」时的存储逻辑（对应 popup.js joinBtn）
function popupJoin(storage, inputValue) {
  const customUrl = inputValue.trim();
  const serverUrl = customUrl || DEFAULT_SERVER_URL;
  storage.set({ room: '我俩的小屋', pass: '0520', nick: '我', autoJoin: true });
  if (customUrl) storage.set({ serverUrl: customUrl });
  else storage.remove('serverUrl');
  return serverUrl; // 实际连接用的地址
}

// popup 打开时的回填逻辑（对应 popup.js 初始化）
function popupInit(storage) {
  const cfg = storage.get(['serverUrl', 'room', 'pass', 'nick']);
  if (cfg.serverUrl && LEGACY_SERVER_URLS.includes(cfg.serverUrl)) {
    storage.remove('serverUrl');
    cfg.serverUrl = null;
  }
  return { inputValue: cfg.serverUrl || '' }; // 输入框里显示什么
}

// content.js 打开视频页时的自动重连逻辑
function contentAutoJoin(storage) {
  const cfg = storage.get(['serverUrl', 'room', 'pass', 'nick', 'autoJoin']);
  if (cfg.serverUrl && LEGACY_SERVER_URLS.includes(cfg.serverUrl)) {
    storage.remove('serverUrl');
    cfg.serverUrl = null;
  }
  if (cfg.autoJoin && cfg.room) {
    return { connected: true, url: cfg.serverUrl || DEFAULT_SERVER_URL };
  }
  return { connected: false, url: null };
}

// ---- 场景 1：新用户，留空 ----
{
  const s = makeStorage();
  const used = popupJoin(s, '');
  check('留空加入 → 连默认地址', used === DEFAULT_SERVER_URL, used);
  check('留空加入 → storage 里不写 serverUrl',
    !('serverUrl' in s.data), JSON.stringify(s.data));
  check('留空加入 → 输入框仍留空', popupInit(s).inputValue === '');
  check('留空加入 → 自动重连用默认',
    contentAutoJoin(s).url === DEFAULT_SERVER_URL);
}

// ---- 场景 2：换服务器（这是之前的痛点）----
{
  const s = makeStorage();
  popupJoin(s, ''); // 用户用默认地址看过片

  // 现在假设我改了代码里的默认值，模拟成新常量
  const NEW_DEFAULT = 'wss://watch-together.newhost.workers.dev';
  const cfg = s.get(['serverUrl', 'room', 'autoJoin']);
  const urlAfterSwitch = cfg.serverUrl || NEW_DEFAULT;

  check('换服务器 → 只改代码常量即生效，无需迁移代码',
    urlAfterSwitch === NEW_DEFAULT, urlAfterSwitch);
}

// ---- 场景 3：自定义地址 ----
{
  const s = makeStorage();
  const custom = 'wss://my-own.workers.dev';
  const used = popupJoin(s, custom);
  check('填自定义 → 连自定义地址', used === custom, used);
  check('填自定义 → storage 里存下来', s.data.serverUrl === custom);
  check('填自定义 → 重开 popup 会回填', popupInit(s).inputValue === custom);
  check('填自定义 → 自动重连用自定义', contentAutoJoin(s).url === custom);

  // 再清空输入框，应该回到默认
  const used2 = popupJoin(s, '');
  check('自定义后清空 → 回落到默认', used2 === DEFAULT_SERVER_URL, used2);
  check('自定义后清空 → storage 里的 serverUrl 被删',
    !('serverUrl' in s.data), JSON.stringify(s.data));
}

// ---- 场景 4：老用户迁移（storage 里是旧 railway 地址）----
{
  const s = makeStorage({
    serverUrl: LEGACY_SERVER_URLS[0],
    room: '我俩的小屋',
    pass: '0520',
    autoJoin: true,
  });

  // 情况 A：直接打开视频页（不点插件图标），走 content.js
  const r = contentAutoJoin(s);
  check('老用户直接开视频页 → 自动连到新默认地址',
    r.connected && r.url === DEFAULT_SERVER_URL, r.url);
  check('老用户直接开视频页 → 旧地址已从 storage 清掉',
    !('serverUrl' in s.data), JSON.stringify(s.data));

  // 情况 B：先点插件图标，走 popup
  const s2 = makeStorage({ serverUrl: LEGACY_SERVER_URLS[0], room: '房', autoJoin: true });
  check('老用户点插件图标 → 输入框不显示旧地址',
    popupInit(s2).inputValue === '');
  check('老用户点插件图标 → 旧地址已清掉',
    !('serverUrl' in s2.data), JSON.stringify(s2.data));
}

// ---- 场景 5：房间号等其他配置不受影响 ----
{
  const s = makeStorage();
  popupJoin(s, '');
  check('房间号/密码/昵称照常保存',
    s.data.room === '我俩的小屋' && s.data.pass === '0520' && s.data.nick === '我',
    JSON.stringify(s.data));
  check('没有 room 时不自动重连',
    contentAutoJoin(makeStorage({ autoJoin: true })).connected === false);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
