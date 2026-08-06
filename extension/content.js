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

  // manifest 里 all_frames: true，是为了兼容播放器藏在同源 iframe 里的情况。
  // 但副作用是同源 iframe 也会各自注入一份本脚本、各开一条 WebSocket，于是
  // 一个人进房间服务端却看到 2 条连接 —— 表现为"只有我却提示对方已加入"，
  // 以及 iframe 被销毁重建时（切集、广告）反复"加入/离开"刷屏。
  // 腾讯视频实测有同源 iframe：v.qq.com/thumbplayer-offline-log.html。
  //
  // 解决：只有顶层文档负责联网与 UI，iframe 里的实例直接退出。
  // 实测 B站/腾讯/爱奇艺的 <video> 都在顶层文档里（同源 iframe 内为 0 个），
  // 所以这么做不会漏掉播放器。日后若遇到播放器真在 iframe 内的站点，
  // 需要改成顶层单连接 + frame 内转发的架构，而不是各自建连接。
  const isTopFrame = (() => {
    try {
      return window.top === window.self;
    } catch {
      return false; // 读不到 top 说明被跨域嵌套，那就不是顶层
    }
  })();
  if (!isTopFrame) return;

  // 默认中转地址，需与 popup.js 保持一致
  const DEFAULT_SERVER_URL = 'wss://watch-together.laphi.workers.dev';

  // 已废弃的旧中转地址，见 popup.js 同名常量
  const LEGACY_SERVER_URLS = [
    'wss://watch-together-production-d1c9.up.railway.app',
  ];

  const state = {
    ws: null,
    room: null,
    serverUrl: null,
    clientId: null,        // 浏览器级标识，同一浏览器的所有标签页共用，用于人数去重
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

  // 取远端消息里的昵称，用于"谁做了什么"的提示。
  // 1.4.0 之前的客户端不带 name，此时退回中性称呼，不能显示 undefined。
  function peerName(msg) {
    const n = msg && typeof msg.name === 'string' ? msg.name.trim() : '';
    return n || '有人';
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
      // 操作提示带上是谁做的。房间可能有多人，笼统说"对方"分不清。
      const who = peerName(msg);
      if (msg.type === 'play') {
        v.play().catch(() => {});
        addMessage('sys', `${who}点了播放 ▶`);
      } else if (msg.type === 'pause') {
        v.pause();
        addMessage('sys', `${who}按了暂停 ⏸`);
      } else if (msg.type === 'seek') {
        if (msg.paused) v.pause();
        else v.play().catch(() => {});
        addMessage('sys', `${who}跳到了 ` + fmtTime(msg.time));
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

  // 收到别人发来的"打开这个页面"。已在同一页则忽略；否则跳转前保存好房间配置，
  // 让跳转后的新页面能靠 autoJoin 自动重连，聊天面板和同步会自动恢复。
  function handleOpenUrl(url, who) {
    if (!url) return;
    const name = who || '有人';
    // 归一化对比：忽略 hash 等细枝末节
    const strip = (u) => u.split('#')[0];
    if (strip(url) === strip(location.href)) {
      addMessage('sys', `${name}想一起看这页，你已经坐这儿了 🎬`);
      return;
    }
    buildPanel();
    addMessage('sys', `${name}拉你入座，马上过去…`);
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
      `&pass=${encodeURIComponent(state.pass || '')}` +
      // 浏览器级标识，让服务端把同一个人的多个标签页算作一个人
      `&client=${encodeURIComponent(state.clientId || '')}`;
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
      addMessage('sys', '连上了，等大家来…');
      // 第一次用的时候指一下说明在哪，之后不再提。标记记在 storage 里，换页也不会重复弹
      chrome.storage?.local?.get(['helpShown'], (c) => {
        if (!c?.helpShown) {
          addMessage('sys', '第一次用？', 'help');
          chrome.storage?.local?.set?.({ helpShown: true });
        }
      });
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
        // 只报人数变化，不说"谁"——presence 里没有昵称信息。
        // "谁加入了"由带昵称的 hello 消息负责，避免同一件事报两遍。
        if (msg.count < prev && msg.count >= 1) {
          addMessage('sys', `有人走了，还剩 ${msg.count} 人在看`);
        }
        notifyPopup();
        return;
      }
      if (msg.type === 'chat') {
        addMessage('peer', msg.text, msg.name);
        return;
      }
      if (msg.type === 'hello') {
        // 别人入场通报，带昵称。提示"谁加入了"，比只报人数更清楚
        if (msg.name) addMessage('sys', `${msg.name} 加入了 💕`);
        // 回一个 hello，让对方也知道我的昵称（只回给新来的，避免风暴——这里简单地也广播）
        if (!msg.reply) send({ type: 'hello', name: state.nick, reply: true });
        return;
      }
      if (msg.type === 'openurl') {
        handleOpenUrl(msg.url, peerName(msg));
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
      // 统一带上昵称，收到方才能显示"谁"做了操作而不是笼统的"对方"。
      // 放在这里而不是每个 send 调用点，是为了以后加新消息类型时不会漏。
      state.ws.send(JSON.stringify({ name: state.nick, ...msg }));
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
    destroyPanel();
  }

  // 拆掉整个面板。root 和 bubble 是两个独立挂在页面上的元素，
  // 只删 root 会留下小圆标；而 buildPanel 的守卫看的是 root，
  // 于是下次加入又造一个圆标，页面上就越点越多。时钟定时器也要一起清，
  // 否则每次重建都多一个 interval。
  function destroyPanel() {
    if (panel.clockTimer) {
      clearInterval(panel.clockTimer);
      panel.clockTimer = null;
    }
    if (panel.root) {
      panel.root.remove();
      panel.root = null;
    }
    if (panel.bubble) {
      panel.bubble.remove();
      panel.bubble = null;
    }
    panel.body = null;
    panel.input = null;
    panel.unread = 0;
    // 注意别在这里重置 panel.collapsed：那会连带用 saveCollapsed 覆盖掉
    // 用户的展开/收起偏好。下次 buildPanel 会从 localStorage 重新读。
  }


  // ---------- 可拖动聊天面板 ----------
  // 停在角落，显示历史对话，可拖到任意位置（位置记忆），可收起。
  // 面板自带输入框，直接在页面上就能发消息，不必每次开插件弹窗。
  // collapsed=true 时只显示边缘小圆标（bubble），完整面板（root）隐藏，不挡画面。
  // 点小圆标展开，点面板「—」收回小圆标。默认收起。
  // 小圆标的直径。定位时要用它算"向上展开"的位置，所以提成常量，
  // 别和样式里的写死值分开维护
  const BUBBLE_SIZE = 44;

  // 下面这几个常量必须声明在 buildPanel / setCollapsed 之前。
  // 函数声明会提升，但 const 不会：如果放在后面，buildPanel 里调用
  // loadCollapsed() → 读 COLLAPSED_KEY 会抛 ReferenceError（TDZ），
  // 面板直接建不出来，表现就是"点了加入房间没反应"。
  const ANCHOR_KEY = 'watchTogetherAnchor2';   // 面板/圆标共享的位置
  const COLLAPSED_KEY = 'watchTogetherCollapsed'; // 收起状态
  const PANEL_H_GUESS = 320;   // 面板高度，用于反推默认位置的顶端
  const BOTTOM_GAP = 120;      // 默认位置离视口底部的空隙，躲开播放器控件条

  const panel = {
    root: null, body: null, input: null, bubble: null,
    collapsed: true, unread: 0,
    clockTimer: null, // 标题栏时钟的 interval，销毁面板时要清掉
  };

  function buildPanel() {
    if (panel.root) return;
    // 兜底：若上次只清掉了 root、圆标还挂在页面上，先拆干净再重建，避免叠出多个圆标
    if (panel.bubble) destroyPanel();

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
      '<span data-act="openurl" title="拉大家入座 —— 把当前视频页发过去，大家会自动跳来这一页" ' +
      'style="cursor:pointer;opacity:.95;font-size:12px">🎬 拉你入座</span>' +
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

    // 位置在 setCollapsed 里按共享锚点统一摆放（那时元素已挂上、量得到尺寸）

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

    // 拉人过来：把当前页 URL 发给房间里的其他人，让他们的浏览器跳到同一页
    bar.querySelector('[data-act="openurl"]').addEventListener('click', (e) => {
      e.stopPropagation();
      send({ type: 'openurl', url: location.href });
      addMessage('sys', '已经拉大家入座了 🎬');
    });

    enableDrag(root, bar);

    // 标题栏时钟：立即显示一次，之后每 15 秒刷新（跨过整分钟即更新）
    const clockEl = bar.querySelector('[data-role="clock"]');
    const tick = () => { if (clockEl) clockEl.textContent = clockHM(); };
    tick();
    panel.clockTimer = setInterval(tick, 15000);

    // 边缘小圆标：平时只露这个，不挡画面。点它展开完整面板。
    const bubble = document.createElement('div');
    bubble.style.cssText =
      `position:fixed;z-index:2147483647;width:${BUBBLE_SIZE}px;height:${BUBBLE_SIZE}px;border-radius:50%;` +
      'background:#fb7299;color:#fff;display:flex;align-items:center;justify-content:center;' +
      'font-size:20px;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.35);' +
      'user-select:none;transition:transform .15s;';
    bubble.innerHTML =
      '💬<span data-role="badge" style="position:absolute;top:-3px;right:-3px;' +
      'min-width:16px;height:16px;line-height:16px;padding:0 4px;border-radius:8px;' +
      'background:#ff3b30;color:#fff;font-size:11px;text-align:center;display:none"></span>';
    bubble.title = '一起看 · 点击展开';
    // 位置同样交给 setCollapsed 按共享锚点摆放
    document.documentElement.appendChild(bubble);
    panel.bubble = bubble;

    bubble.addEventListener('click', () => setCollapsed(false));
    enableBubbleDrag(bubble);

    // 默认展开。只露一个 44px 的小圆标太不显眼，容易以为"点了加入没反应"；
    // 展开着能直接看到"连上了"和聊天内容，也一眼知道收起按钮在哪。
    // 收起状态由用户自己决定，记在 localStorage 里，下次按上次的来。
    setCollapsed(loadCollapsed());

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
  // 两者共用锚点，所以每次切换都按锚点重新摆一次，做到"原地收放"。
  function setCollapsed(collapsed) {
    panel.collapsed = collapsed;
    saveCollapsed(collapsed);
    if (!panel.root) return;

    const anchor = loadAnchor();
    panel.root.style.display = collapsed ? 'none' : 'block';
    if (panel.bubble) panel.bubble.style.display = collapsed ? 'flex' : 'none';

    // 必须在 display 生效之后再定位：隐藏元素的 offsetWidth 是 0，算不出正确位置
    if (collapsed) {
      placeByAnchor(panel.bubble, anchor);
    } else {
      // 传圆标高度，好让面板在下方空间不足时改为向上展开
      placeByAnchor(panel.root, anchor, BUBBLE_SIZE);
    }

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
        // 拖动过就记住位置，并阻止这次的 click 展开。
        // 写的是共享锚点，所以下次展开面板也会出现在这儿
        const a = anchorOf(el);
        saveAnchor(a.right, a.top);
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
      // 写共享锚点，收起时圆标就落在面板刚才的位置
      const a = anchorOf(root);
      saveAnchor(a.right, a.top);
    });
  }

  // 面板和小圆标共用一个"锚点"，记的是【右上角】坐标。
  // 之前两者各记一套位置，把面板拖到左边、收起时圆标还停在右下角，看着就是跳了一下。
  //
  // 为什么对齐右上角：收起按钮「—」就在标题栏右上角，点它的瞬间视线和鼠标
  // 都停在那里，圆标就该出现在那儿。之前按右下角对齐，圆标跑到了面板底部
  // （发送按钮那一侧），离刚点的地方隔了一整个面板的高度。
  // 默认位置。两个约束互相拉扯：
  // 往上会被插件弹窗遮住（弹窗贴浏览器右上角，从视口顶部往下约 420px），
  // 往下又会被播放器底部控件盖住，而且视口只有 577 高时（B站实测）
  // 320px 的面板压根塞不进"弹窗下方"这段空间。
  //
  // 所以不用固定像素，改成按视口算：面板底边离视口底 BOTTOM_GAP，
  // 顶端自然落在下半部分。视口再矮也只是贴着底，不会被夹得跑上去。
  // （BOTTOM_GAP / PANEL_H_GUESS 声明在文件靠前处，见 TDZ 注释）
  function defaultAnchor() {
    const top = Math.max(
      12,
      window.innerHeight - BOTTOM_GAP - PANEL_H_GUESS
    );
    return { right: 24, top };
  }

  function loadAnchor() {
    try {
      const raw = localStorage.getItem(ANCHOR_KEY);
      if (raw) {
        const a = JSON.parse(raw);
        if (typeof a?.right === 'number' && typeof a?.top === 'number') return a;
      }
    } catch {}
    return defaultAnchor();
  }

  function saveAnchor(right, top) {
    try {
      localStorage.setItem(ANCHOR_KEY, JSON.stringify({ right, top }));
    } catch {}
  }

  // 按锚点摆放某个元素：右上角对齐到锚点，同时夹在视口内。
  //
  // 面板比圆标高得多（320 vs 44），锚点靠下时向下展开会超出视口。
  // 这时改成向上展开：把底边对齐到"圆标底边所在的位置"，右上角虽然不再
  // 贴着锚点，但展开方向朝着有空间的一侧，不会被硬夹到别处去。
  // bubbleH 传入圆标高度，用来算那条底边；不传就按纯右上角对齐处理。
  function placeByAnchor(el, anchor, bubbleH) {
    if (!el) return;
    const w = el.offsetWidth || 0;
    const h = el.offsetHeight || 0;

    let left = window.innerWidth - anchor.right - w;
    left = Math.max(0, Math.min(left, window.innerWidth - w));

    let top = anchor.top;
    if (bubbleH && top + h > window.innerHeight) {
      // 下方装不下：底边对齐圆标底边，改为向上展开
      top = anchor.top + bubbleH - h;
    }
    top = Math.max(0, Math.min(top, window.innerHeight - h));

    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  // 从元素当前位置反推锚点（右上角相对视口的位置）
  function anchorOf(el) {
    const r = el.getBoundingClientRect();
    return {
      right: Math.round(window.innerWidth - r.right),
      top: Math.round(r.top),
    };
  }

  // 收起状态也记住：默认展开（更显眼），但用户手动收起后下次就保持收起，
  // 不要每次连上都弹开挡画面。（COLLAPSED_KEY 声明在文件靠前处，见 TDZ 注释）
  function loadCollapsed() {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
      return false; // 读不到就按默认的展开处理
    }
  }

  function saveCollapsed(collapsed) {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {}
  }

  // 追加一条消息。who: 'me' | 'peer' | 'sys'；
  // name: 发送者昵称，显示在气泡上方（me 时不传则用 state.nick）
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
      // name 在 sys 消息里复用为"附一个可点链接"：用于首次连上时指向使用说明。
      // 用 textContent + appendChild 而不是 innerHTML，避免把消息内容当 HTML 解析。
      if (name === 'help') {
        row.appendChild(document.createTextNode(' '));
        const a = document.createElement('a');
        a.textContent = '看使用说明';
        a.href = chrome.runtime.getURL('help.html');
        a.target = '_blank';
        a.style.cssText = 'color:#fb7299;text-decoration:underline;cursor:pointer;';
        row.appendChild(a);
      }
    } else {
      // 聊天气泡 + 下方小字时间戳
      row.style.cssText =
        'display:flex;flex-direction:column;max-width:80%;' +
        (isMe ? 'align-self:flex-end;align-items:flex-end;'
              : 'align-self:flex-start;align-items:flex-start;');
      // 气泡上方显示昵称。自己的消息也显示（用自己的昵称），
      // 多人在场时才能一眼看清每句是谁说的。自己的昵称用淡色，跟别人区分开。
      const label = isMe ? (name || state.nick) : name;
      if (label) {
        const nameEl = document.createElement('div');
        nameEl.style.cssText =
          'font-size:10px;margin:0 2px 2px;font-weight:600;' +
          (isMe ? 'color:rgba(255,255,255,.55);' : 'color:#fb7299;');
        nameEl.textContent = label;
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
      ensureClientId(connect);
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

  // 窗口尺寸变了（进出全屏、缩放窗口）按锚点重排，否则面板可能跑到视口外。
  // 锚点记的是到右下角的距离，所以重排后相对位置观感不变。
  window.addEventListener('resize', () => {
    if (!panel.root) return;
    const anchor = loadAnchor();
    if (panel.collapsed) placeByAnchor(panel.bubble, anchor);
    else placeByAnchor(panel.root, anchor, BUBBLE_SIZE);
  });

  // ---------- 启动 ----------
  // 页面里的 video 可能延迟出现，持续探测
  setInterval(ensureVideo, 2000);
  ensureVideo();

  // 读出（首次则生成）浏览器级 clientId。存在 chrome.storage 里，
  // 所以同一浏览器的所有标签页拿到的是同一个值，服务端据此把多个页面算作一个人。
  function ensureClientId(cb) {
    if (state.clientId) return cb();
    chrome.storage?.local?.get(['clientId'], (cfg) => {
      if (cfg?.clientId) {
        state.clientId = cfg.clientId;
      } else {
        state.clientId =
          (crypto.randomUUID?.() || String(now()) + Math.random().toString(36).slice(2));
        chrome.storage?.local?.set?.({ clientId: state.clientId });
      }
      cb();
    });
  }

  // 若之前已保存过房间配置，自动重连
  chrome.storage?.local?.get(['serverUrl', 'room', 'pass', 'nick', 'autoJoin'], (cfg) => {
    // storage 里存的是已废弃的旧地址：直接删掉这一项，回落到 DEFAULT_SERVER_URL。
    // popup 只在点图标时才跑，而打开视频页是走这条自动重连的路径，所以这里也得拦一次。
    if (cfg.serverUrl && LEGACY_SERVER_URLS.includes(cfg.serverUrl)) {
      chrome.storage.local.remove('serverUrl');
      cfg.serverUrl = null;
    }
    // 没存地址 = 用内置默认。判断条件只看 room，别再要求 serverUrl 存在
    if (cfg.autoJoin && cfg.room) {
      state.serverUrl = cfg.serverUrl || DEFAULT_SERVER_URL;
      state.room = cfg.room;
      state.pass = cfg.pass || '';
      if (cfg.nick) state.nick = cfg.nick;
      ensureClientId(connect);
    }
  });

  // 跨标签页同步"离开"：popup 只能给当前标签页发消息，但你可能开了好几个视频页。
  // autoJoin 被置为 false 就是"全体离开"的信号，其他页看到就各自断开，
  // 否则它们仍连着、还会把"已连接"推给 popup，按钮就闪回"离开"了。
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.autoJoin && changes.autoJoin.newValue === false) {
      if (state.ws || state.connected) {
        // 注意别在这之后调 addMessage：它会 buildPanel() 把刚拆掉的面板又建回来
        disconnect();
        notifyPopup();
      }
    }
  });

  function log(...args) {
    console.log('[一起看]', ...args);
  }

})();
