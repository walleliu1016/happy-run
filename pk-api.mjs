// PK 对战 API（纯 Node http 形态）：vite dev 中间件与 server.mjs 共用同一份逻辑
// 竞技模式 = 房间邀请制：创建房间得房码/邀请链接（二维码扫码直达），对方加入后同谱面同时开跑，
// 界面分屏各占一半舞台，1 秒轮询互报实时进度/比分。数据在内存（对局短时，重启即清）。
import { randomUUID } from 'node:crypto';

// rooms: Map<roomCode, {code, level, difficulty, seed, state, startAt, createdAt, players:[p1,p2]}>
// player: {id, name, score, progress, t, combo, done, result, rematch, resultAt, lastSeen}
const rooms = new Map();
const playerRoom = new Map(); // playerId -> roomCode
const ROOM_TTL_MS = 30 * 60 * 1000;

function roomCleanup() {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (now - r.createdAt > ROOM_TTL_MS) {
      for (const p of r.players) playerRoom.delete(p.id);
      rooms.delete(code);
    }
  }
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去易混字符
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function makePlayer(id, name) {
  return {
    id, name,
    score: 0, progress: 0, t: 0, combo: 0,
    done: false, result: null, rematch: false, resultAt: 0,
    lastSeen: Date.now(),
  };
}

function resetDuel(room) {
  room.seed = Math.floor(Math.random() * 1e9);
  room.state = 'playing';
  room.startAt = Date.now() + 4000;
  for (const p of room.players) {
    p.score = 0; p.progress = 0; p.t = 0; p.combo = 0;
    p.done = false; p.result = null; p.rematch = false; p.resultAt = 0;
  }
}

function pub(p) {
  if (!p) return null;
  return {
    name: p.name, score: p.score | 0, progress: +p.progress.toFixed(3),
    t: +p.t.toFixed(2), combo: p.combo | 0, done: !!p.done,
  };
}

function roomView(room, meId) {
  const me = room.players.find((p) => p.id === meId);
  const opp = room.players.find((p) => p.id !== meId);
  return {
    roomCode: room.code,
    state: room.state,
    level: room.level,
    difficulty: room.difficulty,
    seed: room.seed,
    startAt: room.startAt,
    opponent: pub(opp),
    opponentLeft: room.players.length < 2,
    myRematch: !!me?.rematch,
    opponentRematch: !!opp?.rematch,
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 65536) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

/** 处理 /api/pk/* 请求。返回 true = 已处理并结束响应；false = 非 PK 路径（调用方继续） */
export async function handlePkApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!url.pathname.startsWith('/api/pk/')) return false;
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  try {
    roomCleanup();

    if (url.pathname === '/api/pk/online' && req.method === 'GET') {
      send(200, { rooms: rooms.size, players: playerRoom.size });
      return true;
    }

    // 创建房间（房主）：拿房码 → 二维码/链接邀人
    if (url.pathname === '/api/pk/room' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '玩家').slice(0, 12) || '玩家';
      let code = genCode();
      while (rooms.has(code)) code = genCode();
      const me = makePlayer(randomUUID(), name);
      const room = {
        code,
        level: String(body.level || 'circus-run'),
        difficulty: String(body.difficulty || 'normal'),
        seed: 0,
        state: 'waiting',
        startAt: 0,
        createdAt: Date.now(),
        players: [me],
      };
      rooms.set(code, room);
      playerRoom.set(me.id, code);
      send(200, { playerId: me.id, ...roomView(room, me.id) });
      return true;
    }

    // 加入房间（扫码/链接/输房码）：两人到齐即开（startAt = 4 秒后，VS 倒计时）
    if (url.pathname === '/api/pk/room-join' && req.method === 'POST') {
      const body = await readBody(req);
      const code = String(body.roomCode || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) { send(404, { error: 'gone' }); return true; }
      if (room.players.length >= 2) { send(409, { error: 'full' }); return true; }
      const name = String(body.name || '玩家').slice(0, 12) || '玩家';
      const me = makePlayer(randomUUID(), name);
      room.players.push(me);
      playerRoom.set(me.id, code);
      resetDuel(room); // state='playing' + startAt=+4s + 新谱面 seed
      send(200, { playerId: me.id, ...roomView(room, me.id) });
      return true;
    }

    // 房间状态轮询（等待对手 / 对手再来一局 / 对手离开）
    if (url.pathname === '/api/pk/room-status' && req.method === 'GET') {
      const playerId = url.searchParams.get('playerId') || '';
      const code = playerRoom.get(playerId);
      const room = code ? rooms.get(code) : null;
      if (!room || !room.players.some((p) => p.id === playerId)) { send(404, { error: 'gone' }); return true; }
      send(200, roomView(room, playerId));
      return true;
    }

    // 对局中每秒互报：比分 / 进度 / 对手舞台时钟（分屏镜像用）
    if (url.pathname === '/api/pk/sync' && req.method === 'POST') {
      const body = await readBody(req);
      const room = room_of(body);
      const me = players_get(room, body.playerId);
      if (!room || !me) { send(404, { error: 'gone' }); return true; }
      me.score = Math.max(me.score, Number(body.score) || 0);
      me.progress = Math.max(me.progress, Number(body.progress) || 0);
      me.t = Math.max(me.t, Number(body.t) || 0);
      me.combo = Number(body.combo) || 0;
      me.lastSeen = Date.now();
      if (body.done) me.done = true;
      const opp = room.players.find((p) => p.id !== body.playerId);
      send(200, { opponent: pub(opp), myDone: !!me.done });
      return true;
    }

    // 完赛结算（幂等）：双方都交卷 → 房间 finished
    if (url.pathname === '/api/pk/result' && req.method === 'POST') {
      const body = await readBody(req);
      const room = room_of(body);
      const me = players_get(room, body.playerId);
      if (!room || !me) { send(404, { error: 'gone' }); return true; }
      if (!me.result) {
        me.result = { score: Number(body.score) || 0, combo: Number(body.combo) || 0, grade: String(body.grade || 'B') };
        me.done = true;
        me.resultAt = Date.now();
        me.score = Math.max(me.score, me.result.score);
        me.progress = 1;
      }
      const opp = room.players.find((p) => p.id !== body.playerId);
      if (room.players.length === 2 && room.players.every((p) => p.result)) room.state = 'finished';
      send(200, { opponentResult: opp?.result ?? null, opponent: pub(opp), opponentLeft: room.players.length < 2 });
      return true;
    }

    // 再来一局：双方都点 → 同房间新谱面重开
    if (url.pathname === '/api/pk/rematch' && req.method === 'POST') {
      const body = await readBody(req);
      const room = room_of(body);
      const me = players_get(room, body.playerId);
      if (!room || !me) { send(404, { error: 'gone' }); return true; }
      me.rematch = true;
      let both = false;
      if (room.players.length === 2 && room.players.every((p) => p.rematch)) {
        resetDuel(room);
        both = true;
      }
      send(200, { both, ...roomView(room, body.playerId) });
      return true;
    }

    // 离开房间（人走房空自动清）
    if (url.pathname === '/api/pk/leave' && req.method === 'POST') {
      const body = await readBody(req);
      const playerId = String(body.playerId || '');
      const code = playerRoom.get(playerId);
      const room = code ? rooms.get(code) : null;
      if (room) {
        room.players = room.players.filter((p) => p.id !== playerId);
        if (!room.players.length) rooms.delete(code);
      }
      playerRoom.delete(playerId);
      send(200, { ok: true });
      return true;
    }

    send(404, { error: 'not found' });
    return true;
  } catch (err) {
    send(500, { error: String(err?.message || err) });
    return true;
  }

  function room_of(body) {
    const code = String(body.roomCode || '');
    const byCode = code ? rooms.get(code) : null;
    if (byCode) return byCode;
    // 兜底：只报 playerId 也能定位房间（playerRoom 是权威映射）
    const viaPlayer = playerRoom.get(String(body.playerId || ''));
    return viaPlayer ? rooms.get(viaPlayer) || null : null;
  }
  function players_get(room, id) {
    return room ? room.players.find((p) => p.id === id) : null;
  }
}
