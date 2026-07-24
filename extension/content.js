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
        state.peerCount = msg.count;
        notifyPopup();
        return;
      }
      if (msg.type === 'chat') {
        showToast(msg.text);
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
    if (state.ws) {
      try { state.ws.close(); } catch {}
      state.ws = null;
    }
    state.connected = false;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }


  // ---------- 轻量提示条（收到聊天/状态时闪一下） ----------
  let toastEl = null;
  function showToast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText =
        'position:fixed;left:50%;top:12%;transform:translateX(-50%);' +
        'background:rgba(0,0,0,.8);color:#fff;padding:10px 18px;border-radius:8px;' +
        'font-size:15px;z-index:2147483647;pointer-events:none;max-width:70%;' +
        'transition:opacity .3s;font-family:sans-serif;';
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => {
      if (toastEl) toastEl.style.opacity = '0';
    }, 3000);
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
      showToast('我：' + req.text);
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
