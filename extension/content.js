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
    applyingRemote: false, // 硬锁：同步执行的一瞬间，屏蔽即时触发的本地事件
    video: null,
    reconnectTimer: null,
    // 回声抑制：记录"刚从对方应用了什么状态"。在 until 之前，本地触发的、
    // 与这个状态一致的事件都视为回声（不是我主动操作），不再发回，避免来回弹。
    // 只靠时间锁不行——seek 缓冲是异步的，事件可能几百毫秒后才触发。
    echo: { until: 0, time: 0, paused: null },
    // "我刚主动操作过"的时间戳。用于消息交叉时保护发起方：我刚按下暂停/播放/拖动的
    // 这一小段时间里，收到对方几乎同时发来的消息，只同步播放状态、不拉动我的进度，
    // 否则我会被对方的旧进度拽走（"我点暂停却跳回对方进度"的根因）。
    lastLocalActAt: 0,
    heartbeatTimer: null,   // 心跳定时器：定期广播自己的进度，兜住播放中的持续漂移
    isBuffering: false,     // 本地是否正在缓冲（卡顿），缓冲时不追赶对方，避免雪上加霜
    nick: '朋友',           // 自己的昵称，发聊天时带上，让对方知道是谁说的
  };

  const now = () => Date.now();

  // 判断本地这次事件是不是"由刚收到的远端指令引起的回声"
  function isEcho(kind, v) {
    if (state.applyingRemote) return true;       // 正在同步执行，必然是回声
    if (now() > state.echo.until) return false;  // 窗口外，是真实的本地操作
    // 窗口内：只有"与刚应用的远端状态一致"才算回声；状态真的变了就放行
    if (kind === 'play') return state.echo.paused === false;
    if (kind === 'pause') return state.echo.paused === true;
    if (kind === 'seek') return Math.abs(v.currentTime - state.echo.time) < 1.0;
    return false;
  }

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
      // 换绑到新的 video 时，先把旧的那个暂停，避免两个 video 同时出声导致回声。
      const old = state.video;
      if (old && old !== v && !old.paused) {
        try { old.pause(); } catch {}
      }
      state.video = v;
      bindVideoEvents(v);
      log('已绑定视频元素');
    }
    // 巡查：只允许当前选中的正片出声。首次进房间时页面常有多个 video 同时在放同一内容，
    // 造成"同一视频放两遍"的回声。把除正片外、其他还在播放的 video 全部暂停。
    if (state.video) {
      for (const other of document.querySelectorAll('video')) {
        if (other !== state.video && !other.paused) {
          try { other.pause(); } catch {}
        }
      }
    }
    return state.video;
  }

  // ---------- 监听本地视频动作，同步给对方 ----------
  function bindVideoEvents(v) {
    v.addEventListener('play', () => {
      if (isEcho('play', v)) return;
      state.lastLocalActAt = now();
      send({ type: 'play', time: v.currentTime });
    });
    v.addEventListener('pause', () => {
      if (isEcho('pause', v)) return;
      state.lastLocalActAt = now();
      send({ type: 'pause', time: v.currentTime });
    });
    // seeked：用户拖动进度条后触发。exact=true 表示明确的跳转意图，对方要精确对齐。
    v.addEventListener('seeked', () => {
      if (isEcho('seek', v)) return;
      state.lastLocalActAt = now();
      send({ type: 'seek', time: v.currentTime, paused: v.paused, exact: true });
    });
    // 缓冲状态：卡顿时不追赶对方（自己都在 loading，追了也没用还添乱）
    v.addEventListener('waiting', () => { state.isBuffering = true; });
    v.addEventListener('playing', () => { state.isBuffering = false; });
    v.addEventListener('canplay', () => { state.isBuffering = false; });
  }

  // ---------- 把远端指令作用到本地视频 ----------
  function applyRemote(msg) {
    const v = ensureVideo();
    if (!v) return;

    // 记录回声窗口：接下来这段时间里，本地触发的、与此状态一致的 play/pause/seeked
    // 都是"由这次远端指令引起的"，不再发回。窗口给足 1.5 秒，覆盖 seek 缓冲的异步延迟。
    state.echo.until = now() + 1500;
    if (typeof msg.time === 'number') state.echo.time = msg.time;
    if (msg.type === 'play') state.echo.paused = false;
    else if (msg.type === 'pause') state.echo.paused = true;
    else if (msg.type === 'seek') state.echo.paused = !!msg.paused;

    state.applyingRemote = true;
    try {
      // 消息交叉保护：我自己刚（1 秒内）主动操作过，说明这条对方的消息是几乎同时发出、
      // 与我的操作交叉的。这种情况下不能用对方的旧进度拉动我——否则"我点暂停却跳回对方
      // 进度"。只有拖进度条(exact)是明确的跳转意图，仍然对齐；play/pause 不动我的进度。
      const justActedLocally = now() - state.lastLocalActAt < 1000;
      const allowSeek = msg.exact || !justActedLocally;

      // 跳转（拖进度条）要精确对齐：阈值 0.3 秒。播放/暂停顺带的时间校正容差 0.8 秒。
      const threshold = msg.exact ? 0.3 : 0.8;
      if (
        allowSeek &&
        typeof msg.time === 'number' &&
        Math.abs(v.currentTime - msg.time) > threshold
      ) {
        v.currentTime = msg.time;
      }
      if (msg.type === 'play') {
        v.play().catch(() => {});
        addMessage('sys', '对方点了播放 ▶');
      } else if (msg.type === 'pause') {
        v.pause();
        addMessage('sys', '对方按了暂停 ⏸');
      } else if (msg.type === 'seek') {
        if (msg.paused) v.pause();
        else v.play().catch(() => {});
        addMessage('sys', '对方跳到了 ' + fmtTime(msg.time));
      }
    } finally {
      // 硬锁只保护"同步执行的这一瞬间"里立刻同步触发的事件；
      // 之后异步触发的（如 seeked）交给 echo 窗口的状态匹配去判断。
      setTimeout(() => {
        state.applyingRemote = false;
      }, 50);
    }
  }

  // ---------- 心跳对齐 ----------
  // 播放中没人操作时，两边会因各自的卡顿/缓冲慢慢漂移，且不会自动拉回。
  // 解决：双方每 4 秒广播一次自己的进度。收到后按"只追赶、不拖慢"的方向温和对齐——
  // 只有当对方明显比我快（差 >2.5 秒）时我才追上去，收敛方向一致，不会来回拉锯。
  const HEARTBEAT_MS = 4000;
  const DRIFT_THRESHOLD = 2.5;

  function startHeartbeat() {
    stopHeartbeat();
    state.heartbeatTimer = setInterval(() => {
      const v = state.video;
      if (!v || v.paused) return; // 暂停时无需心跳，play/pause 消息已处理对齐
      send({ type: 'sync', time: v.currentTime, paused: false });
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
  }

  // 收到对方心跳：温和追赶。多重保护避免误跳和拉锯。
  function applyHeartbeat(msg) {
    const v = state.video;
    if (!v || typeof msg.time !== 'number') return;
    if (v.paused || msg.paused) return;              // 有一方暂停就不管，交给 play/pause 逻辑
    if (state.isBuffering) return;                   // 自己在缓冲，别乱跳
    if (now() - state.lastLocalActAt < 1500) return; // 刚操作过，别打架
    if (now() < state.echo.until) return;            // 回声窗口内，别打架

    const diff = msg.time - v.currentTime;
    // 只在"对方比我快 >2.5 秒"时追上去。对方比我慢则不动（等对方的心跳去追我），
    // 保证两边都朝"较快的一方"收敛，方向一致，不会互相拽。
    if (diff > DRIFT_THRESHOLD) {
      state.echo.until = now() + 1500;
      state.echo.time = msg.time;
      state.echo.paused = false;
      state.applyingRemote = true;
      v.currentTime = msg.time;
      setTimeout(() => { state.applyingRemote = false; }, 50);
      addMessage('sys', '⏱ 已自动对齐进度（网络波动）');
    }
  }

  // 秒数转 mm:ss
  function fmtTime(sec) {
    if (typeof sec !== 'number' || isNaN(sec)) return '';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // 收到对方发来的"打开这个页面"。已在同一页则忽略；否则跳转前保存好房间配置，
  // 让跳转后的新页面能靠 autoJoin 自动重连，聊天面板和同步会自动恢复。
  function handleOpenUrl(url) {
    if (!url) return;
    // 归一化对比：忽略 hash 等细枝末节
    const strip = (u) => u.split('#')[0];
    if (strip(url) === strip(location.href)) {
      addMessage('sys', '对方想一起看这页，你已经在这了');
      return;
    }
    buildPanel();
    addMessage('sys', '对方邀请你打开新页面，即将跳转…');
    // 确保当前房间配置已持久化（跳转后新页面自动重连需要）
    chrome.storage?.local?.set?.({
      serverUrl: state.serverUrl,
      room: state.room,
      pass: state.pass || '',
      autoJoin: true,
    });
    setTimeout(() => {
      location.href = url;
    }, 800);
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
      startHeartbeat();
      // 入场通报昵称，让已在房间的人看到"谁加入了"
      send({ type: 'hello', name: state.nick });
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
        addMessage('peer', msg.text, msg.name);
        return;
      }
      if (msg.type === 'hello') {
        // 对方入场通报，带昵称。提示"谁加入了"，比只报人数更清楚
        if (msg.name) addMessage('sys', `${msg.name} 加入了 💕`);
        // 回一个 hello，让对方也知道我的昵称（只回给新来的，避免风暴——这里简单地也广播）
        if (!msg.reply) send({ type: 'hello', name: state.nick, reply: true });
        return;
      }
      if (msg.type === 'openurl') {
        handleOpenUrl(msg.url);
        return;
      }
      if (msg.type === 'sync') {
        applyHeartbeat(msg);
        return;
      }
      applyRemote(msg);
    };

    ws.onclose = () => {
      state.connected = false;
      stopHeartbeat();
      notifyPopup();
      // 主动离开（点了"离开"）不重连；只有意外断线才重连
      if (!state.manualLeave) scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose 会紧跟着触发，重连逻辑统一放那里
    };
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) return;
    if (state.manualLeave) return; // 主动离开后不重连
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (state.manualLeave) return; // 定时器触发时再确认一次
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
    stopHeartbeat();
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
  // collapsed=true 时只显示边缘小圆标（bubble），完整面板（root）隐藏，不挡画面。
  // 点小圆标展开，点面板「—」收回小圆标。默认收起。
  const panel = { root: null, body: null, input: null, bubble: null, collapsed: true, unread: 0 };

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
      '<span>💬 一起看 <span data-role="clock" ' +
      'style="font-weight:400;font-size:12px;opacity:.9;margin-left:4px"></span></span>' +
      '<span style="display:flex;gap:10px;align-items:center">' +
      '<span data-act="openurl" title="让对方打开你当前的视频页" ' +
      'style="cursor:pointer;opacity:.95;font-size:12px">🔗 喊 TA 来</span>' +
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
    // 输入法组合状态：中文拼音、英文候选等正在组合时，回车用于上屏/选词，不该触发发送
    let composing = false;
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; });
    input.addEventListener('keydown', (e) => {
      // e.isComposing 兜底：部分输入法 compositionend 与 keydown 时序不稳
      if (e.key === 'Enter' && !composing && !e.isComposing) submitChat();
    });
    sendBtn.addEventListener('click', submitChat);

    // 收起/展开
    bar.querySelector('[data-act="toggle"]').addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel();
    });

    // 拉对方过来：把当前页 URL 发给对方，让 TA 的浏览器跳到同一页
    bar.querySelector('[data-act="openurl"]').addEventListener('click', (e) => {
      e.stopPropagation();
      send({ type: 'openurl', url: location.href });
      addMessage('sys', '已把当前页发给对方');
    });

    enableDrag(root, bar);

    // 标题栏时钟：立即显示一次，之后每 15 秒刷新（跨过整分钟即更新）
    const clockEl = bar.querySelector('[data-role="clock"]');
    const tick = () => { if (clockEl) clockEl.textContent = clockHM(); };
    tick();
    setInterval(tick, 15000);

    // 边缘小圆标：平时只露这个，不挡画面。点它展开完整面板。
    const bubble = document.createElement('div');
    bubble.style.cssText =
      'position:fixed;z-index:2147483647;width:44px;height:44px;border-radius:50%;' +
      'background:#fb7299;color:#fff;display:flex;align-items:center;justify-content:center;' +
      'font-size:20px;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.35);' +
      'user-select:none;transition:transform .15s;';
    bubble.innerHTML =
      '💬<span data-role="badge" style="position:absolute;top:-3px;right:-3px;' +
      'min-width:16px;height:16px;line-height:16px;padding:0 4px;border-radius:8px;' +
      'background:#ff3b30;color:#fff;font-size:11px;text-align:center;display:none"></span>';
    bubble.title = '一起看 · 点击展开';
    // 小圆标默认停右下角
    const bpos = loadBubblePos();
    bubble.style.left = bpos.left;
    bubble.style.top = bpos.top;
    document.documentElement.appendChild(bubble);
    panel.bubble = bubble;

    bubble.addEventListener('click', () => setCollapsed(false));
    enableBubbleDrag(bubble);

    // 默认收起为小圆标
    setCollapsed(true);

    // 若当前正处于全屏，面板要挂到全屏元素里才可见
    relocatePanel();
  }

  function submitChat() {
    const text = panel.input.value.trim();
    if (!text) return;
    send({ type: 'chat', text, name: state.nick });
    addMessage('me', text);
    panel.input.value = '';
  }

  function togglePanel() {
    setCollapsed(!panel.collapsed);
  }

  // 收起：隐藏完整面板，显示小圆标。展开：反之，并清空未读。
  function setCollapsed(collapsed) {
    panel.collapsed = collapsed;
    if (!panel.root) return;
    panel.root.style.display = collapsed ? 'none' : 'block';
    if (panel.bubble) panel.bubble.style.display = collapsed ? 'flex' : 'none';
    if (!collapsed) {
      panel.unread = 0;
      updateBadge();
      panel.body.scrollTop = panel.body.scrollHeight;
    }
    relocatePanel();
  }

  // 小圆标上的未读红点
  function updateBadge() {
    if (!panel.bubble) return;
    const badge = panel.bubble.querySelector('[data-role="badge"]');
    if (!badge) return;
    if (panel.unread > 0) {
      badge.textContent = panel.unread > 99 ? '99+' : String(panel.unread);
      badge.style.display = 'block';
      // 轻微弹动提醒
      panel.bubble.style.transform = 'scale(1.15)';
      setTimeout(() => { if (panel.bubble) panel.bubble.style.transform = 'scale(1)'; }, 150);
    } else {
      badge.style.display = 'none';
    }
  }

  // 小圆标也可拖动（与面板独立记忆位置）
  function enableBubbleDrag(el) {
    let sx, sy, ox, oy, moved = false, dragging = false;
    el.addEventListener('mousedown', (e) => {
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      if (Math.abs(e.clientX - sx) > 3 || Math.abs(e.clientY - sy) > 3) moved = true;
      let nl = ox + (e.clientX - sx);
      let nt = oy + (e.clientY - sy);
      nl = Math.max(0, Math.min(nl, window.innerWidth - el.offsetWidth));
      nt = Math.max(0, Math.min(nt, window.innerHeight - el.offsetHeight));
      el.style.left = nl + 'px';
      el.style.top = nt + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        // 拖动过就记住位置，并阻止这次的 click 展开
        saveBubblePos(el.style.left, el.style.top);
        const block = (ev) => { ev.stopPropagation(); el.removeEventListener('click', block, true); };
        el.addEventListener('click', block, true);
      }
    });
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
  function loadBubblePos() {
    try {
      const raw = localStorage.getItem('watchTogetherBubblePos');
      if (raw) return JSON.parse(raw);
    } catch {}
    return { left: window.innerWidth - 64 + 'px', top: window.innerHeight - 84 + 'px' };
  }
  function saveBubblePos(left, top) {
    try {
      localStorage.setItem('watchTogetherBubblePos', JSON.stringify({ left, top }));
    } catch {}
  }

  // 追加一条消息。who: 'me' | 'peer' | 'sys'；name: 对方昵称（peer 时显示在气泡上方）
  let lastSysText = '', lastSysAt = 0;
  function addMessage(who, text, name) {
    buildPanel();
    const isMe = who === 'me';
    const isSys = who === 'sys';
    // 系统提示限流：同一条提示 8 秒内不重复显示，避免"自动对齐"等高频提示刷屏
    if (isSys) {
      if (text === lastSysText && now() - lastSysAt < 8000) return;
      lastSysText = text;
      lastSysAt = now();
    }
    // 收起（小圆标）状态下：对方发来的聊天消息累计未读、让圆标红点提醒，但不强行展开
    // 打断看视频。自己发的、系统提示都不计未读。展开时未读清零。
    if (panel.collapsed && who === 'peer') {
      panel.unread++;
      updateBadge();
    }
    const row = document.createElement('div');
    if (isSys) {
      row.style.cssText = 'align-self:center;color:#aaa;font-size:11px;';
      row.textContent = text;
    } else {
      // 聊天气泡 + 下方小字时间戳
      row.style.cssText =
        'display:flex;flex-direction:column;max-width:80%;' +
        (isMe ? 'align-self:flex-end;align-items:flex-end;'
              : 'align-self:flex-start;align-items:flex-start;');
      // 对方消息：气泡上方显示昵称，多人/进出场景下能分清是谁说的
      if (!isMe && name) {
        const nameEl = document.createElement('div');
        nameEl.style.cssText = 'font-size:10px;color:#fb7299;margin:0 2px 2px;font-weight:600;';
        nameEl.textContent = name;
        row.appendChild(nameEl);
      }
      const bubble = document.createElement('div');
      bubble.style.cssText =
        'padding:6px 10px;border-radius:10px;word-break:break-word;' +
        (isMe
          ? 'background:#fb7299;color:#fff;'
          : 'background:rgba(255,255,255,.15);color:#fff;');
      bubble.textContent = text;
      const ts = document.createElement('div');
      ts.style.cssText = 'font-size:10px;color:#999;margin-top:2px;padding:0 2px;';
      ts.textContent = clockHM();
      row.appendChild(bubble);
      row.appendChild(ts);
    }
    panel.body.appendChild(row);
    panel.body.scrollTop = panel.body.scrollHeight;
  }

  // 当前时钟 HH:MM
  function clockHM() {
    const d = new Date();
    const h = d.getHours();
    const m = d.getMinutes();
    return `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`;
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
      if (req.nick) state.nick = req.nick;
      disconnect();
      connect();
      sendResponse({ ok: true });
    } else if (req.type === 'leave') {
      // 清掉自动重连标志，避免刷新/重开页面后又自动加回房间
      chrome.storage?.local?.set?.({ autoJoin: false });
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
      send({ type: 'chat', text: req.text, name: state.nick });
      addMessage('me', req.text);
      sendResponse({ ok: true });
    }
    return true; // 异步 sendResponse
  });

  // ---------- 全屏适配 ----------
  // 进入全屏后，浏览器只渲染全屏元素及其子树，挂在 documentElement 下的面板会被隐藏。
  // 所以全屏时把面板移进全屏元素内部，退出时移回来。面板是 position:fixed，
  // 仍以视口定位，移动后位置不受影响。
  function relocatePanel() {
    const fsEl =
      document.fullscreenElement || document.webkitFullscreenElement || null;
    const target = fsEl || document.documentElement;
    // 面板和小圆标都要跟着挪进全屏元素，否则全屏时不可见
    if (panel.root && panel.root.parentNode !== target) target.appendChild(panel.root);
    if (panel.bubble && panel.bubble.parentNode !== target) target.appendChild(panel.bubble);
  }
  ['fullscreenchange', 'webkitfullscreenchange'].forEach((ev) =>
    document.addEventListener(ev, relocatePanel)
  );

  // ---------- 启动 ----------
  // 页面里的 video 可能延迟出现，持续探测
  setInterval(ensureVideo, 2000);
  ensureVideo();

  // 若之前已保存过房间配置，自动重连
  chrome.storage?.local?.get(['serverUrl', 'room', 'pass', 'nick', 'autoJoin'], (cfg) => {
    if (cfg.autoJoin && cfg.serverUrl && cfg.room) {
      state.serverUrl = cfg.serverUrl;
      state.room = cfg.room;
      state.pass = cfg.pass || '';
      if (cfg.nick) state.nick = cfg.nick;
      connect();
    }
  });

  function log(...args) {
    console.log('[一起看]', ...args);
  }

})();
