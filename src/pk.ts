// 线上 PK 对战：匹配 + 实时进度同步（HTTP 轮询，服务端 server.mjs）
export interface PkOpponent {
  name: string;
  score: number;
  progress: number;
  done: boolean;
  isBot: boolean;
}

export interface PkMatch {
  playerId: string;
  roomId: string;
  opponent: PkOpponent;
  level: string;
  seed: number;
  shadow: boolean;
}

export interface PkResult {
  score: number;
  combo: number;
  grade: string;
}

async function api(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`/api/pk/${path}`, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  if (!res.ok) throw new Error(`pk api ${path} ${res.status}`);
  return res.json();
}

export async function pkOnline(): Promise<number> {
  try { return (await api('online')).online ?? 0; } catch { return 0; }
}

/** 进入匹配：排队 → 轮询到配真人或影子（服务端 6 秒兜底） */
export async function pkJoin(name: string, pool: string[], onTick: (sec: number) => void): Promise<PkMatch> {
  const { playerId } = await api('join', { name, pool });
  const t0 = Date.now();
  for (;;) {
    const st = await api(`status?playerId=${playerId}`);
    if (st.status === 'matched' || st.status === 'shadow') {
      return {
        playerId,
        roomId: st.roomId,
        opponent: st.opponent,
        level: st.level,
        seed: st.seed,
        shadow: st.status === 'shadow',
      };
    }
    onTick(Math.floor((Date.now() - t0) / 1000));
    await new Promise((r) => setTimeout(r, 1000));
    if (Date.now() - t0 > 20000) throw new Error('match timeout');
  }
}

/** 对战中每秒互报进度 */
export async function pkSync(m: PkMatch, score: number, progress: number, done: boolean): Promise<PkOpponent> {
  const r = await api('sync', { playerId: m.playerId, roomId: m.roomId, score, progress, done });
  return r.opponent;
}

/** 跑完上报成绩，拿对手成绩（可能 null=对手未完） */
export async function pkResult(m: PkMatch, r: PkResult, trace: number[][]): Promise<{ opponentResult: PkResult | null; opponent: PkOpponent }> {
  return api('result', { playerId: m.playerId, roomId: m.roomId, score: r.score, combo: r.combo, grade: r.grade, trace });
}

export async function pkLeave(m: PkMatch | null): Promise<void> {
  if (!m) return;
  try { await api('leave', { playerId: m.playerId }); } catch { /* 忽略 */ }
}
