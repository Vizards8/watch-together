// 一起看 —— Cloudflare Workers + Durable Objects 版中转服务
//
// 跟 server/server.js 干的是同一件事：把一方发来的控制消息原样转发给同房间的另一方。
// 区别在于运行环境：Workers 没有 Node 的 ws 库，改用原生 WebSocketPair；
// 房间不再是一个进程里的 Map，而是「一个房间 = 一个 Durable Object 实例」。
//
// 为什么用 Hibernation API（ctx.acceptWebSocket 而不是 ws.accept）：
// 普通 accept 会把 DO 钉在内存里，连着多久就按多久计费；hibernation 下
// 没消息的空闲时段不计时长费，连接还照样开着。你们暂停聊天那半小时是免费的。

import { DurableObject } from 'cloudflare:workers';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);


    // 健康检查，跟原来的 HTTP 服务保持一致
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('watch-together server is running', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    // 房间的真实标识 = 房间号 + 密码，和原实现完全一致。
    // 密码不对的人即使猜中房间号，算出来的 key 不同，会被路由到另一个 DO 实例，
    // 收不到你们的消息。服务端不保存密码，只是把它并入房间键。
    const room = url.searchParams.get('room') || 'default';
    const pass = url.searchParams.get('pass') || '';
    const roomKey = `${room}::${pass}`;

    // idFromName 把同一个字符串稳定映射到同一个 DO 实例，
    // 所以两个人只要房间号+密码一致，就必然落到同一个实例上。
    const id = env.ROOMS.idFromName(roomKey);
    return env.ROOMS.get(id).fetch(request);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    // DO 从休眠中被唤醒时会重跑 constructor，此时内存里的连接列表是空的，
    // 得从运行时把还活着的 WebSocket 捞回来。
    this.sessions = new Set(this.ctx.getWebSockets());

    // 让运行时自己回 ping/pong，不用唤醒 DO。省时长费，也顺手保住连接活性。
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong')
    );
  }

  async fetch(request) {
    const { 0: client, 1: server } = new WebSocketPair();

    // 关键：用 ctx.acceptWebSocket 而不是 server.accept()，这样才可休眠
    this.ctx.acceptWebSocket(server);

    // 同一个人可能开好几个视频页，每页各一条连接。按连接数报人数会把一个人
    // 算成好几个（"我自己开两个页面就显示 2 人"）。所以带上浏览器级的 client
    // 标识，计数时按它去重。attachment 要序列化，DO 休眠唤醒后才能恢复。
    const clientId = new URL(request.url).searchParams.get('client') || '';
    server.serializeAttachment({ clientId });
    this.sessions.add(server);

    const count = this.countPeople();
    // 通知已在房间的人：人数变了
    this.broadcast({ type: 'presence', count }, server);
    // 也告诉刚进来的这条连接当前人数。这条 send 必须在返回 101 之后才能到达
    // 客户端，所以不能直接 send —— 交给 waitUntil 稍后发。
    this.ctx.waitUntil(
      (async () => {
        try {
          server.send(JSON.stringify({ type: 'presence', count }));
        } catch {}
      })()
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  // 房间里的"人数"：按 clientId 去重后的数量。
  // 没带 clientId 的旧版客户端各算一个，退化成原来的按连接计数。
  countPeople() {
    const ids = new Set();
    let anonymous = 0;
    for (const ws of this.sessions) {
      let id = '';
      try {
        id = ws.deserializeAttachment()?.clientId || '';
      } catch {}
      if (id) ids.add(id);
      else anonymous++;
    }
    return ids.size + anonymous;
  }

  // 收到什么就原样转发给同房间的其他人（不含发送者自己）
  async webSocketMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    } catch {
      return; // 非法消息直接忽略
    }
    this.broadcast(msg, ws);
  }

  // 取一条连接的 clientId，取不到返回空串
  clientIdOf(ws) {
    try {
      return ws.deserializeAttachment()?.clientId || '';
    } catch {
      return '';
    }
  }

  async webSocketClose(ws) {
    this.sessions.delete(ws);
    this.broadcast({ type: 'presence', count: this.countPeople() }, null);
  }

  async webSocketError(ws) {
    this.sessions.delete(ws);
  }

  // 把 msg 发给房间里除 except 之外的所有连接。
  // 同一个人的其他标签页也要排除：否则我在 A 页暂停，自己的 B 页也会收到并
  // 跟着暂停，B 页又可能回发一次，来回拉锯。
  broadcast(msg, except) {
    const payload = JSON.stringify(msg);
    const selfId = except ? this.clientIdOf(except) : '';
    for (const client of this.sessions) {
      if (client === except) continue;
      if (selfId && this.clientIdOf(client) === selfId) continue;
      try {
        client.send(payload);
      } catch {
        this.sessions.delete(client); // 已经断了的连接，清掉
      }
    }
  }
}
