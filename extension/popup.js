// popup 逻辑：读写配置、向当前标签页的内容脚本发指令、显示连接状态

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

function render(status) {
  const connected = status?.connected;
  $('dot').classList.toggle('on', !!connected);
  if (connected) {
    const peers = status.peerCount || 1;
    $('statusText').textContent =
      peers >= 2 ? `已连接 · 对方在线（房间 ${status.room}）` : `已连接 · 等待对方加入…`;
    $('joinBtn').style.display = 'none';
    $('leaveBtn').style.display = 'block';
    $('chatRow').style.display = 'flex';
  } else {
    $('statusText').textContent = '未连接';
    $('joinBtn').style.display = 'block';
    $('leaveBtn').style.display = 'none';
    $('chatRow').style.display = 'none';
  }
}

// 初始化：回填配置 + 查询当前状态
(async () => {
  const cfg = await chrome.storage.local.get(['serverUrl', 'room', 'pass']);
  if (cfg.serverUrl) $('serverUrl').value = cfg.serverUrl;
  if (cfg.room) $('room').value = cfg.room;
  if (cfg.pass) $('pass').value = cfg.pass;
  const status = await sendToContent({ type: 'getStatus' });
  render(status);
})();

$('joinBtn').addEventListener('click', async () => {
  const serverUrl = $('serverUrl').value.trim();
  const room = $('room').value.trim();
  const pass = $('pass').value;
  if (!serverUrl || !room) {
    alert('请填写服务地址和房间号');
    return;
  }
  await chrome.storage.local.set({ serverUrl, room, pass, autoJoin: true });
  const res = await sendToContent({ type: 'join', serverUrl, room, pass });
  if (!res) {
    alert('当前页面不是 B站/腾讯视频/爱奇艺，请先打开要看的视频页面');
    return;
  }
  setTimeout(async () => render(await sendToContent({ type: 'getStatus' })), 500);
});

$('leaveBtn').addEventListener('click', async () => {
  await chrome.storage.local.set({ autoJoin: false });
  await sendToContent({ type: 'leave' });
  render({ connected: false });
});

$('chatBtn').addEventListener('click', sendChat);
$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

async function sendChat() {
  const text = $('chatInput').value.trim();
  if (!text) return;
  await sendToContent({ type: 'chat', text });
  $('chatInput').value = '';
}

// 接收内容脚本主动推来的状态更新
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') render(msg);
});
