// PK 对战服务端（零依赖 Node）：托管 dist + 在线匹配 + 实时进度同步 + 影子对手兜底
// 数据在内存（对局短时，重启即清），单端口 HTTP 轮询（不赌反代 WebSocket）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');
const PORT = Number(process.env.PORT || 43212);
const HOST = '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.woff2': 'font/woff2',
};

// ---------- 匹配与房间状态（内存） ----------
// players: Map<playerId, {name, roomId, joinedAt}>
// rooms:   Map<roomId, {level, seed, startedAt, players:[p1,p2], bot?, finished}>
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
  const arr = Array.isArray(pool) && pool.length ? pool : ['lv1'];
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
    // 合成曲线：每 0.7~1.6 秒一次加分事件，miss 偶尔停顿
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

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  try {
    if (url.pathname.startsWith('/api/pk/')) {
      roomCleanup();

      if (url.pathname === '/api/pk/online' && req.method === 'GET') {
        return send(200, { online: players.size, waiting: queue.length });
      }

      if (url.pathname === '/api/pk/join' && req.method === 'POST') {
        const body = await readBody(req);
        const name = String(body.name || '玩家').slice(0, 12) || '玩家';
        const playerId = randomUUID();
        players.set(playerId, { name, pool: Array.isArray(body.pool) ? body.pool : [], roomId: null, joinedAt: Date.now() });
        queue.push(playerId);
        return send(200, { playerId, status: 'queued' });
      }

      if (url.pathname === '/api/pk/status' && req.method === 'GET') {
        const playerId = url.searchParams.get('playerId') || '';
        const me = players.get(playerId);
        if (!me) return send(404, { error: 'gone' });
        if (me.roomId) {
          const room = rooms.get(me.roomId);
          if (!room) return send(404, { error: 'gone' });
          const opp = room.players.find((p) => p.id !== playerId);
          return send(200, { status: room.botRoom ? 'shadow' : 'matched', roomId: me.roomId, opponent: pub(opp), level: room.level, seed: room.seed });
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
          return send(200, { status: 'matched', roomId, opponent: pub(opp), level, seed });
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
          return send(200, { status: 'shadow', roomId, opponent: pub(bot), level, seed });
        }
        return send(200, { status: 'queued' });
      }

      if (url.pathname === '/api/pk/sync' && req.method === 'POST') {
        const body = await readBody(req);
        const room = rooms.get(String(body.roomId || ''));
        const me = players.get(String(body.playerId || ''));
        if (!room || !me) return send(404, { error: 'gone' });
        const mine = room.players.find((p) => p.id === body.playerId);
        if (mine) {
          mine.score = Math.max(mine.score, Number(body.score) || 0);
          mine.progress = Math.max(mine.progress, Number(body.progress) || 0);
          mine.lastSeen = Date.now();
          if (body.done) { mine.done = true; }
        }
        const opp = room.players.find((p) => p.id !== body.playerId);
        if (opp?.bot) botTick(opp, room.startedAt);
        return send(200, { opponent: pub(opp), myDone: !!mine?.done });
      }

      if (url.pathname === '/api/pk/result' && req.method === 'POST') {
        const body = await readBody(req);
        const room = rooms.get(String(body.roomId || ''));
        const me = players.get(String(body.playerId || ''));
        if (!room || !me) return send(404, { error: 'gone' });
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
        return send(200, { opponentResult: opp?.result ?? null, opponent: pub(opp) });
      }

      if (url.pathname === '/api/pk/leave' && req.method === 'POST') {
        const body = await readBody(req);
        const me = players.get(String(body.playerId || ''));
        if (me) {
          const qi = queue.indexOf(body.playerId);
          if (qi >= 0) queue.splice(qi, 1);
          players.delete(body.playerId);
        }
        return send(200, { ok: true });
      }

      return send(404, { error: 'not found' });
    }

    // 静态托管 dist
    serveStatic(url.pathname, res);
  } catch (err) {
    send(500, { error: String(err?.message || err) });
  }
});

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 65536) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(DIST, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(DIST)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA 兜底
      fs.readFile(path.join(DIST, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(idx);
      });
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`warmingup-run PK server on ${HOST}:${PORT}`);
});
