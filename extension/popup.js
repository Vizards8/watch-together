// popup 逻辑：读写配置、向当前标签页的内容脚本发指令、显示连接状态

// 内嵌的默认中转服务地址。部署好后填这里，用户就不用手填了。
// 想临时换服务器：在 popup 的「高级设置」里填，会覆盖这个默认值。
const DEFAULT_SERVER_URL = 'wss://watch-together.laphi.workers.dev';

// 已废弃的旧中转地址。老用户的 chrome.storage 里存的是这些，
// 不清掉的话会被当成"用户自定义地址"继续用，换了服务也连不上对方。
const LEGACY_SERVER_URLS = [
  'wss://watch-together-production-d1c9.up.railway.app',
];

const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToContent(msg) {
  const tab = await activeTab();
  if (!tab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    return null; // 当前页面没注入内容脚本（不是三家平台）
  }
}

// 点了「离开」之后的短暂窗口。期间忽略其他标签页推来的"仍在连接"状态，
// 否则按钮会闪回"离开"，让人以为没点上。
let leaving = false;

function render(status) {
  const connected = status?.connected;
  $('dot').classList.toggle('on', !!connected);
  if (connected) {
    const peers = status.peerCount || 1;
    // 报实际人数，房间可能不止两个人
    $('statusText').textContent =
      peers >= 2
        ? `一起看着呢 · ${status.room} 房间 ${peers} 人 💕`
        : `连上了 · 等大家来…`;
    $('joinBtn').style.display = 'none';
    $('leaveBtn').style.display = 'block';
    $('chatHint').style.display = 'block';
  } else {
    $('statusText').textContent = '未连接';
    $('joinBtn').style.display = 'block';
    $('leaveBtn').style.display = 'none';
    $('chatHint').style.display = 'none';
  }
}

// 初始化：回填配置 + 查询当前状态
(async () => {
  const cfg = await chrome.storage.local.get(['serverUrl', 'room', 'pass', 'nick']);
  // 存的是已废弃的旧地址：删掉这一项，回落到 DEFAULT_SERVER_URL
  if (cfg.serverUrl && LEGACY_SERVER_URLS.includes(cfg.serverUrl)) {
    await chrome.storage.local.remove('serverUrl');
    cfg.serverUrl = null;
  }
  // storage 里有 serverUrl 就说明是用户自定义的，回填进高级设置；没有则留空走默认
  if (cfg.serverUrl) $('serverUrl').value = cfg.serverUrl;
  if (cfg.room) $('room').value = cfg.room;
  if (cfg.pass) $('pass').value = cfg.pass;
  if (cfg.nick) $('nick').value = cfg.nick;
  const status = await sendToContent({ type: 'getStatus' });
  render(status);
})();

$('joinBtn').addEventListener('click', async () => {
  // 地址：优先用高级设置里填的，没填就用内嵌默认
  const customUrl = $('serverUrl').value.trim();
  const serverUrl = customUrl || DEFAULT_SERVER_URL;
  const room = $('room').value.trim();
  const pass = $('pass').value;
  const nick = $('nick').value.trim() || '朋友';
  if (!room) {
    alert('请填写房间号');
    return;
  }
  if (!serverUrl || serverUrl.startsWith('__REPLACE')) {
    alert('还没配置中转服务地址，请在高级设置里填写');
    return;
  }
  // 只在用户真的填了自定义地址时才存 serverUrl。留空就把这一项删掉，
  // 让代码里的 DEFAULT_SERVER_URL 始终生效——否则默认值的快照会被存进 storage，
  // 以后换服务器改了代码里的默认值也会被这份旧快照盖掉。
  await chrome.storage.local.set({ room, pass, nick, autoJoin: true });
  if (customUrl) {
    await chrome.storage.local.set({ serverUrl: customUrl });
  } else {
    await chrome.storage.local.remove('serverUrl');
  }
  const res = await sendToContent({ type: 'join', serverUrl, room, pass, nick });
  if (!res) {
    alert('当前页面不是 B站/腾讯视频/爱奇艺，请先打开要看的视频页面');
    return;
  }
  // 不自动关弹窗：用户点了「加入房间」需要看到"已连接"的反馈，
  // 直接关掉反而不知道成没成。弹窗点页面任意处就会关，不碍事。
  render(await sendToContent({ type: 'getStatus' }));
  // 连接是异步的，首次 getStatus 可能还没连上，稍后再刷一次状态
  setTimeout(async () => render(await sendToContent({ type: 'getStatus' })), 800);
});

$('leaveBtn').addEventListener('click', async () => {
  // autoJoin=false 同时是跨标签页的"全体离开"信号：其他视频页监听 storage 变更，
  // 看到它就各自断开。只给当前页发 leave 的话，别的页还连着，它们推来的状态
  // 会把按钮又变回"离开"，看起来就是"点一次没反应、得点两次"。
  leaving = true;
  await chrome.storage.local.set({ autoJoin: false });
  await sendToContent({ type: 'leave' });
  render({ connected: false });
  // 放行稍晚一点，挡掉其他页在断开过程中推来的"仍在连接"状态
  setTimeout(() => { leaving = false; }, 1500);
});

// 接收内容脚本主动推来的状态更新
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'status') return;
  // 正在离开：忽略还没断完的页面推来的已连接状态，避免按钮闪回"离开"
  if (leaving && msg.connected) return;
  render(msg);
});
