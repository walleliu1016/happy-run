/**
 * 主题装扮 —— 背景主题（4 预设 + 自定义图智能取色）与教练皮肤（6 款 + 自定义人物）。
 * 纯数据定义，无 THREE 依赖；game.ts 消费调色板，main.ts 持久化装扮状态。
 */
import type { CoachSkin, SceneTheme } from '../types';

// ================= 背景主题调色板 =================

export interface WorldPalette {
  /** 天空渐变 5 档（顶→地平线），自定义图背景时仅作加载兜底 */
  skyStops: string[];
  /** 星点 css 颜色 */
  starCss: string;
  fog: number;
  sun: number;
  sunGlow: number;
  /** 网格地形：底色/网格线（css）+ 自发光 */
  terrainBase: string;
  terrainGrid: string;
  terrainEmissive: number;
  /** 山脉：体色/自发光/线框 */
  mtn: number;
  mtnEmissive: number;
  wire: number;
  /** 拱门：体色/自发光 */
  arch: number;
  archEmissive: number;
  /** 光尘 */
  dust: number;
  /** 轮廓光（左右） */
  rimL: number;
  rimR: number;
  hemiSky: number;
  hemiGround: number;
}

export const THEME_LABEL: Record<SceneTheme, string> = {
  neon: '霓虹峡谷',
  space: '星际漫游',
  candy: '糖果甜心',
  forest: '绿野仙踪',
  custom: '自定义图片',
};

/** 装扮快照：game.ts 构造时一次性消费 */
export interface GameLook {
  theme: SceneTheme;
  skin: CoachSkin;
  /** 自定义背景图（dataURL），设置后 theme 应为 'custom' */
  bgImage?: string | null;
  /** 自定义背景图的派生调色板（上传时预计算，构造同步可用） */
  bgPalette?: WorldPalette | null;
  /** 自定义领操员图片（dataURL），设置后走 2D 纸片人模式 */
  coachImage?: string | null;
}

const NEON: WorldPalette = {
  skyStops: ['#0a0512', '#160818', '#3a1020', '#6b1c2c', '#2a0c14'],
  starCss: 'rgba(255,220,200,1)',
  fog: 0x2a0e16,
  // B 熔岩运动：默认 neon 舞台的冷青补光改暖（左红右金双补光），与 UI 同气质。
  // SPACE / CANDY 主题保留各自色相，用于关卡识别，不动。
  sun: 0xFFB84D,
  sunGlow: 0xFF7A1A,
  terrainBase: '#380d18',
  terrainGrid: 'rgba(255,90,60,0.65)',
  terrainEmissive: 0xff5a3c,
  mtn: 0xa01828,
  mtnEmissive: 0x5c0c18,
  wire: 0xff7a55,
  arch: 0x6c1420,
  archEmissive: 0x8c1626,
  dust: 0xffd2a8,
  rimL: 0xff4a3c,
  rimR: 0xFFC233,
  hemiSky: 0xff9a6a,
  hemiGround: 0x2a0c14,
};

const SPACE: WorldPalette = {
  skyStops: ['#02020c', '#070a20', '#101844', '#26348c', '#0b1030'],
  starCss: 'rgba(190,210,255,1)',
  fog: 0x070c22,
  sun: 0x8f7bff,
  sunGlow: 0x4a3aff,
  terrainBase: '#0b1236',
  terrainGrid: 'rgba(74,92,255,0.6)',
  terrainEmissive: 0x3a49d9,
  mtn: 0x1b2350,
  mtnEmissive: 0x232c66,
  wire: 0x4a5cff,
  arch: 0x26307a,
  archEmissive: 0x3a46e0,
  dust: 0xa8c4ff,
  rimL: 0x4a5cff,
  rimR: 0x35d8ff,
  hemiSky: 0x6a7cff,
  hemiGround: 0x0a0c28,
};

const CANDY: WorldPalette = {
  skyStops: ['#2a0a24', '#4a123c', '#8c2a66', '#e06aa8', '#5c1646'],
  starCss: 'rgba(255,230,245,1)',
  fog: 0x4a1238,
  sun: 0xffe066,
  sunGlow: 0xff8fc8,
  terrainBase: '#4a1236',
  terrainGrid: 'rgba(255,140,200,0.68)',
  terrainEmissive: 0xff6fb5,
  mtn: 0xb03c7c,
  mtnEmissive: 0x7c2a58,
  wire: 0xffb2dc,
  arch: 0x8c2a60,
  archEmissive: 0xd4568f,
  dust: 0xffd9ef,
  rimL: 0xff7ac2,
  rimR: 0xffe066,
  hemiSky: 0xffa8d8,
  hemiGround: 0x3c0c2c,
};

const FOREST: WorldPalette = {
  skyStops: ['#06180e', '#0e2c1a', '#1e4c2e', '#5aa868', '#123424'],
  starCss: 'rgba(220,255,225,1)',
  fog: 0x0e2418,
  sun: 0xffe9a8,
  sunGlow: 0xa8e06a,
  terrainBase: '#123420',
  terrainGrid: 'rgba(110,220,140,0.62)',
  terrainEmissive: 0x3cb46a,
  mtn: 0x1e5c38,
  mtnEmissive: 0x12422a,
  wire: 0x7fd48c,
  arch: 0x1c5234,
  archEmissive: 0x2e8c52,
  dust: 0xd4f5c2,
  rimL: 0x7fff9e,
  rimR: 0xffd76a,
  hemiSky: 0x8ae09a,
  hemiGround: 0x0c2014,
};

export const THEME_PALETTE: Record<Exclude<SceneTheme, 'custom'>, WorldPalette> = {
  neon: NEON,
  space: SPACE,
  candy: CANDY,
  forest: FOREST,
};

// ================= 教练皮肤 =================

export interface SkinConfig {
  /** 模型材质乘色（0xffffff = 原色） */
  tint: number;
  /** 演示台光晕 */
  disc: number;
  /** 教练场景轮廓光 ×2 */
  rim1: number;
  rim2: number;
}

export const SKIN_LABEL: Record<CoachSkin, string> = {
  mage: '魔法师',
  flame: '烈焰勇士',
  frost: '冰雪精灵',
  nature: '自然之灵',
  candy: '糖果甜心',
  gold: '黄金战士',
  custom: '自定义人物',
};

export const SKIN_CONFIG: Record<Exclude<CoachSkin, 'custom'>, SkinConfig> = {
  mage:   { tint: 0xffffff, disc: 0x7b2ff7, rim1: 0x66e0ff, rim2: 0xff5cc8 },
  flame:  { tint: 0xffd2b8, disc: 0xff6a2a, rim1: 0xffb066, rim2: 0xff4a2a },
  frost:  { tint: 0xcfe8ff, disc: 0x35d8ff, rim1: 0x9fe8ff, rim2: 0x5a8cff },
  nature: { tint: 0xd8ffc8, disc: 0x46d96a, rim1: 0x9fff9e, rim2: 0xffd76a },
  candy:  { tint: 0xffd6ee, disc: 0xff7ac2, rim1: 0xffb2e0, rim2: 0xffe066 },
  gold:   { tint: 0xffe6a8, disc: 0xffd60a, rim1: 0xffe08a, rim2: 0xff9a3c },
};

// ================= 自定义图智能取色 =================

export interface Rgb { r: number; g: number; b: number }

/** 图像均值色（缩到 16×16 求平均） */
export function averageColor(img: HTMLImageElement): Rgb {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 16;
  const ctx = c.getContext('2d');
  if (!ctx) return { r: 60, g: 40, b: 60 };
  ctx.drawImage(img, 0, 0, 16, 16);
  const d = ctx.getImageData(0, 0, 16, 16).data;
  let r = 0;
  let g = 0;
  let b = 0;
  const n = 16 * 16;
  for (let i = 0; i < n; i++) {
    r += d[i * 4];
    g += d[i * 4 + 1];
    b += d[i * 4 + 2];
  }
  return { r: r / n, g: g / n, b: b / n };
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** 缩放颜色（<1 变暗，>1 变亮） */
export function scaleRgb(c: Rgb, f: number): Rgb {
  return { r: clamp255(c.r * f), g: clamp255(c.g * f), b: clamp255(c.b * f) };
}

export function rgbHex(c: Rgb): number {
  return (clamp255(c.r) << 16) | (clamp255(c.g) << 8) | clamp255(c.b);
}

export function rgbCss(c: Rgb): string {
  return `rgb(${clamp255(c.r)},${clamp255(c.g)},${clamp255(c.b)})`;
}

/** 由图片均值色派生整套世界调色板（背景图与场景融合） */
export function paletteFromAverage(avg: Rgb): WorldPalette {
  return {
    skyStops: [
      rgbCss(scaleRgb(avg, 0.12)),
      rgbCss(scaleRgb(avg, 0.26)),
      rgbCss(scaleRgb(avg, 0.5)),
      rgbCss(scaleRgb(avg, 0.92)),
      rgbCss(scaleRgb(avg, 0.36)),
    ],
    starCss: 'rgba(255,255,255,0.55)',
    fog: rgbHex(scaleRgb(avg, 0.24)),
    sun: rgbHex(scaleRgb(avg, 1.55)),
    sunGlow: rgbHex(scaleRgb(avg, 1.2)),
    terrainBase: rgbCss(scaleRgb(avg, 0.18)),
    terrainGrid: rgbCss(scaleRgb(avg, 0.8)),
    terrainEmissive: rgbHex(scaleRgb(avg, 0.72)),
    mtn: rgbHex(scaleRgb(avg, 0.46)),
    mtnEmissive: rgbHex(scaleRgb(avg, 0.28)),
    wire: rgbHex(scaleRgb(avg, 0.95)),
    arch: rgbHex(scaleRgb(avg, 0.4)),
    archEmissive: rgbHex(scaleRgb(avg, 0.62)),
    dust: rgbHex(scaleRgb(avg, 1.3)),
    rimL: rgbHex(scaleRgb(avg, 1.25)),
    rimR: 0x35d8ff,
    hemiSky: rgbHex(scaleRgb(avg, 1.15)),
    hemiGround: rgbHex(scaleRgb(avg, 0.2)),
  };
}
