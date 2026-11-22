/**
 * 自定义音乐分析 —— 能量包络 onset + 自相关估 BPM + 相位对齐 + 段落切分。
 * 管线：onset 强度 → tempo 估计 → 拍点网格 → 强弱拍/段落（规则映射的输入）。
 * 对"节奏感强"的音乐（鼓点清晰）效果最好；算法输出只是初稿，BPM/偏移可手动微调。
 */
import type { ChartSection, SectionKind } from '../types';

export interface MusicAnalysis {
  /** 估计 BPM（折算到 70–180 区间，半/双倍速已折叠） */
  bpm: number;
  /** 第 0 拍相对音频起点的偏移（秒） */
  offsetSec: number;
  /** 可信度 0–1，低于 0.35 建议手动微调 */
  confidence: number;
  /** 段落结构（能量切分：过门/主歌/副歌） */
  sections: ChartSection[];
  /** 每拍相对强度 0–1（强拍→金砖/大砖决策） */
  beatStrength: number[];
}

export function analyzeMusic(buffer: AudioBuffer): MusicAnalysis {
  const sr = buffer.sampleRate;
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const hop = 512;
  const frames = Math.floor(buffer.length / hop);

  // 1) 能量包络（RMS）
  const env = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const start = i * hop;
    let sum = 0;
    for (let j = 0; j < hop; j += 2) {
      const s = ch1 ? (ch0[start + j] + ch1[start + j]) * 0.5 : ch0[start + j];
      sum += s * s;
    }
    env[i] = Math.sqrt(sum / (hop / 2));
  }

  // 2) onset = 能量正向差分（鼓点冲击）+ 轻度平滑压毛刺
  const onset = new Float32Array(frames);
  for (let i = 1; i < frames; i++) onset[i] = Math.max(0, env[i] - env[i - 1]);
  const smooth = new Float32Array(frames);
  for (let i = 1; i < frames - 1; i++) {
    smooth[i] = (onset[i - 1] + onset[i] * 2 + onset[i + 1]) / 4;
  }

  const mean = smooth.reduce((a, b) => a + b, 0) / Math.max(frames, 1);
  const centered = new Float32Array(frames);
  for (let i = 0; i < frames; i++) centered[i] = smooth[i] - mean;

  // 3) 自相关找拍周期（60–200 BPM）
  const fps = sr / hop;
  const lagMin = Math.max(2, Math.floor((fps * 60) / 200));
  const lagMax = Math.ceil((fps * 60) / 60);
  let bestLag = lagMin;
  let bestScore = -Infinity;
  let totalScore = 0;
  let nLags = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let score = 0;
    let n = 0;
    for (let i = 0; i + lag < frames; i += 2) {
      score += centered[i] * centered[i + lag];
      n++;
    }
    score /= Math.max(n, 1);
    totalScore += Math.max(score, 0);
    nLags++;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  // 4) 折叠半/双倍速到 70–180 BPM
  let bpm = (60 * fps) / bestLag;
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  bpm = Math.round(bpm * 10) / 10;
  const lag = (fps * 60) / bpm;

  // 5) 相位：找与鼓点网格对齐最好的第一拍
  let bestPhase = 0;
  let bestPScore = -Infinity;
  const phaseCount = Math.max(1, Math.ceil(lag));
  for (let ph = 0; ph < phaseCount; ph++) {
    let score = 0;
    let n = 0;
    for (let k = 0; k * lag + ph < frames; k++) {
      score += smooth[Math.round(k * lag + ph)];
      n++;
    }
    score /= Math.max(n, 1);
    if (score > bestPScore) {
      bestPScore = score;
      bestPhase = ph;
    }
  }
  const offsetSec = Math.round(((bestPhase * hop) / sr) * 1000) / 1000;

  // 6) 可信度：最佳自相关峰相对平均水平
  const avg = totalScore / Math.max(nLags, 1);
  const confidence = avg > 0 ? Math.min(1, Math.max(0, bestScore / (avg * 6))) : 0;

  // ---- 拍点强度：拍点附近 onset 能量均值，归一化到 0–1 ----
  const beatDurSec = 60 / bpm;
  const totalBeats = Math.max(8, Math.floor((buffer.duration - offsetSec) / beatDurSec));
  const rawStrength = new Float32Array(totalBeats);
  const quarterFrames = Math.max(1, Math.round((beatDurSec * 0.25 * sr) / hop));
  for (let k = 0; k < totalBeats; k++) {
    const f = Math.round(((offsetSec + k * beatDurSec) * sr) / hop);
    let sum = 0;
    let n = 0;
    for (let i = f - quarterFrames; i <= f + quarterFrames; i++) {
      if (i >= 0 && i < frames) {
        sum += smooth[i];
        n++;
      }
    }
    rawStrength[k] = n > 0 ? sum / n : 0;
  }
  const sorted = Array.from(rawStrength).sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
  const beatStrength = Array.from(rawStrength, (v) => Math.min(1, v / Math.max(p95, 1e-6)));

  // ---- 段落切分：小节能量三分位 → 过门/主歌/副歌，短游程合并 ----
  const barCount = Math.floor(totalBeats / 4);
  const barEnergy = new Float32Array(Math.max(barCount, 1));
  for (let b = 0; b < barCount; b++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += beatStrength[b * 4 + k] ?? 0;
    barEnergy[b] = sum / 4;
  }
  const sortedBars = Array.from(barEnergy).sort((a, b) => a - b);
  const t1 = sortedBars[Math.floor(sortedBars.length / 3)] ?? 0.33;
  const t2 = sortedBars[Math.floor((sortedBars.length * 2) / 3)] ?? 0.66;
  const kindOf = (e: number): SectionKind => (e <= t1 ? 'break' : e <= t2 ? 'verse' : 'chorus');

  const kinds: SectionKind[] = Array.from(barEnergy, kindOf);
  // 合并短游程（< 2 小节）到邻段，避免碎片段落
  for (let i = 0; i < kinds.length; i++) {
    let j = i;
    while (j + 1 < kinds.length && kinds[j + 1] === kinds[i]) j++;
    const runLen = j - i + 1;
    if (runLen < 2 && kinds.length > 2) {
      const prev = kinds[i - 1] ?? kinds[j + 1] ?? kinds[i];
      for (let k = i; k <= j; k++) kinds[k] = prev;
    }
    i = j;
  }

  const sections: ChartSection[] = [];
  const medianE = sortedBars[Math.floor(sortedBars.length / 2)] || 0.5;
  for (let b = 0; b < kinds.length;) {
    let j = b;
    while (j + 1 < kinds.length && kinds[j + 1] === kinds[b]) j++;
    let eSum = 0;
    for (let k = b; k <= j; k++) eSum += barEnergy[k];
    const rel = eSum / (j - b + 1) / Math.max(medianE, 1e-6);
    sections.push({
      startBeat: b * 4,
      lenBeats: (j - b + 1) * 4,
      kind: kinds[b],
      intensity: Math.min(1.25, Math.max(0.6, rel)),
    });
    b = j + 1;
  }

  return { bpm, offsetSec, confidence, sections, beatStrength: Array.from(beatStrength) };
}
