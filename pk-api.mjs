// PK 对战 API（纯 Node http 形态）：vite dev 中间件与 server.mjs 共用同一份逻辑
// 匹配队列（6 秒真人配对 / 影子兜底）+ 1s 轮询进度互报 + 双向结算。数据在内存（对局短时）。
import { randomUUID } from 'node:crypto';

// players: Map<playerId, {name, pool, roomId, joinedAt}>
// rooms:   Map<roomId, {level, seed, startedAt, players:[p1,p2], botRoom, finished}>
const players = new Map();
const rooms = new Map();
const queue = []; // 等待配对的 playerId
const recentRuns = []; // 最近真人成绩曲线（影子优先用真人数据）[{name, tr, res}]
const MATCH_WAIT_MS = 6000; // 排队 6 秒没真人 → 配影子
const ROOM_TTL_MS = 15 * 60 * 1000;

function roomCleanup() {
  const now = Date.now();
  for (const [id, r] of rooms) if (now - r.startedAt > ROOM_TTL_MS) rooms.delete(id);
  while (queue.length && !players.has(queue[0])) queue.shift();
}

function pickLevel(pool) {
  const arr = Array.isArray(pool) && pool.length ? pool : ['circus-run'];
  return arr[Math.floor(Math.random() * arr.length)];
}

/** 影子对手：优先真人历史曲线，否则按节奏合成一条（阶梯式加分，像真人判定） */
function makeBot(name) {
  const run = recentRuns.length ? recentRuns[Math.floor(Math.random() * recentRuns.length)] : null;
  const durationMs = 80000;
  const target = run ? run.res.score : 1600 + Math.floor(Math.random() * 2600);
  const tr = [];
  if (run) {
    tr.push(...run.tr);
  } else {
    let t = 2000;
    let score = 0;
    while (t < durationMs && score < target) {
      const step = Math.round((target / durationMs) * (700 + Math.random() * 900) * (0.6 + Math.random() * 1.1));
      score = Math.min(target, score + step);
      tr.push([Math.round(t), score]);
      t += 700 + Math.random() * 900;
    }
    tr.push([durationMs, target]);
  }
  return {
    id: 'bot-' + randomUUID().slice(0, 8),
    name, bot: true,
    tr, target,
    res: run ? run.res : { score: target, combo: 30 + Math.floor(Math.random() * 90), grade: target > 3200 ? 'S' : target > 2400 ? 'A' : 'B' },
    score: 0, progress: 0, done: false, result: null, lastSeen: Date.now(),
  };
}

function botTick(bot, startedAt) {
  const t = Date.now() - startedAt;
  let score = 0;
  for (const [ms, s] of bot.tr) { if (ms <= t) score = s; else break; }
  bot.score = score;
  bot.progress = Math.min(1, t / 80000);
  if (t >= bot.tr[bot.tr.length - 1][0]) { bot.done = true; bot.result = bot.res; }
}

function pub(p) {
  return { name: p.name, score: p.score | 0, progress: +p.progress.toFixed(3), done: !!p.done, isBot: !!p.bot };
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
      send(200, { online: players.size, waiting: queue.length });
      return true;
    }

    if (url.pathname === '/api/pk/join' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '玩家').slice(0, 12) || '玩家';
      const playerId = randomUUID();
      players.set(playerId, { name, pool: Array.isArray(body.pool) ? body.pool : [], roomId: null, joinedAt: Date.now() });
      queue.push(playerId);
      send(200, { playerId, status: 'queued' });
      return true;
    }

    if (url.pathname === '/api/pk/status' && req.method === 'GET') {
      const playerId = url.searchParams.get('playerId') || '';
      const me = players.get(playerId);
      if (!me) { send(404, { error: 'gone' }); return true; }
      if (me.roomId) {
        const room = rooms.get(me.roomId);
        if (!room) { send(404, { error: 'gone' }); return true; }
        const opp = room.players.find((p) => p.id !== playerId);
        send(200, { status: room.botRoom ? 'shadow' : 'matched', roomId: me.roomId, opponent: pub(opp), level: room.level, seed: room.seed });
        return true;
      }
      // 尝试与队列中其他等待者配对
      const idx = queue.indexOf(playerId);
      const otherId = queue.find((id, i) => i !== idx && players.has(id) && !players.get(id).roomId);
      if (otherId) {
        const other = players.get(otherId);
        queue.splice(queue.indexOf(otherId), 1);
        queue.splice(queue.indexOf(playerId), 1);
        const roomId = randomUUID().slice(0, 8);
        const level = pickLevel(me.pool);
        const seed = Math.floor(Math.random() * 1e9);
        const mk = (id, pl) => ({ id, name: pl.name, score: 0, progress: 0, done: false, result: null, lastSeen: Date.now() });
        const room = { level, seed, startedAt: Date.now(), players: [mk(playerId, me), mk(otherId, other)], botRoom: false, finished: false };
        rooms.set(roomId, room);
        me.roomId = roomId; other.roomId = roomId;
        const opp = room.players.find((p) => p.id !== playerId);
        send(200, { status: 'matched', roomId, opponent: pub(opp), level, seed });
        return true;
      }
      // 等超时 → 影子对手
      if (Date.now() - me.joinedAt > MATCH_WAIT_MS) {
        queue.splice(queue.indexOf(playerId), 1);
        const roomId = 'shd-' + randomUUID().slice(0, 8);
        const level = pickLevel(me.pool);
        const seed = Math.floor(Math.random() * 1e9);
        const bot = makeBot(me.name + '的影子');
        const room = { level, seed, startedAt: Date.now(), players: [{ id: playerId, name: me.name, score: 0, progress: 0, done: false, result: null, lastSeen: Date.now() }, bot], botRoom: true, finished: false };
        rooms.set(roomId, room);
        me.roomId = roomId;
        send(200, { status: 'shadow', roomId, opponent: pub(bot), level, seed });
        return true;
      }
      send(200, { status: 'queued' });
      return true;
    }

    if (url.pathname === '/api/pk/sync' && req.method === 'POST') {
      const body = await readBody(req);
      const room = rooms.get(String(body.roomId || ''));
      const me = players.get(String(body.playerId || ''));
      if (!room || !me) { send(404, { error: 'gone' }); return true; }
      const mine = room.players.find((p) => p.id === body.playerId);
      if (mine) {
        mine.score = Math.max(mine.score, Number(body.score) || 0);
        mine.progress = Math.max(mine.progress, Number(body.progress) || 0);
        mine.lastSeen = Date.now();
        if (body.done) mine.done = true;
      }
      const opp = room.players.find((p) => p.id !== body.playerId);
      if (opp?.bot) botTick(opp, room.startedAt);
      send(200, { opponent: pub(opp), myDone: !!mine?.done });
      return true;
    }

    if (url.pathname === '/api/pk/result' && req.method === 'POST') {
      const body = await readBody(req);
      const room = rooms.get(String(body.roomId || ''));
      const me = players.get(String(body.playerId || ''));
      if (!room || !me) { send(404, { error: 'gone' }); return true; }
      const mine = room.players.find((p) => p.id === body.playerId);
      if (mine && !mine.result) {
        mine.result = { score: Number(body.score) || 0, combo: Number(body.combo) || 0, grade: String(body.grade || 'B') };
        mine.done = true;
        mine.score = Math.max(mine.score, mine.result.score);
        mine.progress = 1;
        // 真人成绩曲线留作以后的影子素材
        if (Array.isArray(body.trace) && body.trace.length > 1 && !mine.bot) {
          recentRuns.push({ name: mine.name, tr: body.trace.slice(0, 400), res: mine.result });
          if (recentRuns.length > 50) recentRuns.shift();
        }
      }
      const opp = room.players.find((p) => p.id !== body.playerId);
      if (opp?.bot) {
        botTick(opp, room.startedAt);
        // 我跑完时影子立即结算（影子不弃权，按其目标成绩出分）
        if (mine?.done && !opp.done) { opp.done = true; opp.result = opp.res; }
      }
      send(200, { opponentResult: opp?.result ?? null, opponent: pub(opp) });
      return true;
    }

    if (url.pathname === '/api/pk/leave' && req.method === 'POST') {
      const body = await readBody(req);
      const me = players.get(String(body.playerId || ''));
      if (me) {
        const qi = queue.indexOf(body.playerId);
        if (qi >= 0) queue.splice(qi, 1);
        players.delete(body.playerId);
      }
      send(200, { ok: true });
      return true;
    }

    send(404, { error: 'not found' });
    return true;
  } catch (err) {
    send(500, { error: String(err?.message || err) });
    return true;
  }
}
