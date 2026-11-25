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

// ---------- 在线玩家 + 点对点 PK 邀请（/api/pk/presence 系列） ----------
/** 在线玩家（列表排除自己；busy = 已在房间/对局中） */
export interface PresenceUser {
  id: string;
  name: string;
  busy: string;
}

export interface PkInvite {
  id: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  level: string;
  difficulty: string;
  /** pending | accepted | rejected | cancelled | expired */
  state: string;
  ts: number;
}

export interface PresenceState {
  online: PresenceUser[];
  /** 发给我的待回应邀请 */
  invites: PkInvite[];
  /** 我发出的邀请（含结果，用于反馈「已被接受/拒绝」） */
  myInvites: PkInvite[];
  /** 我该进入的房间（我发的邀请被接受，或我同意的邀请已建房） */
  joinRoom: PkRoomState | null;
}

/** 心跳：注册在线 + 拉取在线列表/邀请/被接受的房间 */
export async function pkPresence(playerId: string, name: string): Promise<PresenceState> {
  const r = await api('presence', { playerId, name });
  return {
    online: r.online ?? [],
    invites: r.invites ?? [],
    myInvites: r.myInvites ?? [],
    joinRoom: r.joinRoom ? toState(r.joinRoom.playerId, r.joinRoom) : null,
  };
}

/** 发起 PK 邀请（目标须在线且空闲） */
export async function pkInvite(
  fromId: string, fromName: string, toId: string, level: string, difficulty: string,
): Promise<PkInvite> {
  return api('invite', { fromId, fromName, toId, level, difficulty });
}

/** 回应邀请：接受时返回房间视图（形状同加入房间），直接进 VS 开跑；拒绝返回 null */
export async function pkInviteRespond(
  inviteId: string, playerId: string, accept: boolean,
): Promise<PkRoomState | null> {
  const r = await api('invite-respond', { inviteId, playerId, accept });
  if (!r.accepted) return null;
  return toState(r.playerId, r);
}

/** 撤销发出的邀请 */
export async function pkInviteCancel(inviteId: string, playerId: string): Promise<void> {
  try { await api('invite-cancel', { inviteId, playerId }); } catch { /* 忽略 */ }
}

// ---------- 全服排行榜（/api/lb/*） ----------
export interface LbEntry {
  rank: number;
  name: string;
  score: number;
  combo: number;
  grade: string;
  ts: number;
}

export interface LbBoard {
  level: string;
  top: LbEntry[];
  total: number;
}

export interface LbSubmitResult extends LbBoard {
  /** 本次成绩名次（0 = 未进 top50） */
  rank: number;
  improved: boolean;
}

async function lbApi(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`/api/lb/${path}`, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  if (!res.ok) throw new Error(`lb api ${path} ${res.status}`);
  return res.json();
}

/** 取榜（每关 top 20） */
export async function lbBoard(level: string): Promise<LbBoard> {
  try { return await lbApi(`board?level=${encodeURIComponent(level)}`); }
  catch { return { level, top: [], total: 0 }; }
}

/** 交卷上榜（每关保留 top 50） */
export async function lbSubmit(
  level: string, name: string, score: number, combo: number, grade: string,
): Promise<LbSubmitResult> {
  return lbApi('submit', { level, name, score, combo, grade });
}
