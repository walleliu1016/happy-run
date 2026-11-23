/** 全局共享类型 */

export type GameAction = 'jump' | 'squat' | 'punch' | 'stomp' | 'run' | 'left' | 'right';

export type SceneMode = 'class' | 'train' | 'pk';
export type InputSource = 'direct' | 'phone' | 'pad';

/** 判定四档：完成时刻落在拍点窗口内的精度 */
export type JudgeQuality = 'perfect' | 'great' | 'good' | 'miss';

/** 难度 = 谱面密度系数 */
export type Difficulty = 'easy' | 'normal' | 'hard';

/** 节奏风格 = 动作配比（谱面生成参数） */
export type ChartStyle = 'mix' | 'punch' | 'jump' | 'cardio';

/** 背景主题（4 预设 + 自定义图片） */
export type SceneTheme = 'neon' | 'space' | 'candy' | 'forest' | 'custom';

/** 教练皮肤（6 款 + 自定义人物图片） */
export type CoachSkin = 'mage' | 'flame' | 'frost' | 'nature' | 'candy' | 'gold' | 'custom';

/** 段落类型（密度/金砖规则按段落走） */
export type SectionKind = 'intro' | 'verse' | 'chorus' | 'break' | 'outro';

export interface ChartEvent {
  /** 相对歌曲起点的拍号（0-based，支持小数拍） */
  beat: number;
  action: GameAction;
  /** 三跑道之一（0/1/2 = 世界左/中/右道）：事件出现在哪条道，块就渲染在哪条道 */
  lane?: number;
  /** Gold Move 金砖：高亮 + 双倍分 */
  gold?: boolean;
  /** 判定窗口倍率（默认 1；run 等持续动作用大于 1） */
  window?: number;
}

export interface ChartSection {
  startBeat: number;
  lenBeats: number;
  kind: SectionKind;
  /** 密度/强度系数 0.6–1.25 */
  intensity: number;
}

/** 红灯绿灯窗口（LV4 RED LIGHT GREEN LIGHT）：go=绿灯可动，stop=红灯必须定格 */
export interface ChartPhase {
  startBeat: number;
  lenBeats: number;
  kind: 'go' | 'stop';
}

export interface Chart {
  bpm: number;
  events: ChartEvent[];
  /** 第 0 拍相对音频起点的偏移（秒），用于对齐自定义音乐的节拍网格 */
  offsetSec?: number;
  /** 段落结构（砖块密度与金砖规则按段落走） */
  sections?: ChartSection[];
  /** 红绿灯窗口（缺省无红灯机制） */
  phases?: ChartPhase[];
}

export interface JudgeResult {
  event: ChartEvent;
  quality: JudgeQuality;
  /** 动作完成时刻相对拍点的偏差（秒，正 = 偏晚） */
  offset: number;
  /** 命中倍率 ×1/×2/×3/×4 */
  multiplier: number;
  /** 是否金砖命中 */
  gold: boolean;
}

export interface GameStats {
  score: number;
  combo: number;
  maxCombo: number;
  hits: number;
  total: number;
  kcal: number;
  /** 分档命中统计 */
  perfects: number;
  greats: number;
  goods: number;
  misses: number;
  /** 金砖命中数 */
  golds: number;
  /** 当前连击倍率 1–4 */
  multiplier: number;
}

export function emptyStats(total = 0): GameStats {
  return {
    score: 0, combo: 0, maxCombo: 0, hits: 0, total, kcal: 0,
    perfects: 0, greats: 0, goods: 0, misses: 0, golds: 0, multiplier: 1,
  };
}

/** 连击 → 得分倍率（×1/×2/×3/×4） */
export function comboMultiplier(combo: number): number {
  if (combo >= 50) return 4;
  if (combo >= 25) return 3;
  if (combo >= 10) return 2;
  return 1;
}
