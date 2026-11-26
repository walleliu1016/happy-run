// P0 档案层：存档 / PB / 打卡 / 成就 / 星星货币（纯 localStorage，零后端）
import type { GameStats } from '../types';

const PROFILE_KEY = 'wu.profile.v1';

export interface LevelRecord {
  best: number;
  stars: number;
  cleared: boolean;
  plays: number;
}

export interface HistoryItem {
  ts: number;
  level: string;
  score: number;
  grade: string;
  stars: number;
}

export interface ProfileData {
  v: 1;
  stars: number;
  totals: {
    games: number;
    timeSec: number;
    kcal: number;
    actions: number;
    maxCombo: number;
  };
  streak: { days: number; last: string };
  /** 最近 90 天的打卡日 YYYY-MM-DD（日历用） */
  playDays: string[];
  /** 每日挑战：当日是否已完成（date=YYYY-MM-DD） */
  daily: { date: string; done: boolean };
  /** 累计完成每日挑战次数 */
  dailyCount: number;
  levels: Record<string, LevelRecord>;
  achievements: string[];
  /** 已购买的装扮 id（'bg:space' / 'skin:gold' 等） */
  unlocked: string[];
  /** 破个人最佳次数 */
  records: number;
  history: HistoryItem[];
}

export interface RunContext {
  stats: GameStats;
  levelKey: string;
  levelName: string;
  grade: string;
  stars: number;
  durationSec: number;
  totalLevels: number;
  /** 本局是否今日挑战（按当日配置完成 → 额外奖励） */
  daily?: boolean;
}

export interface AchievementDef {
  id: string;
  icon: string;
  name: string;
  desc: string;
  check: (p: ProfileData, ctx: RunContext) => boolean;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export { todayStr };

function yesterdayStr(): string {
  const d = new Date(Date.now() - 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function emptyProfile(): ProfileData {
  return {
    v: 1,
    stars: 0,
    totals: { games: 0, timeSec: 0, kcal: 0, actions: 0, maxCombo: 0 },
    streak: { days: 0, last: '' },
    playDays: [],
    daily: { date: '', done: false },
    dailyCount: 0,
    levels: {},
    achievements: [],
    unlocked: [],
    records: 0,
    history: [],
  };
}

export function loadProfile(): ProfileData {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return emptyProfile();
    const p = JSON.parse(raw) as ProfileData;
    return {
      ...emptyProfile(), ...p,
      totals: { ...emptyProfile().totals, ...p.totals },
      streak: { ...emptyProfile().streak, ...p.streak },
      daily: { ...emptyProfile().daily, ...p.daily },
    };
  } catch {
    return emptyProfile();
  }
}

export function saveProfile(p: ProfileData): void {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
}

// ---------- 成就（18 枚） ----------
export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first', icon: '🎉', name: '首战告捷', desc: '完成第一局', check: (p) => p.totals.games >= 1 },
  { id: 'games10', icon: '🔟', name: '十局纪念', desc: '累计完成 10 局', check: (p) => p.totals.games >= 10 },
  { id: 'games50', icon: '🎪', name: '五十局纪念', desc: '累计完成 50 局', check: (p) => p.totals.games >= 50 },
  { id: 'combo50', icon: '🔥', name: '连击新秀', desc: '单局 50 连击', check: (_p, c) => c.stats.maxCombo >= 50 },
  { id: 'combo100', icon: '⚡', name: '连击大师', desc: '单局 100 连击', check: (_p, c) => c.stats.maxCombo >= 100 },
  { id: 'perfect0', icon: '💎', name: '零失误', desc: '一局 20 动作以上无 MISS', check: (_p, c) => c.stats.total >= 20 && c.stats.misses === 0 },
  { id: 'perfectAll', icon: '💯', name: '全完美', desc: '单局 20 动作全部 PERFECT', check: (_p, c) => c.stats.total >= 20 && c.stats.perfects === c.stats.total },
  { id: 'score5000', icon: '🎯', name: '五千分俱乐部', desc: '单局得分 5000+', check: (_p, c) => c.stats.score >= 5000 },
  { id: 'score10000', icon: '🚀', name: '万分大关', desc: '单局得分 10000+', check: (_p, c) => c.stats.score >= 10000 },
  { id: 'gradeS', icon: '👑', name: 'S 级评价', desc: '拿到 S 评级', check: (_p, c) => c.grade === 'S' },
  { id: 'clear1', icon: '🚩', name: '通关勇士', desc: '通关任意关卡', check: (p) => Object.values(p.levels).some((l) => l.cleared) },
  { id: 'clearAll', icon: '🏆', name: '全关制霸', desc: '通关全部关卡', check: (p, c) => Object.values(p.levels).filter((l) => l.cleared).length >= c.totalLevels },
  { id: 'streak5', icon: '📅', name: '五日打卡', desc: '连续 5 天来热身', check: (p) => p.streak.days >= 5 },
  { id: 'streak14', icon: '🔥', name: '两周不断', desc: '连续 14 天打卡', check: (p) => p.streak.days >= 14 },
  { id: 'daily3', icon: '🗓', name: '挑战常客', desc: '完成 3 次每日挑战', check: (p) => p.dailyCount >= 3 },
  { id: 'daily7', icon: '🏅', name: '挑战先锋', desc: '完成 7 次每日挑战', check: (p) => p.dailyCount >= 7 },
  { id: 'record3', icon: '📈', name: '破纪录者', desc: '3 次刷新个人最佳', check: (p) => p.records >= 3 },
  { id: 'kcal500', icon: '💪', name: '燃脂达人', desc: '累计消耗 500 千卡', check: (p) => p.totals.kcal >= 500 },
];

// ---------- 段位称号（持久化，跨局累计，不受星星消费影响） ----------
export interface RankTier {
  name: string;
  min: number;
  icon: string;
  /** 配色档（styles.css 映射） */
  cls: string;
}

export const RANK_TIERS: RankTier[] = [
  { name: '青铜·起步', min: 0, icon: '🥉', cls: 'bronze' },
  { name: '白银·律动', min: 14, icon: '🥈', cls: 'silver' },
  { name: '黄金·节拍', min: 32, icon: '🥇', cls: 'gold' },
  { name: '铂金·连击', min: 54, icon: '💠', cls: 'plat' },
  { name: '钻石·完美', min: 80, icon: '💎', cls: 'diamond' },
  { name: '王者·节奏之神', min: 110, icon: '👑', cls: 'master' },
];

/** 段位分：各关星数×2 + 通关数×6 + 成就×3 + 最高连击/25 */
export function rankScore(p: ProfileData): number {
  const starSum = Object.values(p.levels).reduce((s, l) => s + l.stars, 0);
  const cleared = Object.values(p.levels).filter((l) => l.cleared).length;
  return starSum * 2 + cleared * 6 + p.achievements.length * 3 + Math.floor(p.totals.maxCombo / 25);
}

export function rankOf(p: ProfileData): RankTier {
  const s = rankScore(p);
  let tier = RANK_TIERS[0];
  for (const t of RANK_TIERS) if (s >= t.min) tier = t;
  return tier;
}

export function rankProgress(p: ProfileData): { tier: RankTier; next: RankTier | null; score: number; pct: number } {
  const score = rankScore(p);
  const tier = rankOf(p);
  const idx = RANK_TIERS.indexOf(tier);
  const next = RANK_TIERS[idx + 1] ?? null;
  const pct = next ? Math.min(100, Math.round(((score - tier.min) / (next.min - tier.min)) * 100)) : 100;
  return { tier, next, score, pct };
}

// ---------- 每日挑战（按自然日确定性生成，全服同题） ----------
export function dailyChallenge(levelIds: string[]): { levelId: string; difficulty: 'easy' | 'normal' | 'hard'; seed: number } {
  const t = todayStr();
  let h = 2166136261;
  for (const ch of t) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  h = h >>> 0;
  const diffs: Array<'easy' | 'normal' | 'hard'> = ['easy', 'normal', 'hard'];
  return {
    levelId: levelIds[h % levelIds.length],
    difficulty: diffs[(h >>> 9) % diffs.length],
    seed: h,
  };
}

// ---------- 星星货币与装扮解锁 ----------
/** 装扮价格表：不在表内 = 免费（默认装扮与自定义图片） */
export const LOOK_PRICES: Record<string, number> = {
  'bg:space': 20,
  'bg:candy': 20,
  'bg:forest': 20,
  'skin:flame': 30,
  'skin:frost': 30,
  'skin:nature': 30,
  'skin:candy': 30,
  'skin:gold': 40,
};

export function lookPrice(id: string): number {
  return LOOK_PRICES[id] ?? 0;
}

export function hasLook(p: ProfileData, id: string): boolean {
  return lookPrice(id) === 0 || p.unlocked.includes(id);
}

/** 购买装扮：成功返回 true；星星不足返回 false */
export function buyLook(p: ProfileData, id: string): boolean {
  const price = lookPrice(id);
  if (price === 0 || p.unlocked.includes(id)) return true;
  if (p.stars < price) return false;
  p.stars -= price;
  p.unlocked.push(id);
  saveProfile(p);
  return true;
}

// ---------- 每局记录 ----------
export interface RecordResult {
  starsEarned: number;
  newRecord: boolean;
  firstClear: boolean;
  achievements: AchievementDef[];
  /** 今日挑战奖励星星（非今日挑战或当天已完成 = 0） */
  dailyBonus: number;
  /** 段位晋升（本局后段位提升时给新段位） */
  rankUp: RankTier | null;
}

export function recordGame(p: ProfileData, ctx: RunContext): RecordResult {
  const { stats, levelKey, levelName, grade, stars, durationSec } = ctx;
  const prevRankIdx = RANK_TIERS.indexOf(rankOf(p));

  // 打卡 + 连续天数
  const today = todayStr();
  if (!p.playDays.includes(today)) {
    p.playDays.push(today);
    if (p.playDays.length > 90) p.playDays = p.playDays.slice(-90);
    p.streak.days = p.streak.last === yesterdayStr() ? p.streak.days + 1 : 1;
    p.streak.last = today;
  }

  // 生涯统计
  p.totals.games += 1;
  p.totals.timeSec += Math.round(durationSec);
  p.totals.kcal += stats.kcal;
  p.totals.actions += stats.total;
  p.totals.maxCombo = Math.max(p.totals.maxCombo, stats.maxCombo);

  // 关卡记录 + PB
  const lv = p.levels[levelKey] ?? { best: 0, stars: 0, cleared: false, plays: 0 };
  const newRecord = stats.score > lv.best;
  if (newRecord) {
    lv.best = stats.score;
    p.records += 1;
  }
  lv.stars = Math.max(lv.stars, stars);
  lv.plays += 1;
  // 通关判定：关卡键非 free 且评级 D 以上视为完成一次
  const firstClear = !lv.cleared && levelKey !== 'free' && grade !== 'D';
  if (firstClear) lv.cleared = true;
  p.levels[levelKey] = lv;

  // 星星货币：基础星级 + 评级加成 + 破纪录 + 首通 + 今日挑战
  let dailyBonus = 0;
  if (ctx.daily && p.daily.date !== today) {
    p.daily = { date: today, done: true };
    p.dailyCount += 1;
    dailyBonus = 3;
  }
  let starsEarned = stars + (grade === 'S' ? 2 : grade === 'A' ? 1 : 0) + (newRecord ? 1 : 0) + (firstClear ? 5 : 0) + dailyBonus;
  starsEarned = Math.max(1, starsEarned);
  p.stars += starsEarned;

  // 历史（保留最近 50 条）
  p.history.push({ ts: Date.now(), level: levelName, score: stats.score, grade, stars });
  if (p.history.length > 50) p.history = p.history.slice(-50);

  // 成就
  const achievements: AchievementDef[] = [];
  for (const a of ACHIEVEMENTS) {
    if (!p.achievements.includes(a.id) && a.check(p, ctx)) {
      p.achievements.push(a.id);
      achievements.push(a);
    }
  }

  // 段位晋升（成就解锁后结算）
  const afterRank = rankOf(p);
  const rankUp = RANK_TIERS.indexOf(afterRank) > prevRankIdx ? afterRank : null;

  saveProfile(p);
  return { starsEarned, newRecord, firstClear, achievements, dailyBonus, rankUp };
}

// ---------- 打卡日历（最近 28 天格子） ----------
export function calendarHtml(p: ProfileData): string {
  const cells: string[] = [];
  for (let i = 27; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const on = p.playDays.includes(key);
    cells.push(`<i class="cal-cell${on ? ' on' : ''}" title="${key}"></i>`);
  }
  return `<div class="cal-grid">${cells.join('')}</div>`;
}

// ---------- 成就墙 ----------
export function achievementsHtml(p: ProfileData): string {
  return ACHIEVEMENTS.map((a) => {
    const got = p.achievements.includes(a.id);
    return `<div class="ach${got ? ' got' : ''}">
      <div class="ach-icon">${a.icon}</div>
      <div class="ach-name">${a.name}</div>
      <div class="ach-desc">${a.desc}</div>
    </div>`;
  }).join('');
}

// ---------- 分享成绩海报（Canvas 2D，无第三方依赖） ----------
export function drawSharePoster(stats: GameStats, meta: { grade: string; stars: number; levelName: string }): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = 720;
  cv.height = 1080;
  const g = cv.getContext('2d');
  if (!g) return cv;

  // 背景渐变
  const bg = g.createLinearGradient(0, 0, 720, 1080);
  // B 熔岩运动：分享海报背景由蓝紫改暖炭→熔岩橙
  bg.addColorStop(0, '#2A1208');
  bg.addColorStop(0.55, '#5A2410');
  bg.addColorStop(1, '#C24A0A');
  g.fillStyle = bg;
  g.fillRect(0, 0, 720, 1080);

  // 光斑
  const glow = g.createRadialGradient(560, 200, 20, 560, 200, 360);
  glow.addColorStop(0, 'rgba(255,176,32,0.4)');
  glow.addColorStop(1, 'rgba(255,176,32,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, 720, 720);

  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.font = '700 44px "PingFang SC", sans-serif';
  g.fillText('WarmingUp 律动跑酷', 360, 110);
  g.font = '600 26px "PingFang SC", sans-serif';
  g.fillStyle = '#FFD2A8';
  g.fillText(meta.levelName, 360, 158);

  // 评级大字
  g.font = '900 300px "PingFang SC", sans-serif';
  g.fillStyle = '#FFC233';
  g.fillText(meta.grade, 360, 470);

  // 星星
  g.font = '600 64px sans-serif';
  g.fillStyle = '#ffb020';
  g.fillText('★'.repeat(meta.stars) + '☆'.repeat(Math.max(0, 5 - meta.stars)), 360, 570);

  // 数值
  g.fillStyle = '#fff';
  g.font = '800 96px "PingFang SC", sans-serif';
  g.fillText(String(Math.round(stats.score)), 360, 720);
  g.font = '600 30px "PingFang SC", sans-serif';
  g.fillStyle = '#FFD2A8';
  g.fillText(`最大连击 ${stats.maxCombo} · 动作 ${stats.total} 次 · ${stats.kcal.toFixed(0)} 千卡`, 360, 776);

  // 底部
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.font = '600 28px "PingFang SC", sans-serif';
  g.fillText('一起来热身吧！🏃', 360, 950);
  g.fillStyle = 'rgba(255,255,255,0.5)';
  g.font = '400 22px "PingFang SC", sans-serif';
  g.fillText(new Date().toLocaleDateString('zh-CN'), 360, 1000);
  return cv;
}
