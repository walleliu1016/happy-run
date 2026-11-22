import type {
  Chart, ChartEvent, ChartSection, ChartStyle, Difficulty, GameAction, SectionKind,
} from '../types';

/** 动作 → 中文口令 */
export const ACTION_LABEL: Record<GameAction, string> = {
  jump: '跳！',
  squat: '蹲！',
  punch: '挥臂！',
  stomp: '踩踏！',
  run: '原地跑！',
  left: '左移！',
  right: '右移！',
};

/** 动作 → 英文口令（1:1 复刻圆盘口令组件：JUMP!/PUNCH!/SLAP! 风格） */
export const ACTION_LABEL_EN: Record<GameAction, string> = {
  jump: 'JUMP!',
  squat: 'SQUAT!',
  punch: 'PUNCH!',
  stomp: 'STOMP!',
  run: 'RUN!',
  left: 'LEFT!',
  right: 'RIGHT!',
};

/**
 * 判定窗口（秒，半宽）——按"动作完成时刻"判定。
 * 摄像头体感链路延迟 ~100–200ms，窗口按体感宽窗设计（对比按键音游 ±25ms）。
 */
export const ACTION_WINDOW: Record<GameAction, { perfect: number; great: number; good: number }> = {
  jump: { perfect: 0.1, great: 0.18, good: 0.28 },
  squat: { perfect: 0.1, great: 0.18, good: 0.28 },
  punch: { perfect: 0.1, great: 0.18, good: 0.28 },
  stomp: { perfect: 0.1, great: 0.18, good: 0.28 },
  run: { perfect: 0.5, great: 0.9, good: 1.3 },
  left: { perfect: 0.12, great: 0.2, good: 0.3 },
  right: { perfect: 0.12, great: 0.2, good: 0.3 },
};

const actionColor: Record<GameAction, string> = {
  jump: '#ff9500',
  squat: '#af52de',
  punch: '#ff3b30',
  stomp: '#34c759',
  run: '#0071e3',
  left: '#5ac8fa',
  right: '#ffd60a',
};
export const ACTION_COLOR = actionColor;

/** 动作 → pictogram（时间轴/砖块图标共用） */
export const ACTION_GLYPH: Record<GameAction, string> = {
  jump: '🦘', squat: '🧎', punch: '👊', stomp: '👣', run: '🏃',
  left: '👈', right: '👉',
};

/** 金砖颜色 */
export const GOLD_COLOR = '#ffd60a';

/** 5 条车道的横向位置（jump/squat/punch/stomp/run 从左到右） */
export const LANE_ORDER: GameAction[] = ['jump', 'squat', 'punch', 'stomp', 'run'];

// ================= 节奏风格（动作配比） =================

export const STYLE_LABEL: Record<ChartStyle, string> = {
  mix: '全身综合',
  punch: '拳击为主',
  jump: '跳跃为主',
  cardio: '燃脂冲刺',
};

export const STYLE_DESC: Record<ChartStyle, string> = {
  mix: '五种动作均衡编排，全身都练到',
  punch: '挥臂击打占大头，上肢爆发',
  jump: '跳跃蹲起为主，练腿练核心',
  cardio: '冲刺踏步拉满，心率燃脂向',
};

/** 各风格小节内 4 拍的动作序列（奇偶小节交替，seed 旋转打散） */
const STYLE_PATTERNS: Record<ChartStyle, { a: GameAction[]; b: GameAction[] }> = {
  mix:    { a: ['jump', 'punch', 'squat', 'punch'], b: ['stomp', 'squat', 'jump', 'punch'] },
  punch:  { a: ['punch', 'stomp', 'punch', 'jump'], b: ['punch', 'punch', 'squat', 'stomp'] },
  jump:   { a: ['jump', 'squat', 'jump', 'punch'], b: ['squat', 'jump', 'stomp', 'jump'] },
  cardio: { a: ['stomp', 'jump', 'punch', 'stomp'], b: ['jump', 'stomp', 'punch', 'stomp'] },
};

// ================= 内置合成乐的段落结构（audio.ts 同步消费） =================

export const DEFAULT_SECTIONS: ChartSection[] = [
  { startBeat: 0, lenBeats: 8, kind: 'intro', intensity: 0.55 },
  { startBeat: 8, lenBeats: 16, kind: 'verse', intensity: 0.8 },
  { startBeat: 24, lenBeats: 16, kind: 'chorus', intensity: 1.15 },
  { startBeat: 40, lenBeats: 16, kind: 'verse', intensity: 0.85 },
  { startBeat: 56, lenBeats: 16, kind: 'chorus', intensity: 1.2 },
  { startBeat: 72, lenBeats: 8, kind: 'outro', intensity: 0.6 },
];

export function sectionAt(sections: ChartSection[], beat: number): ChartSection {
  for (const s of sections) {
    if (beat >= s.startBeat && beat < s.startBeat + s.lenBeats) return s;
  }
  return sections[sections.length - 1];
}

// ================= 谱面构建（砖块卡点 · 段落化密度） =================

export interface ChartBuildInput {
  bpm: number;
  offsetSec: number;
  durationSec: number;
  difficulty: Difficulty;
  sections: ChartSection[];
  /** 每拍相对强度 0–1（强拍→大砖/金砖决策），缺省按段落强度推断 */
  beatStrength?: number[];
  /** 动作配比风格（缺省 mix 全身综合） */
  style?: ChartStyle;
  /** 生成种子：旋转动作序列，重新生成换一副编排 */
  seed?: number;
}

/** 各难度在每小节（4 拍）内的出砖位置 */
const BAR_POS: Record<Difficulty, Record<SectionKind, number[]>> = {
  easy: {
    intro: [], verse: [0], chorus: [0, 2], break: [0], outro: [0],
  },
  normal: {
    intro: [], verse: [0, 2], chorus: [0, 1, 2, 3], break: [0], outro: [0, 2],
  },
  hard: {
    intro: [0], verse: [0, 1, 2, 3], chorus: [0, 1, 2, 3], break: [0, 2], outro: [0, 2],
  },
};

function strengthAt(input: ChartBuildInput, beat: number): number {
  const arr = input.beatStrength;
  if (arr && arr.length > 0) {
    const i = Math.min(Math.max(Math.round(beat), 0), arr.length - 1);
    return arr[i];
  }
  return sectionAt(input.sections, beat).intensity;
}

/**
 * 按段落结构 + 难度 + 风格映射出砖块谱面：
 * - 强拍/副歌 → 大动作 + 金砖（Gold Move）；拍强 ≥0.9 的拍点直接上金砖
 * - 副歌进拍 → 原地跑冲刺段（run 长窗）；cardio 风格副歌中段再加一段冲刺
 * - 主歌疏、副歌密、过门留白（编舞呼吸感）
 * - hard：高强拍小节加反拍小砖
 * - seed 旋转小节动作序列，同参数也能生成不同编排
 */
export function buildChart(input: ChartBuildInput): Chart {
  const { bpm, difficulty, sections } = input;
  const style = input.style ?? 'mix';
  const seed = input.seed ?? 0;
  const beatDur = 60 / bpm;
  const lastBeat = Math.max(16, Math.floor((input.durationSec - input.offsetSec) / beatDur) - 2);
  const events: ChartEvent[] = [];
  const push = (beat: number, action: GameAction, gold = false, window?: number): void => {
    events.push({ beat, action, gold: gold || undefined, window });
  };

  for (let barStart = 4; barStart + 4 <= lastBeat; barStart += 4) {
    const barIdx = Math.floor(barStart / 4);
    const seq = barIdx % 2 === 0 ? STYLE_PATTERNS[style].a : STYLE_PATTERNS[style].b;
    const pattern = (pos: number): GameAction => seq[(pos + seed) % 4];
    const sec = sectionAt(sections, barStart);
    const kind = sec.kind;

    // 副歌进拍：原地跑冲刺段（覆盖该小节前 2 拍）
    const isChorusEntry = kind === 'chorus' && sectionAt(sections, barStart - 0.5).kind !== 'chorus';
    // cardio：副歌中段再加一段冲刺（燃脂拉心率）
    const isChorusMid = style === 'cardio' && kind === 'chorus' && !isChorusEntry
      && barStart === sec.startBeat + Math.floor(sec.lenBeats / 8) * 4;
    if (isChorusEntry || isChorusMid) {
      push(barStart, 'run', strengthAt(input, barStart) >= 0.8, 1.7);
    }

    for (const pos of BAR_POS[difficulty][kind]) {
      const beat = barStart + pos;
      if ((isChorusEntry || isChorusMid) && pos < 2) continue; // 冲刺段内不出砖
      const strength = strengthAt(input, beat);
      // 金砖 = 强拍位（0/2 拍）× 高拍强，或副歌小节头拍
      const gold = (pos % 2 === 0 && strength >= 0.9)
        || (pos === 0 && kind === 'chorus' && (barIdx % 2 === 0 || strength >= 0.8));
      push(beat, pattern(pos), gold);
    }

    // hard：副歌高强拍小节加反拍砖（踩点密度拉满）
    if (difficulty === 'hard' && kind === 'chorus' && strengthAt(input, barStart) >= 0.75) {
      for (const pos of [0.5, 1.5, 2.5, 3.5]) {
        if ((isChorusEntry || isChorusMid) && pos < 2) continue;
        push(barStart + pos, pattern(Math.floor(pos * 2)));
      }
    }
  }

  assignLanes(events, seed); // 3 跑道：出现在哪条道就渲染在哪条道
  return { bpm, events, offsetSec: input.offsetSec, sections };
}

/** 内置合成乐谱面（与 DEFAULT_SECTIONS 同源，卡点严格对齐） */
export function buildDefaultChart(
  difficulty: Difficulty = 'normal',
  style: ChartStyle = 'mix',
  seed = 0,
): Chart {
  return buildChart({
    bpm: 120,
    offsetSec: 0,
    durationSec: 80 * 0.5 + 2, // 80 拍 @120BPM = 40s + 尾音
    difficulty,
    style,
    seed,
    sections: DEFAULT_SECTIONS,
    beatStrength: DEFAULT_SECTIONS.flatMap((s) => {
      const base = s.kind === 'chorus' ? 1 : s.kind === 'verse' ? 0.75 : 0.5;
      return Array.from({ length: s.lenBeats }, (_, i) =>
        Math.min(1, base + (i % 4 === 0 ? 0.15 : 0)));
    }),
  });
}

/** 谱面事件的绝对时间（秒，含音乐相位偏移） */
export function eventTime(chart: Chart, ev: ChartEvent): number {
  return (chart.offsetSec ?? 0) + (ev.beat * 60) / chart.bpm;
}

// ================= 3 跑道分配（事件级 lane） =================

/** 确定性 PRNG（mulberry32）：同 seed 生成同谱面 */
function prng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 三跑道分配：事件出现在哪条道，块就渲染在哪条道，节奏跟着走。
 * - 左移/右移固定世界左/右道（延续左右分侧引导）
 * - 其余动作沿节奏游走：主相邻步进（0→1→2→1→0…），偶尔换向/原地拍，同 seed 可复现
 */
export function assignLanes(events: ChartEvent[], seed = 0): void {
  const rnd = prng(seed * 7919 + 101);
  let lane = 1;
  let dir = rnd() < 0.5 ? -1 : 1;
  const seq = [...events].sort((a, b) => a.beat - b.beat);
  for (const ev of seq) {
    if (ev.action === 'left') { ev.lane = 0; lane = 0; dir = 1; continue; }
    if (ev.action === 'right') { ev.lane = 2; lane = 2; dir = -1; continue; }
    const r = rnd();
    if (r < 0.16) {
      // 原地拍（留白呼吸）
    } else {
      if (r > 0.9) dir = -dir; // 偶尔换向
      let next = lane + dir;
      if (next < 0 || next > 2) { dir = -dir; next = lane + dir; } // 到边折返
      lane = next;
    }
    ev.lane = lane;
  }
}

/** 谱面总时长（秒），含 2 拍尾音 */
export function chartDuration(chart: Chart): number {
  const last = chart.events.reduce((m, e) => Math.max(m, eventTime(chart, e)), 0);
  return last + (60 / chart.bpm) * 2;
}

// ================= 谱面统计（节奏工坊预览用） =================

export interface ChartStats {
  total: number;
  golds: number;
  durationSec: number;
  byAction: Record<GameAction, number>;
}

export function chartStats(chart: Chart): ChartStats {
  const byAction: Record<GameAction, number> = { jump: 0, squat: 0, punch: 0, stomp: 0, run: 0, left: 0, right: 0 };
  let golds = 0;
  for (const ev of chart.events) {
    byAction[ev.action]++;
    if (ev.gold) golds++;
  }
  return { total: chart.events.length, golds, durationSec: chartDuration(chart), byAction };
}
