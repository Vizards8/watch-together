// 一起看视频 —— WebSocket 中转服务
//
// 作用：两个浏览器插件各自连到这台服务，服务只做一件事：
// 把一方发来的控制消息（播放/暂停/跳进度/聊天）原样转发给同一个房间里的另一方。
// 传的都是几十字节的 JSON，不碰视频流，所以带宽几乎为零。
//
// 房间机制：靠 URL 上的 ?room=xxx 区分。同一个房间号的人才会互相收到消息。

import { WebSocketServer } from 'ws';
import http from 'http';

const PORT = process.env.PORT || 8080;

// 一个简单的 HTTP 服务，用于健康检查（Railway/Render 会定时探活）
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('watch-together server is running');
});

const wss = new WebSocketServer({ server: httpServer });

// rooms: Map<roomId, Set<WebSocket>>
const rooms = new Map();

// 房间的真实标识 = 房间号 + 密码 一起决定。
// 这样密码不对的人即使猜中房间号，算出来的 roomKey 也不同，进的是另一个空房间，
// 收不到你们的消息。服务端不保存密码，只是把它并入房间键。
function getRoomId(req) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const room = url.searchParams.get('room') || 'default';
    const pass = url.searchParams.get('pass') || '';
    return `${room}::${pass}`;
  } catch {
    return 'default::';
  }
}

wss.on('connection', (ws, req) => {
  const roomId = getRoomId(req);

  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  const room = rooms.get(roomId);
  room.add(ws);
  ws.roomId = roomId;

  console.log(`[connect] room=${roomId} size=${room.size}`);

  // 告诉刚进来的人：当前房间有几个人（前端可据此提示“对方已连接”）
  broadcast(roomId, { type: 'presence', count: room.size }, null);

  ws.on('message', (data) => {
    // 收到什么就原样转发给同房间的其他人（不含发送者自己）
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // 非法消息直接忽略
    }
    broadcast(roomId, msg, ws);
  });

  ws.on('close', () => {
    room.delete(ws);
    console.log(`[disconnect] room=${roomId} size=${room.size}`);
    if (room.size === 0) {
      rooms.delete(roomId);
    } else {
      broadcast(roomId, { type: 'presence', count: room.size }, null);
    }
  });

  ws.on('error', (err) => console.error('[ws error]', err.message));
});

// 把 msg 发给 roomId 房间里除 except 之外的所有连接
function broadcast(roomId, msg, except) {
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = JSON.stringify(msg);
  for (const client of room) {
    if (client !== except && client.readyState === 1 /* OPEN */) {
      client.send(payload);
    }
  }
}

httpServer.listen(PORT, () => {
  console.log(`watch-together server listening on port ${PORT}`);
});
