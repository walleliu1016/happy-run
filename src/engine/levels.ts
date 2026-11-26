import type { Chart, ChartEvent, ChartPhase, Difficulty, GameAction, SceneTheme } from '../types';
import { assignLanes } from './chart';

/**
 * 关卡系统（1:1 对标 B 站 WarmingUp 数字神奇马戏团）：
 * LV1 CIRCUS RUN      第一人称跑酷闪避（左右移 + 跳 + 拳）
 * LV2 GLASS BRIDGE    玻璃桥左右二选一（走错即碎）
 * LV3 STAY BEAT       节奏踩拍（5 动作全开 + COMBO）
 * LV4 RED LIGHT GREEN LIGHT  红灯停绿灯行（红灯乱动受罚）
 * BONUS 墙来          摆姿势穿墙（人形洞口墙板飞来）
 */
export type LevelKind = 'run' | 'bridge' | 'beat' | 'redlight' | 'wall';

export interface LevelDef {
  id: string;
  /** 海报大字：LV1..LV4 / BONUS */
  lv: string;
  nameEn: string;
  nameCn: string;
  kind: LevelKind;
  theme: SceneTheme;
  /** 本关动作池（决定车道布局与出砖种类） */
  pool: GameAction[];
  /** 过场卡文案（黑底速度线，中英双语） */
  introEn: string;
  introCn: string;
  /** 海报配色与剪影 */
  poster: { emoji: string; accent: string; sub: string };
  durationSec: number;
  bpm: number;
}

export const LEVELS: LevelDef[] = [
  {
    id: 'circus-run',
    lv: 'LV1',
    nameEn: 'CIRCUS RUN',
    nameCn: '马戏团跑酷',
    kind: 'run',
    theme: 'neon',
    pool: ['left', 'right', 'jump', 'punch'],
    introEn: 'YOU WILL HAVE TO GO THROUGH 4 CHALLENGING LEVELS',
    introCn: '你将完成 4 个挑战关卡',
    poster: { emoji: '🎪', accent: '#FF7A1A', sub: '跑酷逃杀 · 闪避踩砖' },
    durationSec: 45,
    bpm: 126,
  },
  {
    id: 'glass-bridge',
    lv: 'LV2',
    nameEn: 'GLASS BRIDGE',
    nameCn: '玻璃桥',
    kind: 'bridge',
    theme: 'space',
    pool: ['left', 'right'],
    introEn: 'CHOOSE THE RIGHT GLASS PANEL — ONE WRONG STEP AND IT SHATTERS',
    introCn: '选对玻璃板，走错一步就碎裂坠落',
    poster: { emoji: '🪟', accent: '#FFC233', sub: '左右二选一 · 走错即碎' },
    durationSec: 45,
    bpm: 118,
  },
  {
    id: 'stay-beat',
    lv: 'LV3',
    nameEn: 'STAY BEAT',
    nameCn: '节奏踩拍',
    kind: 'beat',
    theme: 'neon',
    pool: ['jump', 'squat', 'punch', 'stomp', 'run'],
    introEn: 'STAY ON THE BEAT — KEEP THE COMBO ALIVE',
    introCn: '踩准节拍，保持连击不断',
    poster: { emoji: '🎵', accent: '#FF6B3D', sub: '动作碎裂 · COMBO 连击' },
    durationSec: 50,
    bpm: 128,
  },
  {
    id: 'red-light',
    lv: 'LV4',
    nameEn: 'RED LIGHT GREEN LIGHT',
    nameCn: '红灯停绿灯行',
    kind: 'redlight',
    theme: 'forest',
    pool: ['run', 'stomp'],
    introEn: 'RED LIGHT — FREEZE! GREEN LIGHT — MOVE!',
    introCn: '红灯定格不许动，绿灯全力冲刺',
    poster: { emoji: '🚦', accent: '#C4243B', sub: '红绿灯 · 动检惩罚' },
    durationSec: 50,
    bpm: 120,
  },
  {
    id: 'wall-bonus',
    lv: 'BONUS',
    nameEn: 'WALL INCOMING',
    nameCn: '墙来',
    kind: 'wall',
    theme: 'neon',
    pool: ['jump', 'squat', 'punch', 'stomp'],
    introEn: 'STRIKE THE POSE — PASS THROUGH THE WALL',
    introCn: '摆出姿势，穿过人形洞口',
    poster: { emoji: '🧱', accent: '#C6FF4D', sub: '姿势穿墙 · 终极挑战' },
    durationSec: 45,
    bpm: 122,
  },
];

export function levelById(id: string): LevelDef {
  return LEVELS.find((l) => l.id === id) ?? LEVELS[0];
}

export function nextLevel(id: string): LevelDef | null {
  const i = LEVELS.findIndex((l) => l.id === id);
  return i >= 0 && i + 1 < LEVELS.length ? LEVELS[i + 1] : null;
}

// ================= 关卡谱面生成 =================

/** 各难度每小节（4 拍）出砖位 */
const DENSITY: Record<Difficulty, number[]> = {
  easy: [0],
  normal: [0, 2],
  hard: [0, 1, 2, 3],
};

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 按关卡定义生成谱面：
 * - run：左右闪避 + 跳/拳交替（随机序列，seed 可复现）
 * - bridge：左右二选一序列（偶数拍左、奇数拍右，随机翻转）
 * - beat：5 动作循环 + 金砖（保持节奏踩拍手感）
 * - redlight：绿灯窗口内出 run/stomp，附 phases 红绿窗口
 * - wall：4 姿势循环出砖（墙板样式由 game 层负责）
 */
export function buildLevelChart(def: LevelDef, difficulty: Difficulty, seed = 0): Chart {
  const rnd = mulberry(seed * 7919 + def.id.length * 131);
  const beatDur = 60 / def.bpm;
  const lastBeat = Math.max(16, Math.floor(def.durationSec / beatDur) - 2);
  const events: ChartEvent[] = [];
  const phases: ChartPhase[] = [];
  const pool = def.pool;
  const push = (beat: number, action: GameAction, gold = false, window?: number): void => {
    events.push({ beat, action, gold: gold || undefined, window });
  };

  if (def.kind === 'redlight') {
    // 红绿灯窗口：绿 4 拍 / 红 2 拍（hard 红 3 拍更险）
    const goLen = 4;
    const stopLen = difficulty === 'hard' ? 3 : 2;
    let cursor = 0;
    let go = true;
    while (cursor < lastBeat) {
      const len = go ? goLen : stopLen;
      phases.push({ startBeat: cursor, lenBeats: len, kind: go ? 'go' : 'stop' });
      if (go) {
        for (let b = cursor; b < cursor + len && b < lastBeat; b += 2) {
          push(b, pool[Math.floor(rnd() * pool.length)], rnd() > 0.82);
        }
      }
      cursor += len;
      go = !go;
    }
    assignLanes(events, seed); // 3 跑道：出现在哪条道就渲染在哪条道
    return { bpm: def.bpm, events, phases, offsetSec: 0 };
  }

  for (let bar = 1; bar * 4 <= lastBeat; bar++) {
    const barStart = bar * 4;
    for (const pos of DENSITY[difficulty]) {
      const beat = barStart + pos;
      let action: GameAction;
      if (def.kind === 'bridge') {
        // 左右二选一：随机选边（玻璃板），偶数砖偏左奇数偏右再随机翻转
        const flip = rnd() > 0.75;
        action = (((bar + pos) % 2 === 0) !== flip) ? 'left' : 'right';
      } else if (def.kind === 'beat') {
        action = pool[(bar + pos + seed) % pool.length];
      } else if (def.kind === 'wall') {
        action = pool[(bar + Math.floor(pos / 2) + seed) % pool.length];
      } else {
        // run：闪避为主（60%），跳/拳补位
        const r = rnd();
        action = r < 0.3 ? 'left' : r < 0.6 ? 'right' : r < 0.8 ? 'jump' : 'punch';
      }
      const gold = (bar + pos) % 8 === 0 && rnd() > 0.5;
      push(beat, action, gold, def.kind === 'wall' ? 1.25 : undefined);
    }
    // hard：反拍加砖（wall/run 不加，避免超纲）
    if (difficulty === 'hard' && (def.kind === 'beat' || def.kind === 'bridge')) {
      push(barStart + 2.5, pool[(bar * 3 + seed) % pool.length]);
    }
  }

  assignLanes(events, seed); // 3 跑道：出现在哪条道就渲染在哪条道
  return { bpm: def.bpm, events, phases: phases.length ? phases : undefined, offsetSec: 0 };
}
