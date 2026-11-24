// 线上 PK 竞技模式：房间邀请制（HTTP 轮询，服务端 pk-api.mjs）
// 创建房间 → 二维码/链接邀人 → 加入即开（同谱面 seed）→ 分屏实时互报 → 结算/再来一局
export interface PkPlayer {
  name: string;
  score: number;
  progress: number;
  /** 对手舞台时钟（秒，分屏镜像用） */
  t: number;
  combo: number;
  done: boolean;
}

export interface PkRoomState {
  playerId: string;
  roomCode: string;
  state: 'waiting' | 'playing' | 'finished';
  level: string;
  difficulty: string;
  seed: number;
  startAt: number;
  opponent: PkPlayer | null;
  opponentLeft: boolean;
  myRematch: boolean;
  opponentRematch: boolean;
}

export interface PkResult {
  score: number;
  combo: number;
  grade: string;
}

/** 房间大厅列表项（公开房间） */
export interface PkRoomListItem {
  code: string;
  level: string;
  difficulty: string;
  host: string;
  players: number;
  maxPlayers: number;
  state: 'waiting' | 'playing' | 'finished';
  createdAt: number;
}

export interface PkRoomList {
  rooms: PkRoomListItem[];
  joinable: number;
  playing: number;
}

async function api(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`/api/pk/${path}`, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  if (!res.ok) throw new Error(`pk api ${path} ${res.status}`);
  return res.json();
}

function toState(playerId: string, r: any): PkRoomState {
  return { playerId, ...r };
}

export async function pkOnline(): Promise<{ rooms: number; players: number }> {
  try { return await api('online'); } catch { return { rooms: 0, players: 0 }; }
}

/** 房间大厅：公开房间列表（可加入 + 对局中） */
export async function pkRoomList(): Promise<PkRoomList> {
  try { return await api('rooms'); } catch { return { rooms: [], joinable: 0, playing: 0 }; }
}

/** 创建房间（房主）：拿房码去邀人；isPublic=true 公开到大厅 */
export async function pkCreateRoom(
  name: string, level: string, difficulty: string, isPublic = true,
): Promise<PkRoomState> {
  const r = await api('room', { name, level, difficulty, public: isPublic });
  return toState(r.playerId, r);
}

/** 加入房间（扫码 / 链接 / 输房码）：两人到齐即进入开跑倒计时 */
export async function pkJoinRoom(roomCode: string, name: string): Promise<PkRoomState> {
  const r = await api('room-join', { roomCode: roomCode.trim().toUpperCase(), name });
  return toState(r.playerId, r);
}

/** 房间状态轮询（等对手 / 再来一局 / 对手离开） */
export async function pkRoomStatus(m: { playerId: string }): Promise<PkRoomState> {
  const r = await api(`room-status?playerId=${encodeURIComponent(m.playerId)}`);
  return toState(m.playerId, r);
}

/** 对局中每秒互报（比分 / 进度 / 舞台时钟） */
export async function pkSync(
  m: Pick<PkRoomState, 'playerId' | 'roomCode'>,
  s: { score: number; progress: number; t: number; combo: number; done: boolean },
): Promise<PkPlayer | null> {
  const r = await api('sync', { playerId: m.playerId, roomCode: m.roomCode, ...s });
  return r.opponent;
}

/** 完赛上报（幂等）；对手未交卷时 opponentResult 为 null */
export async function pkResult(
  m: Pick<PkRoomState, 'playerId' | 'roomCode'>,
  r: PkResult,
): Promise<{ opponentResult: PkResult | null; opponent: PkPlayer | null; opponentLeft: boolean }> {
  return api('result', { playerId: m.playerId, roomCode: m.roomCode, ...r });
}

/** 再来一局：双方都点 → 同房间新谱面重开 */
export async function pkRematch(m: Pick<PkRoomState, 'playerId' | 'roomCode'>): Promise<{ both: boolean }> {
  const r = await api('rematch', { playerId: m.playerId, roomCode: m.roomCode });
  return { both: !!r.both };
}

export async function pkLeave(m: { playerId: string; roomCode: string } | null): Promise<void> {
  if (!m?.playerId) return;
  try { await api('leave', { playerId: m.playerId, roomCode: m.roomCode }); } catch { /* 忽略 */ }
}
