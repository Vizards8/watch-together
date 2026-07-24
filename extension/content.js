// 一起看 —— 内容脚本
//
// 注入到 B站/腾讯/爱奇艺 页面里，做三件事：
// 1. 找到页面里正在播放的 <video> 元素
// 2. 连上你部署的 WebSocket 中转服务
// 3. 本地播放/暂停/拖动进度时，把动作同步给对方；收到对方动作时作用到本地视频
//
// 防回声：applyingRemote 标志。作用远端指令到本地 video 时会触发本地的
// play/pause/seeked 事件，如果不加标志会又把这个事件发回去，形成死循环。

(() => {
  'use strict';

  const state = {
    ws: null,
    room: null,
    serverUrl: null,
    connected: false,
    applyingRemote: false, // 正在作用远端指令，期间本地事件不外发
    video: null,
    reconnectTimer: null,
  };

  // ---------- 找 video 元素 ----------
  // 三家平台的播放器都是标准 HTML5 <video>，但可能在 iframe 里、可能延迟加载。
  // 用轮询找到时长 > 0 的那个 video（通常就是正片）。
  function findVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    // 优先选正在播放或有时长的
    const candidate =
      videos.find((v) => v.duration > 0 && !v.paused) ||
      videos.find((v) => v.duration > 0) ||
      videos[0];
    return candidate || null;
  }

  function ensureVideo() {
    const v = findVideo();
    if (v && v !== state.video) {
      state.video = v;
      bindVideoEvents(v);
      log('已绑定视频元素');
    }
    return state.video;
  }

  // ---------- 监听本地视频动作，同步给对方 ----------
  function bindVideoEvents(v) {
    v.addEventListener('play', () => {
      if (state.applyingRemote) return;
      send({ type: 'play', time: v.currentTime });
    });
    v.addEventListener('pause', () => {
      if (state.applyingRemote) return;
      send({ type: 'pause', time: v.currentTime });
    });
    // seeked：用户拖动进度条后触发
    v.addEventListener('seeked', () => {
      if (state.applyingRemote) return;
      send({ type: 'seek', time: v.currentTime, paused: v.paused });
    });
  }

  // ---------- 把远端指令作用到本地视频 ----------
  function applyRemote(msg) {
    const v = ensureVideo();
    if (!v) return;

    state.applyingRemote = true;
    try {
      // 进度差超过 0.8 秒才对齐，避免频繁微调导致画面抖动
      if (typeof msg.time === 'number' && Math.abs(v.currentTime - msg.time) > 0.8) {
        v.currentTime = msg.time;
      }
      if (msg.type === 'play') {
        v.play().catch(() => {});
      } else if (msg.type === 'pause') {
        v.pause();
      } else if (msg.type === 'seek') {
        if (msg.paused) v.pause();
        else v.play().catch(() => {});
      }
    } finally {
      // 稍等一拍再解锁，等本地由此触发的 play/pause/seeked 事件走完
      setTimeout(() => {
        state.applyingRemote = false;
      }, 150);
    }
  }


  // ---------- WebSocket 连接 ----------
  function connect() {
    if (!state.serverUrl || !state.room) return;
    if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;

    state.manualLeave = false;
    const url =
      `${state.serverUrl}?room=${encodeURIComponent(state.room)}` +
      `&pass=${encodeURIComponent(state.pass || '')}`;
    log('连接中：' + url);

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      log('连接失败：' + e.message);
      scheduleReconnect();
      return;
    }
    state.ws = ws;

    ws.onopen = () => {
      state.connected = true;
      log('已连接到中转服务');
      buildPanel();
      addMessage('sys', '已连接，等待对方加入…');
      notifyPopup();
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'presence') {
        const prev = state.peerCount || 0;
        state.peerCount = msg.count;
        if (msg.count >= 2 && prev < 2) addMessage('sys', '对方已加入 💕');
        else if (msg.count < 2 && prev >= 2) addMessage('sys', '对方离开了');
        notifyPopup();
        return;
      }
      if (msg.type === 'chat') {
        addMessage('peer', msg.text);
        return;
      }
      applyRemote(msg);
    };

    ws.onclose = () => {
      state.connected = false;
      notifyPopup();
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose 会紧跟着触发，重连逻辑统一放那里
    };
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) return;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connect();
    }, 3000);
  }

  function send(msg) {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify(msg));
    }
  }

  function disconnect() {
    state.manualLeave = true;
    if (state.ws) {
      try { state.ws.close(); } catch {}
      state.ws = null;
    }
    state.connected = false;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    // 主动离开时移除面板
    if (panel.root) {
      panel.root.remove();
      panel.root = null;
    }
  }


  // ---------- 可拖动聊天面板 ----------
  // 停在角落，显示历史对话，可拖到任意位置（位置记忆），可收起。
  // 面板自带输入框，直接在页面上就能发消息，不必每次开插件弹窗。
  const panel = { root: null, body: null, input: null, collapsed: false };

  function buildPanel() {
    if (panel.root) return;

    const root = document.createElement('div');
    root.style.cssText =
      'position:fixed;z-index:2147483647;width:260px;' +
      'background:rgba(28,28,30,.92);color:#fff;border-radius:12px;' +
      'font-family:-apple-system,"PingFang SC",sans-serif;font-size:13px;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.4);overflow:hidden;' +
      'backdrop-filter:blur(6px);user-select:none;';

    // 标题栏（可拖动）
    const bar = document.createElement('div');
    bar.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;' +
      'padding:8px 12px;background:#fb7299;cursor:move;font-weight:600;';
    bar.innerHTML =
      '<span>💬 一起看</span>' +
      '<span style="display:flex;gap:8px">' +
      '<span data-act="toggle" style="cursor:pointer;opacity:.9">—</span>' +
      '</span>';

    // 消息区
    const body = document.createElement('div');
    body.style.cssText =
      'max-height:240px;min-height:60px;overflow-y:auto;padding:10px 12px;' +
      'display:flex;flex-direction:column;gap:6px;';

    // 输入区
    const foot = document.createElement('div');
    foot.style.cssText = 'display:flex;gap:6px;padding:8px;background:rgba(255,255,255,.06);';
    const input = document.createElement('input');
    input.placeholder = '说点什么…';
    input.style.cssText =
      'flex:1;border:none;border-radius:6px;padding:7px 9px;font-size:13px;' +
      'background:rgba(255,255,255,.12);color:#fff;outline:none;';
    input.setAttribute('placeholder', '说点什么…');
    const sendBtn = document.createElement('button');
    sendBtn.textContent = '发送';
    sendBtn.style.cssText =
      'border:none;border-radius:6px;padding:0 12px;background:#fb7299;' +
      'color:#fff;font-size:13px;cursor:pointer;';

    foot.appendChild(input);
    foot.appendChild(sendBtn);
    root.appendChild(bar);
    root.appendChild(body);
    root.appendChild(foot);
    document.documentElement.appendChild(root);

    panel.root = root;
    panel.body = body;
    panel.input = input;
    panel.foot = foot;

    // 恢复上次位置，默认右下角
    const pos = loadPanelPos();
    root.style.left = pos.left;
    root.style.top = pos.top;

    // 输入时阻止按键冒泡到播放器（否则空格会暂停视频、方向键会快进）
    ['keydown', 'keyup', 'keypress'].forEach((ev) =>
      input.addEventListener(ev, (e) => e.stopPropagation())
    );
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitChat();
    });
    sendBtn.addEventListener('click', submitChat);

    // 收起/展开
    bar.querySelector('[data-act="toggle"]').addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel();
    });

    enableDrag(root, bar);
  }

  function submitChat() {
    const text = panel.input.value.trim();
    if (!text) return;
    send({ type: 'chat', text });
    addMessage('me', text);
    panel.input.value = '';
  }

  function togglePanel() {
    panel.collapsed = !panel.collapsed;
    panel.body.style.display = panel.collapsed ? 'none' : 'flex';
    panel.foot.style.display = panel.collapsed ? 'none' : 'flex';
  }

  // 拖动：按住标题栏移动整个面板，松手记忆位置
  function enableDrag(root, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = root.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      let nl = ox + (e.clientX - sx);
      let nt = oy + (e.clientY - sy);
      // 限制在视口内
      nl = Math.max(0, Math.min(nl, window.innerWidth - root.offsetWidth));
      nt = Math.max(0, Math.min(nt, window.innerHeight - root.offsetHeight));
      root.style.left = nl + 'px';
      root.style.top = nt + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      savePanelPos(root.style.left, root.style.top);
    });
  }

  function loadPanelPos() {
    try {
      const raw = localStorage.getItem('watchTogetherPanelPos');
      if (raw) return JSON.parse(raw);
    } catch {}
    return { left: window.innerWidth - 280 + 'px', top: window.innerHeight - 360 + 'px' };
  }
  function savePanelPos(left, top) {
    try {
      localStorage.setItem('watchTogetherPanelPos', JSON.stringify({ left, top }));
    } catch {}
  }

  // 追加一条消息。who: 'me' | 'peer' | 'sys'
  function addMessage(who, text) {
    buildPanel();
    if (panel.collapsed) togglePanel(); // 有新消息自动展开
    const row = document.createElement('div');
    const isMe = who === 'me';
    const isSys = who === 'sys';
    if (isSys) {
      row.style.cssText = 'align-self:center;color:#aaa;font-size:11px;';
      row.textContent = text;
    } else {
      row.style.cssText =
        'max-width:80%;padding:6px 10px;border-radius:10px;word-break:break-word;' +
        (isMe
          ? 'align-self:flex-end;background:#fb7299;color:#fff;'
          : 'align-self:flex-start;background:rgba(255,255,255,.15);color:#fff;');
      row.textContent = text;
    }
    panel.body.appendChild(row);
    panel.body.scrollTop = panel.body.scrollHeight;
  }

  // ---------- 和 popup 通信 ----------
  function notifyPopup() {
    chrome.runtime?.sendMessage?.({
      type: 'status',
      connected: state.connected,
      room: state.room,
      peerCount: state.peerCount || 0,
    }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.type === 'join') {
      state.serverUrl = req.serverUrl;
      state.room = req.room;
      state.pass = req.pass;
      disconnect();
      connect();
      sendResponse({ ok: true });
    } else if (req.type === 'leave') {
      disconnect();
      notifyPopup();
      sendResponse({ ok: true });
    } else if (req.type === 'getStatus') {
      sendResponse({
        connected: state.connected,
        room: state.room,
        peerCount: state.peerCount || 0,
        hasVideo: !!ensureVideo(),
      });
    } else if (req.type === 'chat') {
      send({ type: 'chat', text: req.text });
      addMessage('me', req.text);
      sendResponse({ ok: true });
    }
    return true; // 异步 sendResponse
  });

  // ---------- 启动 ----------
  // 页面里的 video 可能延迟出现，持续探测
  setInterval(ensureVideo, 2000);
  ensureVideo();

  // 若之前已保存过房间配置，自动重连
  chrome.storage?.local?.get(['serverUrl', 'room', 'pass', 'autoJoin'], (cfg) => {
    if (cfg.autoJoin && cfg.serverUrl && cfg.room) {
      state.serverUrl = cfg.serverUrl;
      state.room = cfg.room;
      state.pass = cfg.pass || '';
      connect();
    }
  });

  function log(...args) {
    console.log('[一起看]', ...args);
  }

})();
