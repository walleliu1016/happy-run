// P1 影子挑战：把一局的谱面 + 分数时间轴压进 URL 链接，好友同谱面竞速。
// 零后端——影子数据本身就是合法性证据（时间轴节奏可校验）。
import type { Chart, ChartEvent, GameAction, GameStats } from '../types';

const ACTIONS: GameAction[] = ['jump', 'squat', 'punch', 'stomp', 'run', 'left', 'right'];

export interface GhostData {
  v: 1;
  name: string;
  date: string;
  bpm: number;
  off: number;
  /** 紧凑谱面 [tMs, actionIdx, lane+1, gold, window*100] */
  ev: number[][];
  /** 红绿灯段 [startBeat*100, lenBeats*100, kind(0=go,1=stop)] */
  ph: number[][];
  /** 分数时间轴 [elapsedMs, score]（仅在分数变化时采样） */
  tr: number[][];
  res: { score: number; combo: number; grade: string };
}

/** 拍点 → 歌曲时间（秒），与 game.ts 的判定时钟同一口径 */
function beatToSec(beat: number, bpm: number, off: number): number {
  return (beat * 60) / bpm + off;
}

function chartToCompact(chart: Chart): { ev: number[][]; ph: number[][] } {
  const off = chart.offsetSec ?? 0;
  const ev = chart.events.map((e) => [
    Math.round(beatToSec(e.beat, chart.bpm, off) * 1000),
    ACTIONS.indexOf(e.action),
    (e.lane ?? -1) + 1,
    e.gold ? 1 : 0,
    Math.round((e.window ?? 1) * 100),
  ]);
  const ph = (chart.phases ?? []).map((p) => [
    Math.round(p.startBeat * 100),
    Math.round(p.lenBeats * 100),
    p.kind === 'stop' ? 1 : 0,
  ]);
  return { ev, ph };
}

/** 影子 → 谱面（同谱面竞速：好友按你的谱子重打一局） */
export function chartFromGhost(g: GhostData): Chart {
  const events: ChartEvent[] = g.ev.map(([tMs, ai, laneP1, gold, w100]) => ({
    beat: ((tMs / 1000 - g.off) * g.bpm) / 60,
    action: (ACTIONS[ai] ?? 'jump') as GameAction,
    lane: laneP1 > 0 ? laneP1 - 1 : undefined,
    gold: gold === 1 ? true : undefined,
    window: w100 !== 100 ? w100 / 100 : undefined,
  }));
  return {
    bpm: g.bpm,
    events,
    offsetSec: g.off,
    phases: g.ph.map(([sb, lb, k]) => ({
      startBeat: sb / 100,
      lenBeats: lb / 100,
      kind: k === 1 ? ('stop' as const) : ('go' as const),
    })),
  };
}

export function ghostFromRun(
  chart: Chart,
  trace: number[][],
  stats: GameStats,
  grade: string,
  name = '挑战者',
): GhostData {
  const { ev, ph } = chartToCompact(chart);
  return {
    v: 1,
    name,
    date: new Date().toISOString().slice(0, 10),
    bpm: chart.bpm,
    off: chart.offsetSec ?? 0,
    ev,
    ph,
    tr: trace,
    res: { score: stats.score, combo: stats.maxCombo, grade },
  };
}

/** 影子在 t 毫秒时的分数（线性取最后采样点） */
export function ghostScoreAt(g: GhostData, ms: number): number {
  const tr = g.tr;
  if (!tr.length) return 0;
  // tr 按时间升序；二分太重，线性扫足够（<500 点）
  let score = 0;
  for (const [t, s] of tr) {
    if (t <= ms) score = s;
    else break;
  }
  return score;
}

function toUrlSafe(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromUrlSafe(s: string): string {
  return s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
}

export function encodeGhost(g: GhostData): string {
  const json = JSON.stringify(g);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return toUrlSafe(btoa(bin));
}

export function decodeGhost(s: string): GhostData | null {
  try {
    const bin = atob(fromUrlSafe(s));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const g = JSON.parse(new TextDecoder().decode(bytes)) as GhostData;
    if (g.v !== 1 || !Array.isArray(g.ev) || !Array.isArray(g.tr)) return null;
    return g;
  } catch {
    return null;
  }
}

export function ghostShareUrl(g: GhostData): string {
  return `${location.origin}${location.pathname}#ghost=${encodeGhost(g)}`;
}

/** 从地址栏解析影子挑战（一次性，读后清掉 hash） */
export function parseGhostHash(): GhostData | null {
  const m = location.hash.match(/#ghost=([A-Za-z0-9\-_]+)/);
  if (!m) return null;
  return decodeGhost(m[1]);
}
