import QRCode from 'qrcode';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { BeatAudio } from './engine/audio';
import {
  ACTION_COLOR, ACTION_GLYPH, ACTION_LABEL, ACTION_LABEL_EN, buildChart, buildDefaultChart,
  chartStats, GOLD_COLOR, LANE_ORDER, STYLE_DESC, STYLE_LABEL,
} from './engine/chart';
import { Game, type GameOpts } from './engine/game';
import { LEVELS, buildLevelChart, nextLevel, type LevelDef } from './engine/levels';
import { poseSilhouette } from './engine/pose-shapes';
import {
  averageColor, paletteFromAverage, type GameLook, type WorldPalette,
} from './engine/look';
import { analyzeMusic, type MusicAnalysis } from './engine/music';
import {
  achievementsHtml, buyLook, calendarHtml, dailyChallenge, drawSharePoster, hasLook, loadProfile,
  LOOK_PRICES, lookPrice, rankProgress, recordGame, todayStr, type ProfileData,
} from './engine/profile';
import {
  chartFromGhost, ghostFromRun, ghostScoreAt, ghostShareUrl, parseGhostHash, type GhostData,
} from './engine/ghost';
import {
  lbBoard, lbSubmit, pkCreateRoom, pkInvite, pkInviteCancel, pkInviteRespond, pkJoinRoom, pkLeave,
  pkPresence, pkRematch, pkResult, pkRoomList, pkRoomStatus, pkSync,
  type PkInvite, type PkPlayer, type PkResult, type PkRoomList, type PkRoomState, type PresenceState,
} from './pk';
import { ActionClassifier } from './input/classifier';
import { GamepadInput, connectedPadNames } from './input/gamepad';
import { PoseInput } from './input/pose';
import { Pairing, randomCode } from './input/remote';
import { attachTvNav, normKey } from './input/tvnav';
import type {
  Chart, ChartStyle, CoachSkin, Difficulty, GameAction, GameStats, InputSource,
  JudgeQuality, JudgeResult, SceneMode, SceneTheme, SectionKind,
} from './types';

// ---------- 全局状态 ----------
const audio = new BeatAudio();
let scene: SceneMode = 'class';
let source: InputSource = 'direct';
/** 用户手动选过输入源后，体检结论不再覆盖其选择 */
let userPickedSource = false;
/** 跳过体检 = 不接受体检结论，别在背后改用户的选择 */
let checkSkipped = false;
/** 设置/体检页的返回目标（从哪进来回哪去） */
let settingsFrom: string = 'screen-menu';
const checkFrom = 'screen-settings';
let difficulty: Difficulty = 'normal';
let game: Game | null = null;
let padInput: GamepadInput | null = null;
let pose: PoseInput | null = null;
let classifier = new ActionClassifier();
let pairing: Pairing | null = null;
/** 投屏接收端（电视）固定配对码：一键投屏时由发起端生成并随投屏 URL 带来 */
let castCode: string | null = null;
/** 镜像游玩：手机当游戏机+摄像头（优先后置摄像头对着人） */
let mirrorPlay = false;
/** 当前关卡（null = 自由练习/工坊谱面） */
let currentLevel: LevelDef | null = null;
/** 今日挑战进行中（结算时按当日配置发额外奖励，当天仅首局有效） */
let dailyMode = false;
/** 全服排行榜当前查看的关卡（'' = 首次渲染时取第一关） */
let lbLevel = '';

// ---------- P0 档案层 + P1 影子挑战 ----------
let profile: ProfileData = loadProfile();
/** 收到的影子挑战（菜单横幅展示，接受后进对局） */
let pendingGhost: GhostData | null = null;
/** 本局对手影子（好友发起的挑战） */
let ghostRival: GhostData | null = null;
/** 本局分数时间轴 [elapsedMs, score]（发起挑战时压进链接） */
let ghostTrace: number[][] = [];
let lastTracedScore = -1;
/** 本局已进行毫秒（updateHud 采样，结算折算时长） */
let runElapsedMs = 0;
/** 本局谱面（影子序列化用） */
let currentChart: Chart | null = null;
/** 上局结算快照（分享海报 / 发起挑战按钮用） */
let lastRun: { stats: GameStats; grade: string; stars: number; levelName: string } | null = null;

const LOOK_NAMES: Record<string, string> = {
  'bg:space': '🌌 星际漫游', 'bg:candy': '🍬 糖果甜心', 'bg:forest': '🌿 绿野仙踪',
  'skin:flame': '🔥 烈焰勇士', 'skin:frost': '❄️ 冰雪精灵', 'skin:nature': '🌱 自然之灵',
  'skin:candy': '🎀 糖果甜心', 'skin:gold': '⭐ 黄金战士',
};

// 定制音乐状态
interface CustomMusic {
  buffer: AudioBuffer;
  name: string;
  analysis: MusicAnalysis;
}
let music: CustomMusic | null = null;

// 节奏工坊（谱面定制）状态
let chartStyle: ChartStyle = 'mix';
let chartSeed = 0;
/** 当前预览/导出用的谱面（与开局谱面同源） */
let labChart: Chart | null = null;

// ---------- 主题装扮（背景 + 领操员，localStorage 持久化） ----------
const LOOK_KEY = 'wu.look';
interface LookState {
  theme: SceneTheme;
  bgImage: string | null;
  bgPalette: WorldPalette | null;
  skin: CoachSkin;
  coachImage: string | null;
}

function loadLook(): LookState {
  const empty: LookState = {
    theme: 'neon', bgImage: null, bgPalette: null, skin: 'mage', coachImage: null,
  };
  try {
    const raw = localStorage.getItem(LOOK_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<LookState>;
      if (v && typeof v === 'object') {
        return {
          theme: (v.theme as SceneTheme) ?? empty.theme,
          bgImage: v.bgImage ?? null,
          bgPalette: v.bgPalette ?? null,
          skin: (v.skin as CoachSkin) ?? empty.skin,
          coachImage: v.coachImage ?? null,
        };
      }
    }
  } catch {
    // 坏数据按默认处理
  }
  return empty;
}

let look: LookState = loadLook();

function saveLook(): void {
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify(look));
  } catch {
    // 存储满则跳过持久化（本次会话仍生效）
  }
}

/** 装扮快照（传给 Game） */
function currentLook(): GameLook {
  return {
    theme: look.theme,
    skin: look.skin,
    bgImage: look.bgImage,
    bgPalette: look.bgPalette,
    coachImage: look.coachImage,
  };
}

function refreshLookUi(): void {
  document.querySelectorAll<HTMLElement>('.look-chip[data-bg]').forEach((el) => {
    el.classList.toggle('selected', el.dataset.bg === look.theme);
    const id = `bg:${el.dataset.bg}`;
    const base = el.dataset.baseLabel ?? (el.dataset.baseLabel = el.textContent ?? '');
    const locked = lookPrice(id) > 0 && !hasLook(profile, id);
    el.classList.toggle('locked', locked);
    el.textContent = locked ? `${base} 🔒${lookPrice(id)}⭐` : base;
  });
  document.querySelectorAll<HTMLElement>('.look-chip[data-skin]').forEach((el) => {
    el.classList.toggle('selected', el.dataset.skin === look.skin);
    const id = `skin:${el.dataset.skin}`;
    const base = el.dataset.baseLabel ?? (el.dataset.baseLabel = el.textContent ?? '');
    const locked = lookPrice(id) > 0 && !hasLook(profile, id);
    el.classList.toggle('locked', locked);
    el.textContent = locked ? `${base} 🔒${lookPrice(id)}⭐` : base;
  });
  const label = $('#coach-label');
  if (label && !label.classList.contains('demoing')) {
    label.textContent = `${look.coachImage ? '你的领操员' : '麦吉教练'} · 动作示范`;
  }
  updateMenuSummary();
}

/** 图片降采样为 dataURL（背景 jpg / 人物 png 保透明） */
async function shrinkImage(
  file: File, maxDim: number, type: 'image/jpeg' | 'image/png', quality = 0.85,
): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('canvas 2d 不可用');
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return c.toDataURL(type, quality);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = url;
  });
}

// 判定校准（识别/音画延迟补偿，毫秒）
const CALIB_KEY = 'wu.calibMs';
let calibMs = Number(localStorage.getItem(CALIB_KEY) || 0);
if (!Number.isFinite(calibMs)) calibMs = 0;

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`元素不存在: ${sel}`);
  return el;
};

function showScreen(id: string): void {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(`#${id}`).classList.add('active');
  if (id === 'screen-menu') {
    renderLevels(); // PB/星星可能更新，海报徽章刷一遍
    renderDaily(); // 今日挑战：当日配置 + 完成状态
    void refreshRoomBanner(); // 首页房间入口：实时房间数
    startRoomBannerPoll();
  } else {
    stopRoomBannerPoll();
  }
  if (id !== 'screen-pk') stopPkListPoll();
  syncForceLandscape(); // 打开即横排：任何屏都保持横排，不再按屏重置
  // P1 过场：开跑 / 结算切屏时扫一道霓虹光
  if (id === 'screen-game' || id === 'screen-result') playWipe();
}

/** P1 过场扫光（运动图形转场：斜切光带扫过 + 微闪白） */
function playWipe(): void {
  const w = $('#screen-wipe');
  w.classList.remove('play');
  void w.offsetWidth;
  w.classList.add('play');
  window.setTimeout(() => w.classList.remove('play'), 700);
}

// ---------- 打开即横排（全 App：菜单/准备/设置/对局一视同仁） ----------
// 主路径：全屏 + 系统转向锁（Android Chrome 等支持的环境直接真横屏）；
// 兜底：转向锁不可用（iOS / 竖屏锁死的 WebView）时把整个 #app 连屏带浮层旋转 90° 呈横排，
// 用户把手机横过来即为正向；视口已是横屏则两路都不干预。

/** 桌面鼠标不折腾；手机触屏与 TV（遥控器 pointer: none，(pointer: coarse) 不匹配）都要横排 */
function forceLandscapeCapable(): boolean {
  return matchMedia('(pointer: coarse)').matches || isTvDevice();
}

async function requestLandscape(): Promise<void> {
  if (!forceLandscapeCapable()) return;
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.();
  } catch { /* 不支持则走 CSS 兜底 */ }
  try {
    const so = screen.orientation as unknown as { lock?: (o: string) => Promise<void> };
    await so.lock?.('landscape');
  } catch { /* 同上 */ }
}

function syncForceLandscape(): void {
  const portrait = window.innerHeight > window.innerWidth;
  const on = portrait && forceLandscapeCapable();
  if (on) {
    document.documentElement.style.setProperty('--fl-w', `${window.innerHeight}px`);
    document.documentElement.style.setProperty('--fl-h', `${window.innerWidth}px`);
  }
  document.body.classList.toggle('force-landscape', on);
  game?.resize();
}

// ---------- Toast / 星星 / 返回 ----------
let toastTimer = 0;

function showToast(text: string): void {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.hidden = true;
  }, 2800);
}

function refreshStarCount(): void {
  const t = String(Math.round(profile.stars));
  const a = document.querySelector('#star-count');
  if (a) a.textContent = t;
  const b = document.querySelector('#star-count-2');
  if (b) b.textContent = t;
  refreshRankChip();
}

/** 顶栏段位小徽章（段位分不吃星星，消费不影响） */
function refreshRankChip(): void {
  const el = document.querySelector<HTMLElement>('#rank-chip');
  if (!el) return;
  const rp = rankProgress(profile);
  el.textContent = `${rp.tier.icon} ${rp.tier.name}`;
  el.dataset.t = rp.tier.cls;
  el.title = `段位分 ${rp.score}${rp.next ? ` · 距 ${rp.next.name} 还差 ${rp.next.min - rp.score}` : ' · 已登顶'}`;
}

/** 今日挑战横幅（每天一关固定谱面，全服同题） */
function renderDaily(): void {
  const d = dailyChallenge(LEVELS.map((l) => l.id));
  const lv = LEVELS.find((l) => l.id === d.levelId);
  const done = profile.daily.done && profile.daily.date === todayStr();
  $('#daily-title').textContent = `今日挑战 · ${lv?.nameCn ?? '未知关卡'}`;
  $('#daily-sub').textContent = `${diffLabel(d.difficulty)} · 固定谱面全服同题 · ${done ? '今日已完成，明天再来' : '完成 +3 ⭐'}`;
  const badge = $('#daily-badge');
  badge.textContent = done ? '已完成 ✓' : '+3 ⭐';
  badge.classList.toggle('done', done);
}

/** 今日挑战：固定关卡+难度+谱面种子直接开跑（当天首局 +3 ⭐） */
function startDaily(): void {
  const d = dailyChallenge(LEVELS.map((l) => l.id));
  const lv = LEVELS.find((l) => l.id === d.levelId);
  if (!lv) return;
  dailyMode = true;
  difficulty = d.difficulty;
  chartSeed = d.seed;
  selectCard('scene', 'train'); // 挑战计分，不走课堂/ PK 模式
  pendingLevel = lv;
  void startLevel(lv);
}

/** 统一返回：对局→退局；子屏→回菜单；体检→回菜单；菜单→0（壳双按退出） */
function goBack(): number {
  if (game) {
    quitGame();
    return 1;
  }
  const active = document.querySelector('.screen.active')?.id ?? '';
  if (active === 'screen-check') {
    checkSkipped = true; // 离开体检 = 不接受迟到结论
    showScreen(checkFrom);
    return 1;
  }
  if (active === 'screen-settings') {
    showScreen(settingsFrom);
    return 1;
  }
  if (active === 'screen-prepare') {
    showScreen('screen-menu'); // 回海报墙重选关卡
    return 1;
  }
  if (active === 'screen-pk') {
    cleanupPk();
    showScreen(pendingLevel ? 'screen-prepare' : 'screen-menu');
    return 1;
  }
  if (active === 'screen-menu') return 0;
  if (active === 'screen-result') {
    quitGame();
    return 1;
  }
  showScreen('screen-menu');
  return 1;
}

/** 付费装扮：未解锁先买（星星不足提示差额） */
function ensureLookUnlocked(id: string): boolean {
  if (hasLook(profile, id)) return true;
  const name = LOOK_NAMES[id] ?? id;
  const price = lookPrice(id);
  if (buyLook(profile, id)) {
    showToast(`已解锁 ${name}！`);
    refreshStarCount();
    return true;
  }
  showToast(`星星不够，解锁 ${name} 还差 ${price - profile.stars} ⭐`);
  return false;
}

/** 我的档案屏：头部卡（头像/昵称/段位/星星）+ 统计/打卡/成就/装扮/全服排行榜分组 */
function renderProfile(): void {
  refreshStarCount();
  // 头部渐变卡：头像 + 昵称（点击修改）+ 段位徽章 + 星星 + 段位进度
  const rp = rankProgress(profile);
  const hero = $('#pf-hero');
  hero.innerHTML = `
    <div class="pfh-main">
      <div class="pfh-avatar">${avatarFor(myId())}</div>
      <div class="pfh-id">
        <button type="button" class="pfh-name nick-chip" title="点击修改昵称">${escapeHtml(myName())}</button>
        <div class="pfh-sub">点击昵称可修改 · PK、排行榜、在线列表都认这个名字</div>
      </div>
    </div>
    <div class="pfh-badges">
      <span class="pfh-chip pfh-rank" data-t="${rp.tier.cls}">${rp.tier.icon} ${rp.tier.name}</span>
      <span class="pfh-chip">⭐ ${profile.stars}</span>
    </div>
    <div class="rank-track pfh-track"><i style="width:${rp.pct}%"></i></div>
    <div class="rank-score pfh-score">段位分 <b>${rp.score}</b>${rp.next ? ` · 距 ${rp.next.name} 还差 ${rp.next.min - rp.score} 分` : ' · 已登顶'}</div>
    <div class="rank-note pfh-note">段位分 = 关卡星数×2 + 通关×6 + 成就×3 + 最高连击÷25（不受星星消费影响）</div>`;
  hero.querySelector('.pfh-name')?.addEventListener('click', () => openNickModal());
  const t = profile.totals;
  const stat = (label: string, value: string | number): string =>
    `<div class="pf-stat"><b>${value}</b><span>${label}</span></div>`;
  $('#pf-stats').innerHTML = [
    stat('🎮 总局数', t.games),
    stat('⏱ 累计时长', `${Math.round(t.timeSec / 60)} 分`),
    stat('🔥 消耗热量', `${Math.round(t.kcal)} kcal`),
    stat('🤸 动作次数', t.actions),
    stat('⚡ 最高连击', t.maxCombo),
    stat('🏅 破纪录次数', profile.records),
  ].join('');
  $('#pf-cal').innerHTML = calendarHtml(profile);
  $('#pf-streak').innerHTML = `🔥 连续打卡 <b>${profile.streak.days}</b> 天 · 最近 28 天`;
  $('#pf-ach').innerHTML = achievementsHtml(profile);
  $('#pf-shop').innerHTML = Object.keys(LOOK_PRICES).map((id) => {
    const owned = hasLook(profile, id);
    return `<div class="shop-item${owned ? ' owned' : ''}">
      <div class="shop-name">${LOOK_NAMES[id] ?? id}</div>
      <button class="btn btn-small ${owned ? 'btn-ghost' : 'btn-primary'}" data-buy="${id}" ${owned ? 'disabled' : ''}>
        ${owned ? '已拥有 ✓' : `解锁 ${lookPrice(id)} ⭐`}
      </button>
    </div>`;
  }).join('');
  $('#pf-shop').querySelectorAll<HTMLElement>('[data-buy]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.buy ?? '';
      if (buyLook(profile, id)) {
        showToast(`已解锁 ${LOOK_NAMES[id] ?? id}！`);
        renderProfile();
        refreshLookUi();
      } else {
        showToast(`星星不够，还差 ${lookPrice(id) - profile.stars} ⭐`);
      }
    });
  });
  // P2 全服排行榜（昵称统一走右上角昵称 chip）
  renderLb();
}

/** 全服排行榜（每关 top 20，服务端文件持久化） */
function renderLb(): void {
  if (!lbLevel) lbLevel = LEVELS[0]?.id ?? 'free';
  const chips = [...LEVELS.map((l) => ({ id: l.id, label: `${l.lv} ${l.nameCn}` })), { id: 'free', label: 'FREE 自由' }];
  $('#lb-chips').innerHTML = chips
    .map((c) => `<button class="style-chip${c.id === lbLevel ? ' selected' : ''}" data-lb="${escapeHtml(c.id)}">${escapeHtml(c.label)}</button>`)
    .join('');
  $('#lb-chips').querySelectorAll<HTMLElement>('[data-lb]').forEach((el) => {
    el.addEventListener('click', () => { lbLevel = el.dataset.lb ?? 'free'; renderLb(); });
  });
  const list = $('#lb-list');
  list.innerHTML = '<div class="lb-loading">榜单加载中…</div>';
  void lbBoard(lbLevel).then((b) => {
    if (!b.top.length) {
      list.innerHTML = '<div class="lb-loading">还没有人上榜——来当第一！</div>';
      return;
    }
    list.innerHTML = b.top.map((e) => `
      <div class="lb-row${e.rank <= 3 ? ' top3' : ''}">
        <span class="lb-rank r${Math.min(e.rank, 10)}">${e.rank}</span>
        <span class="lb-name">${escapeHtml(e.name)}</span>
        <span class="lb-grade">${escapeHtml(e.grade)}</span>
        <span class="lb-score">${e.score.toLocaleString()}</span>
      </div>`).join('') + `<div class="lb-total">共 ${b.total} 人上榜 · 每关保留前 50</div>`;
  }).catch(() => {
    list.innerHTML = '<div class="lb-loading">榜单暂不可用</div>';
  });
}

/** 影子挑战横幅（boot / 忽略后刷新用） */
function refreshGhostBanner(): void {
  const banner = $('#ghost-banner');
  if (!pendingGhost) {
    banner.hidden = true;
    return;
  }
  $('#ghost-banner-title').textContent = `👻 ${pendingGhost.name} 向你发起影子挑战`;
  $('#ghost-banner-sub').textContent = `${pendingGhost.date} · 对手成绩 ${pendingGhost.res.score} 分 · 同谱面竞速`;
  banner.hidden = false;
}

// ---------- 设备体检 ----------
const checkState: Record<string, 'ok' | 'warn' | 'fail'> = {};

function setCheck(key: string, state: 'ok' | 'warn' | 'fail', value: string): void {
  checkState[key] = state;
  const li = document.querySelector<HTMLLIElement>(`#check-list li[data-key="${key}"]`);
  if (!li) return;
  li.dataset.state = state;
  const val = li.querySelector('.cl-val') ?? document.createElement('span');
  val.className = 'cl-val';
  val.textContent = value;
  if (!val.parentElement) li.appendChild(val);
  else val.textContent = value;
}

function setVerdict(text: string, tone: '' | 'good' | 'warn'): void {
  const v = $('#verdict');
  v.textContent = text;
  v.className = `verdict ${tone}`;
}

async function runDeviceCheck(): Promise<void> {
  setVerdict('体检进行中…', '');

  // 1) WebAssembly
  const wasmOk = (() => {
    try {
      return typeof WebAssembly === 'object' && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    } catch {
      return false;
    }
  })();
  setCheck('wasm', wasmOk ? 'ok' : 'fail', wasmOk ? '可用' : '不可用');
  if (!wasmOk) {
    setVerdict('浏览器内核太老，跑不了姿态识别。请换新版浏览器或用手机模式。', 'warn');
    return;
  }

  // 2) 摄像头
  const video = $<HTMLVideoElement>('#check-video');
  let cameraOk = false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
    video.srcObject = stream;
    await video.play();
    cameraOk = true;
    $('#camera-hint').classList.add('hidden');
    ($<HTMLElement>('#camera-hint')).style.display = 'none';
    setCheck('camera', 'ok', '已就绪');
  } catch {
    setCheck('camera', 'fail', '无可用摄像头');
    const hint = $<HTMLElement>('#camera-hint');
    hint.textContent = '摄像头不可用';
  }

  // 3) 姿态识别帧率（摄像头可用时实测 5 秒）
  if (cameraOk) {
    setCheck('perf', 'warn', '测量中…');
    try {
      const testPose = await PoseInput.create(video, () => {});
      testPose.startLoop();
      await delay(5000);
      const fps = testPose.avgFps;
      testPose.stop();
      const stream = video.srcObject as MediaStream | null;
      stream?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      const hint = $<HTMLElement>('#camera-hint');
      hint.classList.remove('hidden');
      hint.style.display = '';
      hint.textContent = '体检完成 · 摄像头已关闭';

      // 低性能设备：关泛光/抗锯齿，保帧率
      document.body.dataset.lowperf = fps < 12 ? '1' : '0';

      if (fps >= 12) setCheck('perf', 'ok', `${fps.toFixed(0)} fps`);
      else setCheck('perf', 'warn', `${fps.toFixed(0)} fps（偏低）`);
    } catch {
      setCheck('perf', 'fail', '初始化失败');
    }
  } else {
    setCheck('perf', 'warn', '未测量');
  }

  // 4) 网络
  const netOk = navigator.onLine;
  setCheck('net', netOk ? 'ok' : 'warn', netOk ? '在线' : '离线（不影响单机）');

  // 结论（仅在用户未手动选过输入源时自动应用，避免异步覆盖用户选择）
  const perf = checkState.perf;
  if (cameraOk && perf === 'ok') {
    setVerdict('结论：本设备可直接跑体感（直连摄像头）！', 'good');
    if (!userPickedSource && !checkSkipped) {
      source = 'direct';
      selectCard('source', 'direct');
    }
  } else if (cameraOk) {
    setVerdict('结论：摄像头可用但识别偏慢，建议「手机当识别器」获得流畅手感。', 'warn');
    if (!userPickedSource && !checkSkipped) {
      source = 'phone';
      selectCard('source', 'phone');
    }
  } else {
    setVerdict('结论：本设备没有可用摄像头，请用「手机当识别器」。', 'warn');
    if (!userPickedSource && !checkSkipped) {
      source = 'phone';
      selectCard('source', 'phone');
    }
  }
}

// ---------- 菜单：单页滚动配置（App 式，即点即选，无步骤向导） ----------
/** 滚动到指定配置区（1 玩法 / 2 识别 / 3 装备）；n <= 0 回顶部 */

function updateMenuSummary(): void {
  const sceneTxt = scene === 'class' ? '🏫 课堂模式' : scene === 'train' ? '🔥 训练模式' : '⚡ 竞技 PK';
  const diffTxt = difficulty === 'easy' ? '🌱 轻松' : difficulty === 'hard' ? '⚡ 挑战' : '🔥 标准';
  const srcTxt = source === 'direct' ? '📷 摄像头' : source === 'phone' ? '📱 手机识别' : '🎮 手柄·键盘';
  const bg = document.querySelector<HTMLElement>('.look-chip[data-bg].selected')?.dataset.bg ?? 'neon';
  const bgMap: Record<string, string> = {
    neon: '🏜 霓虹峡谷', space: '🌌 星际漫游', candy: '🍬 糖果甜心', forest: '🌿 绿野仙踪', custom: '🖼 自定义背景',
  };
  $('#menu-summary').innerHTML = [sceneTxt, diffTxt, srcTxt, bgMap[bg] ?? '']
    .map((t) => `<span class="sum-chip">${t}</span>`)
    .join('');
}

// ---------- 菜单 ----------
function selectCard(group: 'scene' | 'source', value: string): void {
  const attr = group === 'scene' ? 'data-scene' : 'data-source';
  document.querySelectorAll<HTMLElement>(`.mode-card[${attr}], .set-src-row[${attr}]`).forEach((el) => {
    el.classList.toggle('selected', el.getAttribute(attr) === value);
  });
  if (group === 'scene') {
    scene = value as SceneMode;
    // 竞技 PK 是对战玩法：开跑按钮变成进房间入口
    $<HTMLButtonElement>('#btn-start').textContent = scene === 'pk' ? '进入 PK 房间 ⚡' : '开始挑战';
  } else {
    source = value as InputSource;
    updatePairCard();
    // 首次选「手柄·键盘」且还没连上 → 自动弹连接向导（之后靠顶部 chip / 设置页入口）
    if (value === 'pad' && !connectedPadNames().length && !localStorage.getItem('wu.padHelpSeen')) {
      localStorage.setItem('wu.padHelpSeen', '1');
      openPadModal();
    }
  }
  updateMenuSummary();
}

function selectDifficulty(value: Difficulty): void {
  difficulty = value;
  document.querySelectorAll<HTMLElement>('.mode-card[data-difficulty]').forEach((el) => {
    el.classList.toggle('selected', el.dataset.difficulty === value);
  });
  refreshChartLab();
  updateMenuSummary();
}

function updatePairCard(): void {
  const card = $('#pair-card');
  if (source !== 'phone') {
    card.hidden = true;
    pairing?.teardown();
    return;
  }
  card.hidden = false;
  const code = castCode ?? randomCode();
  const url = `${location.origin}${location.pathname}?role=sensor&code=${code}`;
  $('#pair-url').textContent = url;
  if (castCode) {
    // 投屏模式：发起投屏的手机自动当识别器，这里只展示连接状态（其他手机仍可扫码加入）
    const h = card.querySelector('h3');
    const lead = card.querySelector('.lead');
    if (h) h.textContent = '📺 投屏模式 · 手机已是摄像头';
    if (lead) lead.textContent = '发起投屏的手机会自动连上本机。其他手机也可扫下面的码加入。';
  }
  QRCode.toCanvas($<HTMLCanvasElement>('#qr-canvas'), url, { width: 220, margin: 1, color: { dark: '#1d1d1f' } })
    .catch(() => {
      $('#pair-url').textContent = `手动输入：${url}`;
    });

  pairing?.teardown();
  pairing = new Pairing(
    (s) => {
      const el = $('#pair-status');
      el.textContent = s.detail;
      el.classList.toggle('connected', s.connected);
    },
    (action, at) => {
      game?.pushAction(action, at);
    },
  );
  pairing.host(code);
}

// ---------- 姿态质量提示（构图 / 光线 / 多人，提升识别率） ----------
let hintLastAt = 0;
let hintTimer = 0;
let lightCheckLastAt = 0;
const lightProbe = document.createElement('canvas');
lightProbe.width = 8;
lightProbe.height = 8;

function showPoseHint(text: string): void {
  const el = document.getElementById('pose-hint');
  if (!el) return;
  const now = performance.now();
  if (now - hintLastAt < 5000) return; // 提示节流：5 秒内不重复打扰
  hintLastAt = now;
  el.textContent = text;
  el.hidden = false;
  window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => { el.hidden = true; }, 3200);
}

function updatePoseHints(
  video: HTMLVideoElement, landmarks: NormalizedLandmark[] | null, numPoses: number,
): void {
  if (numPoses > 1) {
    showPoseHint('画面里有多人，识别容易乱——只留一个人在画面里');
    return;
  }
  if (!landmarks || landmarks.length < 28) return;
  // 构图：耳到踝的纵向占比 + 髋部横向位置
  const topY = (landmarks[7].y + landmarks[8].y) / 2;
  const bottomY = (landmarks[27].y + landmarks[28].y) / 2;
  const span = bottomY - topY;
  const cx = (landmarks[23].x + landmarks[24].x) / 2;
  if (span > 0.86) { showPoseHint('站远一点，全身进画面'); return; }
  if (span < 0.38) { showPoseHint('站近一点，人太小识别不稳'); return; }
  if (cx < 0.22 || cx > 0.78) { showPoseHint('往画面中间站一点'); return; }
  // 光线：每秒采样一次画面平均亮度
  const now = performance.now();
  if (now - lightCheckLastAt > 1000 && video.readyState >= 2) {
    lightCheckLastAt = now;
    const g = lightProbe.getContext('2d');
    if (g) {
      try {
        g.drawImage(video, 0, 0, 8, 8);
        const d = g.getImageData(0, 0, 8, 8).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
        if (sum / (d.length / 4) < 42) showPoseHint('光线偏暗，开灯识别更准');
      } catch {
        // 跨域视频帧读取失败则跳过亮度检测
      }
    }
  }
}

// ---------- 手机传感器模式 ----------
async function runSensorMode(code: string): Promise<void> {
  showScreen('screen-check');
  $('#camera-hint').style.display = 'flex';
  $('#camera-hint').textContent = '手机识别器启动中…';
  const video = $<HTMLVideoElement>('#check-video');
  $<HTMLElement>('.check-panel').innerHTML = `
    <h1 class="display">手机识别器<br/>已就绪</h1>
    <p class="lead">把手机靠在电视旁、摄像头对着人（建议用后置摄像头）。
    全身进画面，跟着电视上的口令做动作即可。</p>
    <div class="verdict" id="sensor-status">正在连接电视…</div>
    <div class="verdict good" id="sensor-action" style="margin-top:16px; font-size:34px;">—</div>
  `;

  const sensorPair = new Pairing(
    (s) => {
      const el = $('#sensor-status');
      if (el) {
        el.textContent = s.detail;
        el.className = `verdict ${s.connected ? 'good' : 'warn'}`;
      }
    },
    () => {},
  );
  sensorPair.join(code);

  const cls = new ActionClassifier();
  try {
    const sensorPose = await PoseInput.create(video, (landmarks, _fps, numPoses) => {
      updatePoseHints(video, landmarks, numPoses ?? 1);
      const actions = cls.push(landmarks);
      const el = $('#sensor-action');
      for (const a of actions) {
        sensorPair.sendAction(a, performance.now() / 1000);
        if (el) {
          el.textContent = ACTION_LABEL[a];
          el.style.background = `${ACTION_COLOR[a]}22`;
          el.style.color = ACTION_COLOR[a];
        }
      }
    });
    await sensorPose.startCamera({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'environment' } });
    $('#camera-hint').style.display = 'none';
  } catch {
    $('#camera-hint').textContent = '摄像头启动失败，请检查权限';
  }
}

// ---------- 定制音乐 ----------
function updateMusicCard(): void {
  const info = $('#music-info');
  if (!music) {
    info.hidden = true;
    return;
  }
  info.hidden = false;
  $('#music-name').textContent = `♪ ${music.name}`;
  $('#music-bpm').textContent = music.analysis.bpm.toFixed(1);
  $('#music-off').textContent = `${music.analysis.offsetSec >= 0 ? '+' : ''}${music.analysis.offsetSec.toFixed(2)}s`;
  const kinds = new Set(music.analysis.sections.map((s) => s.kind));
  $('#music-structure').textContent = `段落：${kinds.has('chorus') ? '含副歌高潮' : '节奏较平'} · ${music.analysis.sections.length} 段`;
}

async function loadMusicFile(file: File): Promise<void> {
  const analysis = $('#music-analysis');
  analysis.className = 'music-analysis';
  analysis.textContent = '分析中…（BPM · 拍点 · 段落）';
  $('#music-info').hidden = false;
  $('#music-name').textContent = `♪ ${file.name}`;
  try {
    await audio.init();
    const buffer = await audio.decode(await file.arrayBuffer());
    const result = analyzeMusic(buffer);
    music = { buffer, name: file.name, analysis: result };
    updateMusicCard();
    refreshChartLab();
    if (result.confidence >= 0.35) {
      analysis.className = 'music-analysis ok';
      analysis.textContent = `已识别 ${result.bpm.toFixed(1)} BPM，可信度 ${(result.confidence * 100).toFixed(0)}%`;
    } else {
      analysis.className = 'music-analysis warn';
      analysis.textContent = `估计 ${result.bpm.toFixed(1)} BPM（鼓点不清晰，建议手动微调）`;
    }
  } catch {
    analysis.className = 'music-analysis warn';
    analysis.textContent = '音频解码失败，换一个文件试试';
  }
}

function adjustMusic(adj: string): void {
  if (!music) return;
  const [field, raw] = adj.split(':');
  const delta = Number(raw);
  const a = music.analysis;
  if (field === 'bpm') a.bpm = Math.min(200, Math.max(60, a.bpm + delta));
  else a.offsetSec = Math.round((a.offsetSec + delta) * 100) / 100;
  updateMusicCard();
  refreshChartLab();
}

// ---------- 节奏工坊（你给音乐 → 我出节奏，看得见、调得动） ----------

/** 谱面 = 开局实际使用谱面（工坊预览与游戏同源） */
function buildCurrentChart(): Chart {
  return music
    ? buildChart({
      bpm: music.analysis.bpm,
      offsetSec: music.analysis.offsetSec,
      durationSec: music.buffer.duration,
      difficulty,
      sections: music.analysis.sections,
      beatStrength: music.analysis.beatStrength,
      style: chartStyle,
      seed: chartSeed,
    })
    : buildDefaultChart(difficulty, chartStyle, chartSeed);
}

function refreshChartLab(): void {
  const cv = $<HTMLCanvasElement>('#chart-preview');
  if (!cv.offsetParent) return; // 不可见（不在准备屏）就不重绘
  labChart = buildCurrentChart();
  renderChartPreview(labChart);
  const st = chartStats(labChart);
  const mm = Math.floor(st.durationSec / 60);
  const ss = Math.round(st.durationSec % 60);
  $('#lab-sub').textContent = `${music ? `♪ ${music.name}` : '内置节拍'} · ${STYLE_LABEL[chartStyle]}`;
  $('#style-desc').textContent = STYLE_DESC[chartStyle];
  const counts = LANE_ORDER.map((a) =>
    `<span class="stat-a" style="color:${ACTION_COLOR[a]}">${ACTION_GLYPH[a]}${st.byAction[a]}</span>`).join('');
  $('#chart-stats').innerHTML =
    `<b>${st.total}</b> 块 · <b>${st.golds}</b> 金块 · ${mm}:${String(ss).padStart(2, '0')} · ${counts}`;
}

const SECTION_BG: Record<SectionKind, string> = {
  intro: 'rgba(255,255,255,0.04)',
  verse: 'rgba(52,120,199,0.14)',
  chorus: 'rgba(255,149,0,0.17)',
  break: 'rgba(255,255,255,0.02)',
  outro: 'rgba(255,255,255,0.05)',
};
const SECTION_LABEL: Record<SectionKind, string> = {
  intro: '前奏', verse: '主歌', chorus: '★ 副歌', break: '过门', outro: '尾奏',
};

/** 钢琴卷帘式谱面预览：横轴 = 音乐时间，5 行 = 5 种动作块 */
function renderChartPreview(chart: Chart): void {
  const cv = $<HTMLCanvasElement>('#chart-preview');
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 560;
  const h = cv.clientHeight || 168;
  if (cv.width !== Math.round(w * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#1d1d1f';
  ctx.fillRect(0, 0, w, h);

  const gutter = 24; // 左侧行标槽
  const rulerH = 16; // 顶部段落标签条
  const footH = 12; // 底部时间刻度条
  const laneH = (h - rulerH - footH) / 5;
  const lastBeat = Math.max(16, chart.events.reduce((m, e) => Math.max(m, e.beat), 0) + 4);
  const xOf = (beat: number): number => gutter + (beat / lastBeat) * (w - gutter);

  // 段落底色
  for (const s of chart.sections ?? []) {
    const x0 = xOf(s.startBeat);
    const x1 = xOf(Math.min(s.startBeat + s.lenBeats, lastBeat));
    ctx.fillStyle = SECTION_BG[s.kind];
    ctx.fillRect(x0, 0, x1 - x0, h);
    if (x1 - x0 > 44) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = '10px sans-serif';
      ctx.fillText(SECTION_LABEL[s.kind], x0 + 5, 11);
    }
  }

  // 小节线
  for (let b = 0; b <= lastBeat; b += 4) {
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(xOf(b), rulerH, 1, h - rulerH - footH);
  }

  // 车道行标 + 分隔
  ctx.font = '11px sans-serif';
  LANE_ORDER.forEach((action, i) => {
    const y = rulerH + i * laneH;
    if (i > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(gutter, y, w - gutter, 1);
    }
    ctx.fillStyle = ACTION_COLOR[action];
    ctx.fillText(ACTION_GLYPH[action], 4, y + laneH * 0.62);
  });

  // 动作块（run 长窗画成长条；金块金底描白边）
  for (const ev of chart.events) {
    const i = LANE_ORDER.indexOf(ev.action);
    if (i < 0) continue;
    const bw = Math.max(3, (((ev.window ?? 1) * 0.85) / lastBeat) * (w - gutter));
    const bh = Math.max(4, laneH - 6);
    const x = xOf(ev.beat) - bw / 2;
    const y = rulerH + i * laneH + 3;
    ctx.fillStyle = ev.gold ? GOLD_COLOR : ACTION_COLOR[ev.action];
    ctx.fillRect(x, y, bw, bh);
    if (ev.gold) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
    }
  }

  // 底部时间刻度
  const beatDurSec = 60 / chart.bpm;
  const offset = chart.offsetSec ?? 0;
  const durSec = chartStats(chart).durationSec;
  const stepSec = durSec > 100 ? 30 : 15;
  ctx.fillStyle = 'rgba(255,255,255,0.42)';
  ctx.font = '9px sans-serif';
  for (let t = 0; t <= durSec; t += stepSec) {
    const beat = (t - offset) / beatDurSec;
    if (beat < 0 || beat > lastBeat) continue;
    ctx.fillText(`${t}s`, xOf(beat) + 2, h - 2);
  }
}

/** 导出 beatmap JSON（含段落/事件/参数，可回灌或分享） */
function exportChart(): void {
  if (!labChart) return;
  const st = chartStats(labChart);
  const payload = {
    game: 'WarmingUp 律动跑酷',
    version: 1,
    music: music?.name ?? '内置节拍',
    style: chartStyle,
    styleLabel: STYLE_LABEL[chartStyle],
    difficulty,
    seed: chartSeed,
    bpm: labChart.bpm,
    offsetSec: labChart.offsetSec ?? 0,
    durationSec: st.durationSec,
    generatedAt: new Date().toISOString(),
    sections: labChart.sections ?? [],
    events: labChart.events,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const base = (music?.name ?? 'builtin').replace(/\.[^.]+$/, '');
  a.href = url;
  a.download = `warmingup-beatmap-${base}-${chartStyle}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- 判定校准 ----------
function updateCalibUi(): void {
  const val = $('#calib-val');
  val.textContent = `${calibMs >= 0 ? '+' : ''}${Math.round(calibMs)}ms`;
  const range = $<HTMLInputElement>('#calib-range');
  range.value = String(Math.round(calibMs));
}

function setCalib(ms: number): void {
  calibMs = Math.max(-300, Math.min(300, Math.round(ms)));
  localStorage.setItem(CALIB_KEY, String(calibMs));
  updateCalibUi();
}

/** 自动校准：跟 8 拍提示音打拍子，测系统性延迟（键盘/触屏路径） */
async function runAutoCalib(): Promise<void> {
  const overlay = $('#calib-overlay');
  const status = $('#calib-status');
  const tapBtn = $<HTMLButtonElement>('#calib-tap');
  overlay.classList.add('show');
  status.textContent = '准备…跟着节拍点大按钮（或按空格），共 8 拍';
  await audio.init();

  const taps: number[] = [];
  const onTap = (): void => {
    taps.push(audio.now);
  };
  tapBtn.addEventListener('click', onTap);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === ' ') {
      e.preventDefault();
      onTap();
    }
  };
  window.addEventListener('keydown', onKey);

  try {
    await delay(800);
    const interval = 0.5; // 120BPM
    const startAt = audio.now + 0.6;
    for (let i = 0; i < 8; i++) {
      const t = startAt + i * interval;
      while (audio.now < t - 0.012) await delay(8);
      audio.beep(i === 7);
      status.textContent = `拍 ${i + 1} / 8`;
    }
    await delay(400);

    // 每拍配对最近的点击（±0.35s 内），取中位延迟
    const lags: number[] = [];
    for (let i = 0; i < 8; i++) {
      const beatT = startAt + i * interval;
      let best = Infinity;
      for (const tap of taps) {
        const d = Math.abs(tap - beatT);
        if (d < Math.abs(best - beatT)) best = tap;
      }
      if (Number.isFinite(best) && Math.abs(best - beatT) <= 0.35) lags.push((best - beatT) * 1000);
    }
    if (lags.length >= 4) {
      lags.sort((a, b) => a - b);
      const median = lags[Math.floor(lags.length / 2)];
      setCalib(median);
      status.textContent = `完成！测得延迟 ${median.toFixed(0)}ms，已写入补偿。摄像头模式如仍偏晚，再手动右调。`;
    } else {
      status.textContent = '点击太少，没测准。再试一次？';
    }
  } finally {
    tapBtn.removeEventListener('click', onTap);
    window.removeEventListener('keydown', onKey);
  }
}

// ---------- 关卡系统（1:1：海报选关 → 双语过场 → 关卡玩法 → 下一关） ----------

/** 关卡玩法 → 游戏引擎参数（机位 / 砖块形态） */
function levelGameOpts(def: LevelDef): GameOpts {
  return {
    cameraMode: def.kind === 'run' ? 'first' : 'third',
    brickStyle: def.kind === 'wall' ? 'wall' : def.kind === 'bridge' ? 'glass' : 'block',
  };
}

/** 当前待开玩的关卡（海报墙点选）；null = 自由练习 */
let pendingLevel: LevelDef | null = null;

// ---------- 线上 PK 竞技模式（房间邀请制） ----------
let pkRoom: PkRoomState | null = null;
let pkOpp: PkPlayer | null = null;
let lastPkSyncAt = 0;

/** 海报 PB 徽章（有记录才显示） */
function levelBestHtml(key: string): string {
  const rec = profile.levels[key];
  if (!rec?.best) return '';
  return `<div class="lp-best">⭐ ${rec.stars} · ${rec.best.toLocaleString()}${rec.cleared ? ' ✓' : ''}</div>`;
}

/** 海报墙：5 关 + 自由练习（首屏；点选 → 开玩准备） */
function renderLevels(): void {
  const grid = $('#levels-grid');
  const posters = LEVELS.map((lv) => `
    <button class="level-poster" data-level="${lv.id}" style="--lp-accent:${lv.poster.accent}">
      <div class="lp-bg"></div>
      <div class="lp-emoji">${lv.poster.emoji}</div>
      <div class="lp-lv">${lv.lv}</div>
      <div class="lp-name">${lv.nameEn}</div>
      <div class="lp-sub">${lv.poster.sub}</div>
      <div class="lp-cn">${lv.nameCn}</div>
      ${levelBestHtml(lv.id)}
    </button>`).join('');
  grid.innerHTML = `${posters}
    <button class="level-poster free" data-level="">
      <div class="lp-bg"></div>
      <div class="lp-emoji">🎛</div>
      <div class="lp-lv">FREE</div>
      <div class="lp-name">FREE PLAY</div>
      <div class="lp-sub">工坊谱面 · 自由练习</div>
      <div class="lp-cn">你的音乐你的节奏</div>
      ${levelBestHtml('free')}
    </button>`;
  grid.querySelectorAll<HTMLElement>('.level-poster').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.level ?? '';
      pendingLevel = LEVELS.find((l) => l.id === id) ?? null;
      renderPrepareHero();
      showScreen('screen-prepare');
      refreshChartLab(); // 节奏工坊画布按真实宽度补绘
    });
  });
}

// ---------- 线上 PK 竞技模式：房间邀请 → 分屏同跑 → 结算胜负 ----------
let pkSeq = 0;
/** PK 用哪张关卡图（准备屏带过来；邀请链接进房时以房间关卡为准） */
let pkLevelDef: LevelDef | null = null;

function pkShowPanel(which: 'idle' | 'waiting' | 'matched'): void {
  $('#pk-idle').hidden = which !== 'idle';
  $('#pk-waiting').hidden = which !== 'waiting';
  $('#pk-matched').hidden = which !== 'matched';
}

function cleanupPk(): void {
  pkSeq++;
  void pkLeave(pkRoom);
  pkRoom = null;
  pkOpp = null;
}

/** 邀请链接：当前地址 + ?pkroom=房码（扫码/点开即入房） */
function pkInviteUrl(code: string): string {
  const u = new URL(location.href);
  u.searchParams.set('pkroom', code);
  return u.toString();
}

// ---------- 全局身份：playerId + 昵称（PK / 榜单 / 在线共用一套） ----------
function myId(): string {
  let id = localStorage.getItem('wu.playerId');
  if (!id) {
    id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `p-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    localStorage.setItem('wu.playerId', id);
  }
  return id;
}
function myName(): string {
  return (localStorage.getItem('wu.lbName') || '').trim().slice(0, 12) || '匿名玩家';
}
/** 右上角昵称 chip（菜单/PK 页多个节点同步；档案头部名条只显名字） */
function renderNick(): void {
  document.querySelectorAll<HTMLElement>('.nick-chip').forEach((el) => {
    el.textContent = el.classList.contains('pfh-name') ? myName() : `👤 ${myName()}`;
  });
}
/** 自绘昵称弹层（红线：不用原生 prompt，APK 兜底横排弹窗不跟转）。
 *  first === true 走首进欢迎变体：引导文案 + 「保存并开始」+ 隐藏取消。 */
function openNickModal(first: unknown = false): void {
  const modal = $('#nick-modal');
  const input = $<HTMLInputElement>('#nick-input');
  if (!modal || !input) return;
  const welcome = first === true;
  const title = $('#nick-title');
  const sub = $('#nick-sub');
  const save = $<HTMLButtonElement>('#btn-nick-save');
  const cancel = $<HTMLButtonElement>('#btn-nick-cancel');
  if (title) title.textContent = welcome ? '👋 欢迎来到 WarmingUp' : '设置昵称';
  if (sub) {
    sub.textContent = welcome
      ? '先给自己起个名字吧——PK 对战、排行榜、在线列表都认它，下次进来还是这个名字'
      : 'PK 对战、排行榜、在线列表都用这个名字';
  }
  if (save) save.textContent = welcome ? '保存并开始' : '保存';
  if (cancel) cancel.hidden = welcome;
  input.value = welcome ? '' : (myName() === '匿名玩家' ? '' : myName());
  modal.classList.add('show');
  input.focus();
}
function closeNickModal(): void {
  $('#nick-modal')?.classList.remove('show');
}
function saveNick(): void {
  const input = $<HTMLInputElement>('#nick-input');
  const name = (input?.value ?? '').trim().slice(0, 12) || '匿名玩家';
  localStorage.setItem('wu.lbName', name);
  renderNick();
  closeNickModal();
  showToast('昵称已保存');
  void pollPresence(); // 立即同步给在线列表
}
function pkSaveName(): string {
  return myName();
}

// ---------- 手柄连接状态（顶部 chip + 设置徽章 + 向导弹层 + 游戏 HUD） ----------
/** 手柄 id 常带长后缀，取括号前短名显示 */
function shortPadName(id: string): string {
  const m = id.split('(')[0].trim();
  return (m || id).slice(0, 14);
}
let padWasConnected = false;
let padPollTimer = 0;
function refreshPadStatus(): void {
  const names = connectedPadNames();
  const on = names.length > 0;
  const short = on ? shortPadName(names[0]) : '';
  const st = $('#pad-status');
  if (st) {
    st.textContent = on ? `🟢 已连接：${short}` : '⚪ 未连接 · 点「连接手柄」看方法';
    st.classList.toggle('on', on);
  }
  const chip = $('#pad-chip');
  if (chip) {
    chip.textContent = on ? `🎮 ${short}` : '🎮 手柄未连';
    chip.classList.toggle('pad-on', on);
  }
  const det = $('#pad-detect');
  if (det) {
    det.textContent = on
      ? `✅ 已连接：${names[0].slice(0, 36)}`
      : '⏳ 等待手柄… 配对好后请按一下任意按键';
    det.classList.toggle('on', on);
  }
  const dev = $('#pad-devices');
  if (dev) {
    dev.innerHTML = on ? names.map((n) => `🎮 ${escapeHtml(n)}`).join('<br/>') : '';
  }
  const hudPad = $('#hud-pad');
  if (hudPad) {
    hudPad.hidden = !(on && source === 'pad');
    const nm = $('#hud-pad-name');
    if (nm && on) nm.textContent = short;
  }
  if (on && !padWasConnected) showToast(`🎮 手柄已连接：${short}`);
  if (!on && padWasConnected) showToast('🎮 手柄已断开');
  padWasConnected = on;
}
/** 连接向导弹层：打开即 250ms 快轮询（平时 1.5s），连接变绿立刻可见 */
function openPadModal(): void {
  $('#pad-modal')?.classList.add('show');
  refreshPadStatus();
  window.clearInterval(padPollTimer);
  padPollTimer = window.setInterval(refreshPadStatus, 250);
}
function closePadModal(): void {
  $('#pad-modal')?.classList.remove('show');
  window.clearInterval(padPollTimer);
  padPollTimer = 0;
}

function diffLabel(d: string): string {
  return d === 'easy' ? '轻松' : d === 'hard' ? '挑战' : '标准';
}

// ---------- 房间大厅：首页入口 + 公开房间列表 ----------
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

// ---------- 对战关卡选择器（自绘下拉，替代原生 select） ----------
// APK/WebView 兜底横排时窗口仍是竖屏，原生 <select> 弹窗由系统竖向绘制、
// 不跟 CSS 旋转走，故改为自绘弹层，随 #app 一起转。
let pkLevelPick = '';
function pkRenderLevelPick(): void {
  const btn = $<HTMLButtonElement>('#pk-level');
  const menu = $('#pk-level-menu');
  if (!btn || !menu) return;
  const def = LEVELS.find((l) => l.id === pkLevelPick) ?? LEVELS[0] ?? null;
  if (def) pkLevelPick = def.id;
  btn.innerHTML = `${def ? `${def.lv} ${escapeHtml(def.nameCn)}` : '选择关卡'}<span class="pk-caret">▾</span>`;
  menu.innerHTML = LEVELS.map((l) => `<li><button type="button" class="pk-select-opt${l.id === pkLevelPick ? ' on' : ''}" role="option" aria-selected="${l.id === pkLevelPick}" data-level="${escapeHtml(l.id)}">${l.lv} ${escapeHtml(l.nameCn)}</button></li>`).join('');
  menu.querySelectorAll<HTMLButtonElement>('.pk-select-opt').forEach((el) => {
    el.addEventListener('click', () => {
      pkLevelPick = el.dataset.level ?? pkLevelPick;
      pkRenderLevelPick();
      pkOpenLevelMenu(false);
    });
  });
}
function pkOpenLevelMenu(open: boolean): void {
  const menu = $('#pk-level-menu');
  const btn = $<HTMLButtonElement>('#pk-level');
  const app = $('#app');
  if (!menu || !btn) return;
  menu.classList.remove('drop-up');
  menu.style.maxHeight = '';
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (!open || !app) return;
  // 贴合可见边界：放不下就向上弹并收窄高度。
  // 用屏幕矩形距离判断（旋转是等距变换，方向自动适配兜底横排/真横屏两种形态）。
  // 边界取「最近的裁剪祖先」（滚动容器/overflow hidden），不是 #app——
  // getBoundingClientRect 不反映被祖先裁剪，按 #app 算会让菜单顶进滚动视口外被切掉。
  const clipper = ((): HTMLElement => {
    for (let n: HTMLElement | null = btn.parentElement; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.overflow !== 'visible' || cs.overflowY !== 'visible' || cs.overflowX !== 'visible') return n;
    }
    return app;
  })();
  const ab = clipper.getBoundingClientRect();
  const bb = btn.getBoundingClientRect();
  const mb = menu.getBoundingClientRect();
  const dx = (mb.left + mb.right - bb.left - bb.right) / 2;
  const dy = (mb.top + mb.bottom - bb.top - bb.bottom) / 2;
  const roomToward = (dirX: number, dirY: number): number => {
    if (Math.abs(dirX) >= Math.abs(dirY)) {
      return dirX < 0 ? bb.left - ab.left : ab.right - bb.right;
    }
    return dirY < 0 ? bb.top - ab.top : ab.bottom - bb.bottom;
  };
  const downX = Math.sign(dx);
  const downY = Math.sign(dy);
  const roomBelow = roomToward(downX, downY);
  const roomAbove = roomToward(-downX, -downY);
  const wantBelow = roomBelow >= roomAbove;
  const space = Math.max((wantBelow ? roomBelow : roomAbove) - 12, 80);
  if (!wantBelow) menu.classList.add('drop-up');
  // maxHeight 是上限（border-box）：内容更矮时盒子自然收缩，不会撑满
  menu.style.maxHeight = `${space}px`;
  // 选中项滚入可视区（只动菜单自身滚动，不惊动外层滚动容器）
  const on = menu.querySelector<HTMLElement>('.pk-select-opt.on');
  if (on) {
    if (on.offsetTop < menu.scrollTop) menu.scrollTop = on.offsetTop - 6;
    else if (on.offsetTop + on.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = on.offsetTop + on.offsetHeight - menu.clientHeight + 6;
    }
  }
}

let roomBannerTimer = 0;
function startRoomBannerPoll(): void {
  if (roomBannerTimer) return;
  roomBannerTimer = window.setInterval(() => void refreshRoomBanner(), 10000);
}
function stopRoomBannerPoll(): void {
  window.clearInterval(roomBannerTimer);
  roomBannerTimer = 0;
}

/** 首页房间入口横幅：实时显示可加入/进行中的房间数 */
async function refreshRoomBanner(): Promise<void> {
  const sub = document.querySelector('#room-banner-sub');
  if (!sub) return;
  try {
    const list = await pkRoomList();
    const bits: string[] = [];
    if (list.joinable > 0) bits.push(`${list.joinable} 个房间可加入`);
    if (list.playing > 0) bits.push(`${list.playing} 局对战进行中`);
    sub.textContent = bits.length ? bits.join(' · ') : '暂无开放房间，点进来创建一个';
  } catch { /* 网络异常保持原文案 */ }
}

let pkListTimer = 0;
function startPkListPoll(): void {
  stopPkListPoll();
  pkListTimer = window.setInterval(() => {
    if (!$('#pk-idle').hidden && document.querySelector('.screen.active')?.id === 'screen-pk') {
      void pkRefreshRoomList();
    }
  }, 5000);
}
function stopPkListPoll(): void {
  window.clearInterval(pkListTimer);
  pkListTimer = 0;
}

/** 拉取并渲染公开房间列表（大厅） */
async function pkRefreshRoomList(): Promise<void> {
  try {
    renderPkRoomList(await pkRoomList());
  } catch { /* 忽略 */ }
}

function renderPkRoomList(list: PkRoomList): void {
  const box = $('#pk-room-list');
  if (!box) return;
  if (!list.rooms.length) {
    box.innerHTML = '<p class="lead small pk-rooms-empty">暂时没有公开房间——创建一个，让大家来加入！</p>';
    return;
  }
  box.innerHTML = list.rooms.map((r) => {
    const lv = LEVELS.find((l) => l.id === r.level);
    const joinable = r.state === 'waiting' && r.players < r.maxPlayers;
    return `<div class="pk-room-row">
      <div class="pk-room-emoji">${lv?.poster.emoji ?? '🎮'}</div>
      <div class="pk-room-info">
        <div class="pk-room-title">${escapeHtml(lv?.nameCn ?? r.level)} <span class="pk-room-meta">· ${escapeHtml(r.host)} 的房间</span></div>
        <div class="pk-room-meta">${escapeHtml(lv?.lv ?? '')} ${diffLabel(r.difficulty)} · ${r.players}/${r.maxPlayers} 人 · 房码 ${escapeHtml(r.code)}</div>
      </div>
      ${joinable
        ? `<button class="btn btn-primary btn-small pk-room-join" data-code="${escapeHtml(r.code)}">加入</button>`
        : '<span class="pk-room-state playing">对局中</span>'}
    </div>`;
  }).join('');
  box.querySelectorAll<HTMLElement>('.pk-room-join').forEach((el) => {
    el.addEventListener('click', () => void pkJoinRoomFlow(el.dataset.code ?? ''));
  });
}

// ---------- 在线玩家 + 点对点 PK 邀请 ----------
let presenceTimer = 0;
let presenceBusy = false;
let fastPollUntil = 0; // 发出邀请后短暂加速心跳，让发起方尽早拿到房间、双方对齐开跑
let shownInviteId = ''; // 当前弹窗的邀请 id（同一邀请只弹一次）
const joinHandled = new Set<string>(); // 已进过的被接受房间（防重复进房）
const myInviteState = new Map<string, string>(); // invId -> 上次 state（变化时 toast）

function avatarFor(id: string): string {
  const icons = ['🐯', '🐰', '🦊', '🐼', '🐸', '🦁', '🐵', '🦄', '🐺', '🐱', '🐮', '🐷'];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return icons[Math.abs(h) % icons.length];
}

/** 心跳：在线列表 + 邀请收发反馈 + 被接受的房间（进 VS） */
async function pollPresence(): Promise<void> {
  if (presenceBusy) return;
  presenceBusy = true;
  try {
    await pollPresenceOnce();
  } finally {
    presenceBusy = false;
  }
}
async function pollPresenceOnce(): Promise<void> {
  let st: PresenceState;
  try {
    st = await pkPresence(myId(), myName());
  } catch {
    return; // 网络异常静默
  }
  renderOnline(st);
  // 我发出的邀请：状态变化时反馈（accepted 的进房由 joinRoom 统一处理）
  for (const inv of st.myInvites) {
    const prev = myInviteState.get(inv.id);
    myInviteState.set(inv.id, inv.state);
    if (prev && prev !== inv.state) {
      const who = inv.toName || '对手';
      if (inv.state === 'accepted') showToast(`⚔️ ${who} 接受了你的 PK 邀请，开战！`);
      else if (inv.state === 'rejected') showToast(`✖ ${who} 拒绝了你的邀请`);
      else if (inv.state === 'expired') showToast(`⌛ 发给 ${who} 的邀请已过期`);
    }
  }
  // 被接受的房间：发起方在这里拿到房间视图，直接进 VS 倒计时
  const jr = st.joinRoom;
  if (jr && !joinHandled.has(jr.roomCode) && pkRoom?.roomCode !== jr.roomCode
    && document.querySelector('.screen.active')?.id !== 'screen-game') {
    joinHandled.add(jr.roomCode);
    closeInviteModal();
    pkEnterInvitedRoom(jr);
  }
  // 发给我的待回应邀请 → 弹窗；邀请中途失效 → 关窗提示
  const incoming = st.invites[0] ?? null;
  if (incoming && incoming.id !== shownInviteId && !jr) {
    shownInviteId = incoming.id;
    showInviteModal(incoming);
  } else if (!incoming && shownInviteId) {
    closeInviteModal();
    showToast('邀请已失效');
  }
}

/** 在线玩家列表（排除自己；空闲可邀 / 对局中只读） */
function renderOnline(st: PresenceState): void {
  const n = st.online.length;
  const top = $('#pk-online');
  if (top) top.textContent = `🟢 在线 ${n + 1} 人`;
  const count = $('#pk-online-count');
  if (count) count.textContent = `${n} 人`;
  const list = $('#pk-online-list');
  if (!list) return;
  const sent = new Map<string, string>(); // toId -> invId（我发出的 pending）
  for (const inv of st.myInvites) if (inv.state === 'pending') sent.set(inv.toId, inv.id);
  if (!n) {
    list.innerHTML = '<p class="lead small pk-rooms-empty">暂时没有其他玩家在线——把邀请链接发给好友，一起来场 PK！</p>';
    return;
  }
  list.innerHTML = st.online.map((u) => {
    const invId = sent.get(u.id) ?? '';
    const action = u.busy
      ? '<span class="pk-room-state playing">🔥 对局中</span>'
      : invId
        ? `<button type="button" class="btn btn-ghost btn-small pk-invite-cancel" data-inv="${escapeHtml(invId)}">等待回应… 撤销</button>`
        : `<button type="button" class="btn btn-primary btn-small pk-invite-btn" data-to="${escapeHtml(u.id)}" data-name="${escapeHtml(u.name)}">邀请 PK</button>`;
    return `<div class="pk-online-row"><span class="pk-ava">${avatarFor(u.id)}</span><span class="pk-online-name">${escapeHtml(u.name)}</span>${action}</div>`;
  }).join('');
}

function showInviteModal(inv: PkInvite): void {
  const modal = $('#invite-modal');
  if (!modal) return;
  $('#invite-title').textContent = `${inv.fromName} 邀请你 PK`;
  const lv = LEVELS.find((l) => l.id === inv.level);
  $('#invite-sub').textContent = `${lv ? `${lv.lv} ${lv.nameCn}` : '对战关卡'} · ${diffLabel(inv.difficulty)} —— 同关同时开跑，比拼真本事！`;
  modal.classList.add('show');
}
function closeInviteModal(): void {
  $('#invite-modal')?.classList.remove('show');
  shownInviteId = '';
}

/** 回应邀请：同意 → 服务端建私密房，双方直接进 VS；拒绝 → 通知发起方 */
async function respondInvite(accept: boolean): Promise<void> {
  const invId = shownInviteId;
  if (!invId) { closeInviteModal(); return; }
  closeInviteModal();
  try {
    const room = await pkInviteRespond(invId, myId(), accept);
    if (room) {
      joinHandled.add(room.roomCode);
      showToast('⚔️ 接受挑战，开战！');
      pkEnterInvitedRoom(room);
    } else {
      showToast('已拒绝邀请');
    }
  } catch {
    if (accept) showToast('回应失败，邀请可能已失效');
  }
}

/** 发起 PK 邀请（目标须在线且空闲） */
async function sendInviteTo(u: { id: string; name: string }): Promise<void> {
  const levelId = pkLevelPick || pkLevelDef?.id || LEVELS[0]?.id || 'circus-run';
  try {
    await pkInvite(myId(), myName(), u.id, levelId, difficulty);
    fastPollUntil = Date.now() + 65000; // 快速心跳直到邀请解决（TTL 60s）
    showToast(`已向 ${u.name} 发出 PK 邀请，等 TA 回应…`);
  } catch (e) {
    const msg = String(e);
    showToast(msg.includes('404') ? `${u.name} 已经离线了`
      : msg.includes('409') ? '你或对方正在对局中，稍后再邀'
      : '邀请发送失败，请检查网络');
  }
  void pollPresence();
}
async function cancelInviteTo(invId: string): Promise<void> {
  await pkInviteCancel(invId, myId());
  showToast('已撤销邀请');
  void pollPresence();
}

/** 被邀请进房（同意邀请 / 我的邀请被接受）：直接进 VS 倒计时 */
function pkEnterInvitedRoom(room: PkRoomState): void {
  if (document.querySelector('.screen.active')?.id === 'screen-game') return; // 对局中不抢屏
  const seq = ++pkSeq;
  pkRoom = room;
  pkLevelDef = LEVELS.find((l) => l.id === room.level) ?? LEVELS[0];
  pkLevelPick = pkLevelDef?.id ?? '';
  renderNick();
  pkRenderLevelPick();
  showScreen('screen-pk');
  void pkVsCountdown(seq, room);
}

function startPresencePoll(): void {
  if (presenceTimer) return;
  void pollPresence();
  let tick = 0;
  presenceTimer = window.setInterval(() => {
    const scr = document.querySelector('.screen.active')?.id;
    if (scr !== 'screen-menu' && scr !== 'screen-pk') return;
    tick++;
    // 平时 5s 一次；发邀请后 1s 一次（拿房快，双方起跑不偏）
    if (Date.now() < fastPollUntil || tick % 5 === 0) void pollPresence();
  }, 1000);
}

/** PK 大厅：创建房间邀人 / 输码加入；带 ?pkroom= 的邀请链接自动填码加入 */
function pkEnter(): void {
  cleanupPk();
  showScreen('screen-pk');
  pkShowPanel('idle');
  renderNick();
  pkLevelDef = pendingLevel ?? currentLevel;
  // 大厅：关卡选择器（首页入口进来时默认第一关，可改）+ 公开房间列表
  pkLevelPick = pkLevelDef?.id ?? '';
  pkRenderLevelPick();
  void pkRefreshRoomList();
  startPkListPoll();
  void pollPresence(); // 在线列表 + 邀请收发心跳
  const inviteCode = new URLSearchParams(location.search).get('pkroom');
  if (inviteCode) {
    $<HTMLInputElement>('#pk-code').value = inviteCode.toUpperCase();
    const u = new URL(location.href);
    u.searchParams.delete('pkroom');
    history.replaceState(null, '', u.toString());
    void pkJoinRoomFlow(inviteCode);
  }
}

/** 创建房间（房主）：房码 + 二维码 + 邀请链接，等对手进来 */
async function pkCreateFlow(): Promise<void> {
  const seq = ++pkSeq;
  const name = pkSaveName();
  const levelId = pkLevelPick || pkLevelDef?.id || '';
  const def = LEVELS.find((l) => l.id === levelId) ?? null;
  if (!def) {
    showToast('先选一个对战关卡');
    return;
  }
  const isPublic = $<HTMLInputElement>('#pk-public').checked;
  try {
    const room = await pkCreateRoom(name, def.id, difficulty, isPublic);
    if (seq !== pkSeq) { void pkLeave(room); return; }
    pkRoom = room;
    $('#pk-room-code').textContent = room.roomCode;
    $('#pk-wait-title').textContent = '房间已创建';
    $('#pk-wait-lead').innerHTML = '让好友扫二维码，或把链接发给 TA：<br>两人到齐自动开跑！';
    $('#pk-wait-sub').textContent = '等待对手加入… 0s';
    void QRCode.toCanvas($<HTMLCanvasElement>('#pk-qr'), pkInviteUrl(room.roomCode), {
      width: 220, margin: 1, color: { dark: '#1d1d1f' },
    });
    pkShowPanel('waiting');
    await pkWaitForOpponent(seq);
  } catch {
    if (seq === pkSeq) showToast('创建房间失败，请检查网络后重试');
  }
}

/** 加入房间（输码 / 扫码 / 邀请链接直达） */
async function pkJoinRoomFlow(code: string): Promise<void> {
  const seq = ++pkSeq;
  const name = pkSaveName();
  try {
    const room = await pkJoinRoom(code, name);
    if (seq !== pkSeq) { void pkLeave(room); return; }
    pkRoom = room;
    if (room.state === 'playing' && room.opponent) {
      await pkVsCountdown(seq, room);
    } else {
      $('#pk-room-code').textContent = room.roomCode;
      $('#pk-wait-title').textContent = '已加入房间';
      $('#pk-wait-lead').textContent = '对手马上就到，准备开跑！';
      $('#pk-wait-sub').textContent = '等待开局…';
      pkShowPanel('waiting');
      await pkWaitForOpponent(seq);
    }
  } catch (e) {
    if (seq !== pkSeq) return;
    pkShowPanel('idle');
    const msg = String(e);
    showToast(msg.includes('404') ? '房间不存在或已失效' : msg.includes('409') ? '房间已满（2 人）' : '加入失败，请检查网络');
  }
}

/** 等对手就位（轮询房间状态）→ 一起进 VS 倒计时 */
async function pkWaitForOpponent(seq: number): Promise<void> {
  let waited = 0;
  while (seq === pkSeq && pkRoom) {
    await delay(1000);
    if (seq !== pkSeq || !pkRoom) return;
    waited++;
    try {
      const st = await pkRoomStatus(pkRoom);
      if (seq !== pkSeq || !pkRoom) return;
      pkRoom = { ...pkRoom, ...st, playerId: pkRoom.playerId };
      if (st.state === 'playing' && st.opponent) {
        await pkVsCountdown(seq, st);
        return;
      }
      if (st.opponentLeft && waited > 3 && st.state !== 'waiting') {
        $('#pk-wait-sub').textContent = '对手已离开房间';
        return;
      }
      $('#pk-wait-sub').textContent = `等待对手加入… ${waited}s`;
    } catch { /* 网络抖动继续等 */ }
    if (waited > 600) return;
  }
}

/** VS 卡倒计时（按服务端 startAt 对齐）→ 开跑 */
async function pkVsCountdown(seq: number, room: PkRoomState): Promise<void> {
  pkRoom = { ...(pkRoom ?? room), ...room, playerId: pkRoom?.playerId ?? room.playerId };
  pkOpp = room.opponent;
  const def = pkLevelDef ?? LEVELS.find((l) => l.id === room.level) ?? LEVELS[0];
  pkLevelDef = def;
  $('#pk-me-name').textContent = myName();
  $('#pk-opp-name').textContent = room.opponent?.name ?? '对手';
  $('#pk-opp-tag').textContent = 'LIVE';
  $('#pk-map-info').textContent = `本局地图：${def.lv} · ${def.nameCn} · ${diffLabel(room.difficulty)}`;
  pkShowPanel('matched');
  for (;;) {
    const left = Math.ceil((room.startAt - Date.now()) / 1000);
    if (left <= 0 || seq !== pkSeq) break;
    $('#pk-count').textContent = `${left} 秒后开跑…`;
    await delay(250);
  }
  if (seq !== pkSeq) return;
  $('#pk-count').textContent = 'GO!';
  await pkStartRun();
}

/** 开跑：同谱面（房间 seed）分屏对战 */
async function pkStartRun(): Promise<void> {
  if (!pkRoom) return;
  const def = pkLevelDef ?? LEVELS[0];
  currentLevel = def;
  await startGame(buildLevelChart(def, (pkRoom.difficulty as Difficulty) || 'normal', pkRoom.seed), {
    ...levelGameOpts(def),
    split: true,
  });
}

/** 再来一局：双方都点 → 同房间新谱面重开 */
async function pkRematchFlow(): Promise<void> {
  if (!pkRoom) return;
  const seq = ++pkSeq;
  showScreen('screen-pk');
  $('#pk-room-code').textContent = pkRoom.roomCode;
  $('#pk-wait-title').textContent = '再来一局';
  $('#pk-wait-lead').textContent = '等对手也确认，马上重开！';
  $('#pk-wait-sub').textContent = '等待对手确认…';
  pkShowPanel('waiting');
  try {
    await pkRematch(pkRoom);
  } catch { /* 轮询兜底 */ }
  await pkWaitForOpponent(seq);
}

/** 开玩准备：关卡横幅（海报视觉延续）；工坊只属于自由练习 */
function renderPrepareHero(): void {
  $('#prepare-sub').textContent = pendingLevel ? `${pendingLevel.lv} · ${pendingLevel.nameCn}` : '自由练习';
  const rec = profile.levels[pendingLevel?.id ?? 'free'];
  const best = rec?.best
    ? `<div class="phb-best">⭐ ${rec.stars} · 最佳 ${rec.best.toLocaleString()}${rec.cleared ? ' · 已通关' : ''}</div>`
    : '<div class="phb-best new">首次挑战 · 加油！</div>';
  const hero = $('#prepare-hero');
  if (pendingLevel) {
    hero.style.setProperty('--lp-accent', pendingLevel.poster.accent);
    hero.innerHTML = `
      <div class="phb-emoji">${pendingLevel.poster.emoji}</div>
      <div class="phb-text">
        <div class="phb-lv">${pendingLevel.lv} · ${pendingLevel.nameEn}</div>
        <div class="phb-name">${pendingLevel.nameCn}</div>
        <div class="phb-sub">${pendingLevel.poster.sub}</div>
      </div>
      ${best}`;
  } else {
    hero.style.setProperty('--lp-accent', '#0071e3');
    hero.innerHTML = `
      <div class="phb-emoji">🎛</div>
      <div class="phb-text">
        <div class="phb-lv">FREE · FREE PLAY</div>
        <div class="phb-name">自由练习</div>
        <div class="phb-sub">工坊谱面 · 你的音乐你的节奏</div>
      </div>
      ${best}`;
  }
  // 竞技 PK 只跟关卡走（同谱面 seed 对决）：自由练习不提供，已选则回落训练模式
  const pkCard = document.querySelector<HTMLElement>('.mode-card[data-scene="pk"]');
  if (pkCard) pkCard.hidden = !pendingLevel;
  if (!pendingLevel && scene === 'pk') selectCard('scene', 'train');
  $('#music-card').hidden = !!pendingLevel; // 音乐工坊只跟自由练习有关
}

/** 双语过场卡（黑底 + 速度线，到时自动收起） */
function showIntroCard(en: string, cn: string, lv: string, ms = 2600): Promise<void> {
  return new Promise((resolve) => {
    $('#li-en').textContent = en;
    $('#li-cn').textContent = cn;
    $('#li-lv').textContent = lv;
    const el = $('#level-intro');
    el.hidden = false;
    window.setTimeout(() => {
      el.hidden = true;
      resolve();
    }, ms);
  });
}

async function startLevel(def: LevelDef): Promise<void> {
  currentLevel = def;
  await showIntroCard(def.introEn, def.introCn, def.lv, 2600);
  await startGame(buildLevelChart(def, difficulty, chartSeed), levelGameOpts(def));
}

/** 再来一局（关卡：同关重开；影子挑战：同谱面重赛；PK：同房间重开不离房） */
function restartCurrent(): void {
  const rival = ghostRival;
  const pk = pkRoom;
  if (pk) {
    // PK 再来一局 = 同房间新谱面（只收对局，不离房）
    game?.stop();
    game = null;
    pose?.stop();
    pose = null;
    padInput?.stop();
    padInput = null;
    classifier = new ActionClassifier();
    void pkRematchFlow();
    return;
  }
  quitGame();
  if (currentLevel) {
    void startGame(buildLevelChart(currentLevel, difficulty, chartSeed), levelGameOpts(currentLevel));
  } else if (rival) {
    ghostRival = rival;
    void startGame(chartFromGhost(rival));
  } else {
    void startGame();
  }
}

// ---------- 游戏 ----------
async function startGame(chartOverride?: Chart, opts?: GameOpts): Promise<void> {
  void requestLandscape(); // 尽早发起（吃手势时效），结果由 resize 回调收敛
  await audio.init();
  showScreen('screen-game');
  clearTimeline();
  shownScore = 0;
  shownCombo = 0;
  const hud = $('#game-hud');
  hud.style.display = 'flex';
  $('#hud-score').style.display = scene !== 'class' ? 'flex' : 'none';
  $('#cue').hidden = true;

  const canvas = $<HTMLCanvasElement>('#game-canvas');
  // 谱面：关卡谱面 / 与节奏工坊预览同源（style/seed/BPM/偏移即所见即所玩）
  const chart = chartOverride ?? buildCurrentChart();
  // 影子挑战：重置分数时间轴采样 + 对比条
  currentChart = chart;
  ghostTrace = [];
  lastTracedScore = -1;
  runElapsedMs = 0;
  const gbar = $('#ghost-bar');
  gbar.hidden = !ghostRival;
  const rivalName = ghostRival?.name;
  if (rivalName) {
    $('#gb-name').textContent = rivalName;
    $('#gb-rival').textContent = '0';
    $('#gb-you').textContent = '0';
    $('#gb-rival-fill').style.width = '0%';
    $('#gb-you-fill').style.width = '0%';
  }
  // 关卡模式用关卡自带节拍（合成 BGM），自由练习支持自定义音乐
  if (!currentLevel && music) audio.loadBacking(music.buffer);
  else audio.clearBacking();

  const coachName = look.coachImage ? '你的领操员' : '麦吉教练';
  // 关卡模式：关卡主题打底（背景随关卡），皮肤沿用用户装扮；自由练习用完整装扮
  const gameLook = currentLevel
    ? { ...currentLook(), theme: currentLevel.theme, bgImage: null, bgPalette: null }
    : currentLook();
  game = new Game(canvas, chart, audio, scene, {
    onBanner: (label, color, action) => {
      // 1:1 圆盘口令组件（黑圆盘 + EN 斜体 + 中文大字）
      const cue = $('#cue');
      cue.hidden = false;
      $('#cue-en').textContent = action ? ACTION_LABEL_EN[action] : 'READY';
      $('#cue-en').style.color = color;
      $('#cue-cn').textContent = label;
      $('#cue-glyph').innerHTML = action
        ? `<img alt="" src="${poseSilhouette(action, color, 160)}">`
        : '⏱';
      $('#cue-disc').style.borderColor = color;
      // 底部横幅（课堂大字口令）保留
      const b = $('#action-banner');
      $('#action-text').textContent = label;
      b.style.color = color;
      b.classList.remove('show');
      void b.offsetWidth;
      b.classList.add('show');
    },
    onJudge: (r: JudgeResult) => {
      showJudge(r);
      coachReact(r);
      pulseTimelineLine();
    },
    onHud: (s: GameStats) => updateHud(s),
    onCountdown: (text) => {
      const cd = $('#countdown');
      cd.textContent = text;
      // P1 数字动效：每次换数字重新弹一下
      cd.classList.remove('tick');
      void cd.offsetWidth;
      cd.classList.add('tick');
    },
    onEnd: (s: GameStats) => {
      // 冲线庆祝 1.15s 后再进结算，让教练欢呼被看到
      void delay(1150).then(() => showResult(s));
    },
    onTimeline: (items) => renderTimeline(items),
    onPhase: (kind) => {
      const ph = $('#hud-phase');
      if (!currentLevel || currentLevel.kind !== 'redlight') {
        ph.hidden = true;
        return;
      }
      ph.hidden = false;
      ph.classList.toggle('stop', kind === 'stop');
      $('#phase-text').textContent = kind === 'stop' ? 'RED LIGHT · 定格！' : 'GREEN LIGHT · 冲！';
    },
    onTimer: (secsLeft, progress) => {
      const mm = Math.floor(secsLeft / 60);
      const ss = Math.floor(secsLeft % 60);
      $('#hud-timer').textContent = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
      $('#hp-fill').style.width = `${(progress * 100).toFixed(1)}%`;
    },
    onMilestone: (combo: number) => {
      // 连击里程碑横幅（每 10 连击爆发，50/100 连击分级加码）
      const el = $('#combo-banner');
      const tier = combo >= 100 ? 2 : combo >= 50 ? 1 : 0;
      const sub = tier === 2 ? 'legend时刻 · 无人能挡' : tier === 1 ? '热力全开 · 无人可挡' : '节奏拉满 · 连击不断';
      el.innerHTML = `<b>${combo} COMBO!</b><small>${sub}</small>`;
      el.classList.remove('show', 'hot', 'legend');
      void el.offsetWidth;
      if (tier > 0) el.classList.add('hot');
      if (tier > 1) el.classList.add('legend');
      el.classList.add('show');
      burstConfetti(tier === 2 ? 24 : tier === 1 ? 14 : 8);
    },
    onDemo: (action: GameAction | null) => {
      const el = $('#coach-label');
      if (action) {
        el.textContent = `${coachName} · 示范：${ACTION_LABEL[action]}`;
        el.classList.add('demoing');
        el.style.color = ACTION_COLOR[action];
      } else {
        el.textContent = `${coachName} · 动作示范`;
        el.classList.remove('demoing');
        el.style.color = '';
      }
    },
  }, gameLook, opts);
  game.calibSec = calibMs / 1000;

  // 分屏 PK：右半对手舞台 + 中央比分条就位（对手舞台时钟从 0 起，sync 后插值推进）
  const isPk = !!pkRoom;
  $('#pk-vs-bar').hidden = !isPk;
  $('#pk-opp-panel').hidden = !isPk;
  $('#screen-game').classList.toggle('pk-split', isPk);
  if (isPk) {
    game.setOpponent(0);
    if (pkOpp) {
      $('#pkb-opp-name').textContent = pkOpp.name;
      $('#pop-name').textContent = pkOpp.name;
    }
  }

  window.addEventListener('resize', () => {
    game?.resize();
    if (labChart) renderChartPreview(labChart); // 谱面预览随窗口/旋屏重绘
  });

  // 输入源接线
  if (source === 'direct') {
    const video = $<HTMLVideoElement>('#game-video');
    $('#pip-wrap').classList.remove('hidden');
    try {
      pose?.stop();
      pose = await PoseInput.create(video, (landmarks, _fps, numPoses) => {
        updatePoseHints(video, landmarks, numPoses ?? 1);
        drawPoseOverlay(landmarks);
        // 玩家横移 → 镜头轻微转向/倾斜（镜像口径）
        if (landmarks && landmarks[23] && landmarks[24]) {
          const hipX = (landmarks[23].x + landmarks[24].x) / 2;
          game?.setSteer((0.5 - hipX) * 2);
        }
        for (const a of classifier.push(landmarks)) {
          game?.pushAction(a, audio.now);
        }
      });
      await pose.startCamera(
        mirrorPlay
          ? { video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: { ideal: 'environment' } } }
          : undefined,
      );
    } catch {
      $('#pip-wrap').classList.add('hidden');
    }
  } else if (source === 'phone') {
    $('#pip-wrap').classList.add('hidden');
    drawPoseOverlay(null);
    // pairing 在菜单阶段已建立 host，onAction 直通 game.pushAction
  } else {
    // 手柄/键盘：免摄像头免手机
    $('#pip-wrap').classList.add('hidden');
    drawPoseOverlay(null);
  }

  // 手柄/键盘输入常开（摄像头/手机模式下也可作备用输入；无手柄时轮询近零开销）
  padInput?.stop();
  padInput = new GamepadInput((a) => game?.pushAction(a, audio.now));
  padInput.start();
  if (source === 'pad') {
    showPoseHint('🎮 就绪：↑/W跳 ↓/S踩 ←→移动 J挥 K蹲 L跑');
  }

  game.start().catch((e) => console.error('[wu] game.start 失败', e));
  startBeatPulse();
}

const JUDGE_TEXT: Record<JudgeQuality, string> = {
  perfect: 'PERFECT!',
  great: 'GREAT!',
  good: 'GOOD',
  miss: 'MISS',
};

function showJudge(r: JudgeResult): void {
  const el = $('#judge-float');
  if (scene === 'class') {
    el.textContent = r.quality === 'miss' ? '跟上节奏！' : r.quality === 'good' ? '不错！' : '棒！';
    el.dataset.q = r.quality === 'miss' ? 'miss' : 'hit';
  } else {
    const cn = r.quality === 'perfect' ? '完美' : r.quality === 'great' ? '很棒' : r.quality === 'good' ? '不错' : '失误';
    const en = r.gold && r.quality !== 'miss' ? `⭐ ${JUDGE_TEXT[r.quality]}` : JUDGE_TEXT[r.quality];
    el.innerHTML = `<b>${en}</b><small>${cn}</small>`;
    el.dataset.q = r.quality;
  }
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
  // Perfect 全屏光圈（金砖加强版）
  if (r.quality === 'perfect') {
    const ring = $('#perfect-ring');
    ring.classList.remove('show', 'gold');
    void ring.offsetWidth;
    if (r.gold) ring.classList.add('gold');
    ring.classList.add('show');
  }
  // miss 红色暗角（受击反馈）
  if (r.quality === 'miss') {
    const flash = $('#miss-flash');
    flash.classList.remove('show');
    void flash.offsetWidth;
    flash.classList.add('show');
  }
}

// ---------- 结算/里程碑彩带（霓虹纸屑） ----------
interface Confetto {
  x: number; y: number; vx: number; vy: number;
  w: number; h: number; rot: number; vr: number;
  color: string; life: number;
}
const CONFETTI_COLORS = ['#ffd60a', '#ff9f0a', '#ff375f', '#66e0ff', '#bf5af2', '#30d158', '#ffffff'];
const confetti: Confetto[] = [];
let confettiRaf = 0;

function burstConfetti(n: number): void {
  const cv = $<HTMLCanvasElement>('#confetti-canvas');
  const w = cv.clientWidth || window.innerWidth;
  const h = cv.clientHeight || window.innerHeight;
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  for (let i = 0; i < n; i++) {
    confetti.push({
      x: w * (0.18 + Math.random() * 0.64),
      y: h * (0.16 + Math.random() * 0.18),
      vx: (Math.random() - 0.5) * 9,
      vy: -(3 + Math.random() * 7),
      w: 6 + Math.random() * 8,
      h: 3 + Math.random() * 5,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.35,
      color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
      life: 1,
    });
  }
  if (!confettiRaf) confettiRaf = requestAnimationFrame(tickConfetti);
}

function tickConfetti(): void {
  const cv = $<HTMLCanvasElement>('#confetti-canvas');
  const ctx = cv.getContext('2d');
  if (!ctx) { confettiRaf = 0; return; }
  ctx.clearRect(0, 0, cv.width, cv.height);
  for (let i = confetti.length - 1; i >= 0; i--) {
    const c = confetti[i];
    c.vy += 0.32; // 重力
    c.vx *= 0.995;
    c.x += c.vx;
    c.y += c.vy;
    c.rot += c.vr;
    c.life -= 0.014;
    if (c.life <= 0 || c.y > cv.height + 40) {
      confetti.splice(i, 1);
      continue;
    }
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.rot);
    ctx.globalAlpha = Math.min(1, c.life * 1.6);
    ctx.fillStyle = c.color;
    ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
    ctx.restore();
  }
  if (confetti.length) confettiRaf = requestAnimationFrame(tickConfetti);
  else { confettiRaf = 0; ctx.clearRect(0, 0, cv.width, cv.height); }
}

// ---------- BPM 呼吸律动（--beat 变量随拍写入，HUD/横幅随拍明暗） ----------
let beatRaf = 0;
let beatChart: Chart | null = null;

function startBeatPulse(): void {
  stopBeatPulse();
  beatChart = currentChart;
  if (!beatChart) return;
  const tick = (): void => {
    const chart = beatChart;
    if (!chart || !audio.playing) {
      document.documentElement.style.setProperty('--beat', '0');
      beatRaf = requestAnimationFrame(tick);
      return;
    }
    const t = audio.now - audio.songStart - (chart.offsetSec ?? 0);
    const phase = (((t * chart.bpm) / 60) % 1 + 1) % 1;
    const env = Math.pow(1 - phase, 2.1);
    document.documentElement.style.setProperty('--beat', env.toFixed(3));
    beatRaf = requestAnimationFrame(tick);
  };
  beatRaf = requestAnimationFrame(tick);
}

function stopBeatPulse(): void {
  if (beatRaf) cancelAnimationFrame(beatRaf);
  beatRaf = 0;
  beatChart = null;
  document.documentElement.style.setProperty('--beat', '0');
}

// ---------- 左侧剪影窗骨架叠加（白骨架暗底，参考大屏装置） ----------
const POSE_EDGES: Array<[number, number]> = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [28, 30], [30, 32],
];

function drawPoseOverlay(landmarks: Array<{ x: number; y: number }> | null): void {
  const cv = $<HTMLCanvasElement>('#pose-overlay');
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const w = cv.clientWidth || 150;
  const h = cv.clientHeight || 200;
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  ctx.clearRect(0, 0, w, h);
  if (!landmarks) return;
  // 与视频显示同向（镜像）绘制
  ctx.save();
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = Math.max(3, w * 0.028);
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(255,255,255,0.75)';
  ctx.shadowBlur = 8;
  for (const [a, b] of POSE_EDGES) {
    const pa = landmarks[a];
    const pb = landmarks[b];
    if (!pa || !pb) continue;
    ctx.beginPath();
    ctx.moveTo(pa.x * w, pa.y * h);
    ctx.lineTo(pb.x * w, pb.y * h);
    ctx.stroke();
  }
  // 头（用肩宽比例画圆）
  const head = landmarks[0];
  const shL = landmarks[11];
  const shR = landmarks[12];
  if (head) {
    const r = shL && shR
      ? Math.max(6, Math.hypot((shL.x - shR.x) * w, (shL.y - shR.y) * h) * 0.42)
      : w * 0.07;
    ctx.beginPath();
    ctx.arc(head.x * w, head.y * h, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  // 关节点
  ctx.fillStyle = '#fff';
  for (const p of landmarks) {
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, Math.max(2.4, w * 0.015), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------- 底部 pictogram 时间轴（Just Dance 式） ----------
const TIMELINE_PX_PER_SEC = 96;
const tlChips = new Map<number, HTMLDivElement>();

function renderTimeline(items: Array<{ beat: number; action: GameAction; inSecs: number; gold: boolean }>): void {
  const track = $('#timeline-track');
  const seen = new Set<number>();
  for (const it of items) {
    seen.add(it.beat);
    let el = tlChips.get(it.beat);
    if (!el) {
      el = document.createElement('div');
      el.className = `tl-chip tl-${it.action}${it.gold ? ' tl-gold' : ''}`;
      // 直接展示姿势剪影（不套方卡）：摆什么姿势就画什么姿势
      const silColor = it.gold ? GOLD_COLOR : ACTION_COLOR[it.action];
      el.innerHTML = `<i><img alt="" src="${poseSilhouette(it.action, silColor, 160)}"></i><b>${ACTION_LABEL[it.action].replace('！', '')}</b>`;
      track.appendChild(el);
      tlChips.set(it.beat, el);
    }
    el.style.transform = `translate(calc(-50% + ${(it.inSecs * TIMELINE_PX_PER_SEC).toFixed(1)}px), -50%)`;
    el.style.opacity = String(Math.min(1, 0.5 + (6 - it.inSecs) * 0.1));
  }
  for (const [beat, el] of tlChips) {
    if (!seen.has(beat)) {
      el.remove();
      tlChips.delete(beat);
    }
  }
}

function clearTimeline(): void {
  for (const el of tlChips.values()) el.remove();
  tlChips.clear();
}

function pulseTimelineLine(): void {
  const line = $('#timeline-line');
  line.classList.remove('pulse');
  void line.offsetWidth;
  line.classList.add('pulse');
}

// ---------- 教练人设反馈（夸奖/鼓励气泡） ----------
/** P1 评级称号（结算仪式：按星级授予头衔） */
const RANK_TITLES = ['元气新手', '节奏学徒', '节拍猎手', '律动大师', '节奏之神'];
const COACH_LINES: Record<JudgeQuality, string[]> = {
  perfect: ['就是这样！✨', '完美！继续保持！', '太棒了！👏', '节奏感真好！'],
  great: ['很棒！', '漂亮！👏', '就差一点点就完美！'],
  good: ['不错，保持住！', '跟上啦！', '很好，继续！'],
  miss: ['没关系，跟上节奏！', '加油，再来一次！', '调整呼吸，动起来！'],
};
let bubbleTimer = 0;

function coachReact(r: JudgeResult): void {
  const el = $('#coach-bubble');
  const pool = COACH_LINES[r.quality];
  el.textContent = pool[Math.floor(Math.random() * pool.length)];
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  window.clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(() => el.classList.remove('show'), 1700);
}

let shownScore = 0;
let shownCombo = 0;
let lastPoppedScore = -1;
let lastScorePopAt = 0;

function updateHud(s: GameStats): void {
  const comboEl = $('#hud-combo');
  comboEl.innerHTML = `${s.combo} <span>COMBO</span>`;
  // 连击数字跳变（每 +1 弹一下）
  if (s.combo !== shownCombo) {
    if (s.combo > 0) {
      comboEl.classList.remove('bump');
      void comboEl.offsetWidth;
      comboEl.classList.add('bump');
    }
    shownCombo = s.combo;
  }
  const mult = $('#hud-mult');
  mult.textContent = `×${s.multiplier}`;
  mult.classList.toggle('hot', s.multiplier >= 3);
  mult.style.display = scene !== 'class' && s.multiplier > 1 ? 'block' : 'none';
  // 冲刺拖影：四角速度线随连击倍率升温（幂等 toggle，每帧安全）
  const rushLines = document.querySelector('#screen-game .speed-lines');
  if (rushLines) {
    rushLines.classList.toggle('speeding', s.multiplier >= 2);
    rushLines.classList.toggle('speeding-hot', s.multiplier >= 4);
  }
  // 分数滚动追值（每帧指数平滑）
  shownScore += (s.score - shownScore) * 0.16;
  if (Math.abs(s.score - shownScore) < 1) shownScore = s.score;
  $('#hud-score').textContent = String(Math.round(shownScore));
  // P1 数字动效：有新增分就轻弹一下（180ms 节流防连续抖碎）
  if (s.score > 0 && s.score !== lastPoppedScore && performance.now() - lastScorePopAt > 180) {
    lastPoppedScore = s.score;
    lastScorePopAt = performance.now();
    const se = $('#hud-score');
    se.classList.remove('pop');
    void se.offsetWidth;
    se.classList.add('pop');
  }
  $('#hud-kcal').textContent = `${s.kcal.toFixed(0)} kcal`;
  // 血量（1:1 ❤100，miss 扣 4）
  $('#hud-hearts').innerHTML = `❤ <b>${Math.max(0, 100 - s.misses * 4)}</b>`;
  // 影子挑战：分数时间轴采样（发起挑战时压进链接）+ 实时对比条
  const elapsedMs = Math.max(0, (audio.now - audio.songStart) * 1000);
  runElapsedMs = elapsedMs;
  if (currentChart && s.score !== lastTracedScore) {
    ghostTrace.push([Math.round(elapsedMs), s.score]);
    lastTracedScore = s.score;
  }
  if (pkRoom && Date.now() - lastPkSyncAt > 1000) {
    lastPkSyncAt = Date.now();
    const prog = s.total > 0 ? (s.hits + s.misses) / s.total : 0;
    void pkSync(pkRoom, { score: s.score, progress: prog, t: elapsedMs / 1000, combo: s.combo, done: false })
      .then((o) => {
        pkOpp = o;
        if (o) game?.setOpponent(o.t); // 对手舞台时钟 → 分屏右半镜像
      })
      .catch(() => {});
  }
  if (pkRoom) {
    // 分屏 PK：中央实时比分条 + 右半对手面板
    const oppScore = pkOpp?.score ?? 0;
    $('#pkb-my').textContent = String(s.score);
    $('#pkb-opp').textContent = String(oppScore);
    const lead = s.score - oppScore;
    const leadEl = $('#pkb-lead');
    leadEl.textContent = lead > 0 ? `领先 ${lead}` : lead < 0 ? `落后 ${-lead}` : '咬紧比分！';
    leadEl.classList.toggle('ahead', lead > 0);
    $('#pop-name').textContent = pkOpp?.name ?? '对手';
    $('#pop-score').textContent = String(oppScore);
    $('#pop-combo').textContent = `${pkOpp?.combo ?? 0} COMBO`;
    $('#pop-fill').style.width = `${((pkOpp?.progress ?? 0) * 100).toFixed(1)}%`;
  } else if (ghostRival) {
    const rivalScore = ghostScoreAt(ghostRival, elapsedMs);
    $('#gb-rival').textContent = String(rivalScore);
    $('#gb-you').textContent = String(s.score);
    const peak = Math.max(rivalScore, s.score, 1);
    $('#gb-rival-fill').style.width = `${(rivalScore / peak) * 100}%`;
    $('#gb-you-fill').style.width = `${(s.score / peak) * 100}%`;
  }
}

async function showResult(s: GameStats): Promise<void> {
  stopBeatPulse();
  const acc = s.total > 0 ? (s.perfects + s.greats * 0.75 + s.goods * 0.45) / s.total : 0;
  const accPct = Math.round(acc * 100);
  const stars = acc >= 0.95 ? 5 : acc >= 0.88 ? 4 : acc >= 0.75 ? 3 : acc >= 0.6 ? 2 : 1;
  // 评级徽章（S/A/B/C/D）
  const grade = acc >= 0.95 ? 'S' : acc >= 0.88 ? 'A' : acc >= 0.75 ? 'B' : acc >= 0.6 ? 'C' : 'D';
  const gradeEl = $('#rs-grade');
  gradeEl.textContent = grade;
  gradeEl.dataset.g = grade;
  // P1 评级称号（结算仪式：按星级授予头衔）
  const rankEl = $('#rs-rank');
  rankEl.textContent = RANK_TITLES[stars - 1] ?? RANK_TITLES[0];
  rankEl.dataset.t = String(stars);
  // 分数滚动上跳（缓出）
  const scoreEl = $('#rs-score');
  scoreEl.textContent = '0';
  const rollT0 = performance.now();
  const rollScore = (now: number): void => {
    const k = Math.min(1, (now - rollT0) / 750);
    scoreEl.textContent = String(Math.round(s.score * (1 - Math.pow(1 - k, 3))));
    if (k < 1) requestAnimationFrame(rollScore);
  };
  requestAnimationFrame(rollScore);
  $('#rs-combo').textContent = String(s.maxCombo);
  $('#rs-acc').textContent = `${accPct}%`;
  $('#rs-kcal').textContent = s.kcal.toFixed(0);
  // 星级逐个弹入（五星全满时叠一道爆光）
  const starsEl = $('#rs-stars');
  starsEl.classList.remove('full');
  starsEl.innerHTML = Array.from({ length: 5 }, (_, i) =>
    `<i class="${i < stars ? 'on' : ''}" style="animation-delay:${i * 130}ms">★</i>`).join('');
  if (stars >= 5) {
    void starsEl.offsetWidth;
    starsEl.classList.add('full');
  }
  // 判定分布条（先归零，双 rAF 后铺开让 transition 生效）
  const total = Math.max(1, s.total);
  const counts: number[] = [s.perfects, s.greats, s.goods, s.misses];
  const barEls = document.querySelectorAll<HTMLElement>('#rs-bars .rs-bar');
  barEls.forEach((bar, i) => {
    const n = counts[i] ?? 0;
    const b = bar.querySelector('b');
    if (b) b.textContent = String(n);
    const fill = bar.querySelector('i');
    if (fill) fill.style.width = '0%';
  });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    barEls.forEach((bar, i) => {
      const n = counts[i] ?? 0;
      const fill = bar.querySelector('i');
      if (fill) fill.style.width = `${(n / total) * 100}%`;
    });
  }));
  $('#rs-break').textContent = `金砖 ×${s.golds} · 动作 ${s.total} 次`;
  $('#result-emoji').textContent = stars >= 5 ? '🏆' : stars >= 3 ? '🎉' : '💪';
  $('#result-title').textContent = currentLevel
    ? `${currentLevel.nameCn} 完成！`
    : scene === 'class' ? '全班都动起来了！' : '热身完成！';
  // ---------- P0：入档（打卡 / PB / 星星 / 成就） ----------
  const levelKey = currentLevel?.id ?? 'free';
  const levelName = currentLevel?.nameCn ?? (scene === 'class' ? '课堂热身' : '自由练习');
  const rec = recordGame(profile, {
    stats: s, levelKey, levelName, grade, stars,
    durationSec: runElapsedMs / 1000, totalLevels: LEVELS.length,
    daily: dailyMode,
  });
  dailyMode = false; // 每日挑战只作用于紧接着的这一局
  refreshStarCount();
  $('#rs-extra').hidden = false;
  $('#rs-record').hidden = !rec.newRecord;
  $('#rs-earn').innerHTML = `⭐ 本局 +${rec.starsEarned} 星星${rec.firstClear ? ' · 🚩 首通 +5' : ''}${rec.newRecord ? ' · 🔥 破纪录 +1' : ''}${rec.dailyBonus ? ` · 🗓 今日挑战 +${rec.dailyBonus}` : ''}${rec.rankUp ? ` · 🎯 晋升 ${rec.rankUp.icon}${rec.rankUp.name}` : ''}`;
  $('#rs-ach').innerHTML = rec.achievements
    .map((a) => `<span class="rs-ach-item">${a.icon} ${a.name}</span>`).join('');
  // 对战结果：线上 PK 优先，其次影子对决
  const rg = $('#rs-ghost');
  if (pkRoom) {
    $('#rs-extra').hidden = false;
    rg.hidden = false;
    rg.classList.remove('win');
    rg.textContent = '⚡ 线上 PK · 对手成绩确认中…';
    const room = pkRoom;
    void (async () => {
      let oppRes: PkResult | null = null;
      let oppName = pkOpp?.name ?? '对手';
      let oppLeft = false;
      try {
        for (let i = 0; i < 8; i++) {
          const r = await pkResult(room, { score: s.score, combo: s.maxCombo, grade });
          if (r.opponent?.name) oppName = r.opponent.name;
          oppLeft = r.opponentLeft;
          if (r.opponentResult) {
            oppRes = r.opponentResult;
            break;
          }
          if (r.opponentLeft) break;
          await delay(2000);
        }
      } catch { /* 网络异常按当前比分裁决 */ }
      const oppScore = oppRes ? oppRes.score : (pkOpp?.score ?? 0);
      if (!oppRes) {
        rg.textContent = `⚡ 线上 PK ${s.score} : ${oppScore} —— ${oppName} ${oppLeft ? '离开房间' : '掉线弃权'}，你获胜！`;
        rg.classList.add('win');
        return;
      }
      const win = s.score > oppScore;
      const draw = s.score === oppScore;
      rg.textContent = draw
        ? `⚡ 线上 PK ${s.score} : ${oppScore} —— 平局！`
        : win
          ? `⚡ 线上 PK ${s.score} : ${oppScore} —— 你赢了 ${oppName}！`
          : `⚡ 线上 PK ${s.score} : ${oppScore} —— 惜败 ${oppName}，再战一局！`;
      rg.classList.toggle('win', win || draw);
    })();
  } else if (ghostRival) {
    const win = s.score >= ghostRival.res.score;
    rg.textContent = win
      ? `👻 影子对决 ${s.score} : ${ghostRival.res.score} —— 你赢了 ${ghostRival.name}！`
      : `👻 影子对决 ${s.score} : ${ghostRival.res.score} —— 惜败，再战一局！`;
    rg.hidden = false;
    rg.classList.toggle('win', win);
  } else {
    rg.hidden = true;
  }
  // 分享/挑战快照
  lastRun = { stats: s, grade, stars, levelName };
  // 成就 + 段位晋升合并成一条 toast（showToast 单条覆盖式）
  const toasts: string[] = [];
  if (rec.achievements.length) toasts.push(`🏆 新成就：${rec.achievements.map((a) => a.name).join('、')}`);
  if (rec.rankUp) toasts.push(`🎯 段位晋升：${rec.rankUp.icon} ${rec.rankUp.name}`);
  if (toasts.length) showToast(toasts.join('　'));
  // 全服排行榜上榜（课堂模式不计分不上榜；网络失败静默不打扰）
  const rsLb = $('#rs-lb');
  if (scene === 'class') {
    rsLb.hidden = true;
  } else {
    lbLevel = levelKey; // 档案榜单默认定位到本局关卡，跑完进档案直接看到自己的名次
    rsLb.hidden = false;
    rsLb.textContent = '🌍 成绩上传中…';
    const lbName = localStorage.getItem('wu.lbName') || '匿名玩家';
    void lbSubmit(levelKey, lbName, s.score, s.maxCombo, grade).then((r) => {
      const top3 = r.top.slice(0, 3)
        .map((e) => `${e.rank}. ${e.name} ${e.score}`).join('　');
      rsLb.innerHTML = r.rank > 0
        ? `🌍 全服第 <b>${r.rank}</b> 名 / 共 ${r.total} 人${r.improved ? ' —— 榜上有名！' : ''}${top3 ? `<div class="rs-lb-top">${top3}</div>` : ''}`
        : `🌍 本局 ${s.score} 分，暂未进前 50（当前 ${r.total} 人上榜）`;
    }).catch(() => { rsLb.hidden = true; });
  }
  // 下一关按钮（关卡链末尾隐藏）
  const next = currentLevel ? nextLevel(currentLevel.id) : null;
  $<HTMLButtonElement>('#btn-next-level').hidden = !next;
  // 通关 WIN 卡（1:1 双语）：打完 BONUS 才弹
  if (currentLevel && !next) {
    await showIntroCard('YOU WON THE AMAZING DIGITAL CIRCUS!', '你赢了神奇数字马戏团！', '🏆', 2300);
  }
  showScreen('screen-result');
  // 结算彩带（高光局大爆发，普通局小庆祝）——在结算屏出现后爆，纸屑飘落在结果卡上
  burstConfetti(stars >= 4 || rec.newRecord || rec.firstClear ? 90 : 30);
}

function quitGame(): void {
  stopBeatPulse();
  game?.stop();
  game = null;
  pose?.stop();
  pose = null;
  padInput?.stop();
  padInput = null;
  classifier = new ActionClassifier();
  ghostRival = null; // 影子对决只在本局有效（重赛由 restartCurrent 接棒）
  cleanupPk();
  showScreen('screen-menu');
}

// ---------- 工具 ----------
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 投屏到电视 ----------
interface PresentationConnectionLike {
  close(): void;
  onconnect: (() => void) | null;
  onterminate: (() => void) | null;
}
interface PresentationRequestLike {
  start(): Promise<PresentationConnectionLike>;
}

function setupCast(): void {
  const CastCtor = (window as unknown as {
    PresentationRequest?: new (urls: string[]) => PresentationRequestLike;
  }).PresentationRequest;
  if (!CastCtor) {
    // 无 Presentation API（如 iOS Safari）：一键投屏卡隐藏，走镜像投屏即可
    $<HTMLElement>('#cast-onetap').hidden = true;
  }

  // 按手机系统给镜像步骤（iPhone / 安卓入口叫法不同）
  const ua = navigator.userAgent;
  const osSteps = $('#cast-os-steps');
  if (osSteps) {
    const step2 = '<li>点下面按钮开始（横屏全屏 · 自动保持亮屏）</li>';
    const step3 = '<li>手机支在电视旁，摄像头对着人，直接开玩</li>';
    osSteps.innerHTML = /iPhone|iPad|iPod/i.test(ua)
      ? `<li>从屏幕右上角下滑打开<b>控制中心</b> → 点<b>「屏幕镜像」</b> → 选你的电视</li>${step2}${step3}`
      : /Android/i.test(ua)
        ? `<li>下拉快捷开关 → <b>「无线投屏 / 多屏互动 / 投屏」</b>（各品牌叫法不同）→ 选你的电视</li>${step2}${step3}`
        : `<li>iPhone：控制中心 →「屏幕镜像」→ 选电视；安卓：下拉快捷开关 →「无线投屏 / 多屏互动」→ 选电视</li>${step2}${step3}`;
  }

  $<HTMLButtonElement>('#btn-cast').addEventListener('click', () => showScreen('screen-cast'));
  $<HTMLButtonElement>('#btn-cast-back').addEventListener('click', () => showScreen('screen-menu'));

  $<HTMLButtonElement>('#btn-cast-onetap').addEventListener('click', async () => {
    if (!CastCtor) return;
    const code = randomCode();
    const url = `${location.origin}${location.pathname}?role=cast&code=${code}`;
    const status = $('#cast-status');
    status.textContent = '正在寻找可投屏的电视…';
    status.classList.remove('connected');
    try {
      const conn = await new CastCtor([url]).start();
      status.textContent = '已投屏到电视 ✓ 本机已切换为摄像头识别器';
      status.classList.add('connected');
      conn.onterminate = () => {
        status.textContent = '投屏已断开';
        status.classList.remove('connected');
      };
      // 发起端手机变摄像头：与电视端同一配对码，自动连上
      void runSensorMode(code);
    } catch {
      status.textContent = '投屏未完成：请确认电视已开机、与手机同一 WiFi，且电视支持投屏';
    }
  });

  $<HTMLButtonElement>('#btn-cast-mirror').addEventListener('click', () => {
    // 镜像游玩：本机当游戏机+摄像头（识别器直驱），手机系统镜像把画面投到电视
    userPickedSource = true;
    mirrorPlay = true;
    selectCard('source', 'direct');
    // 全屏须在点击手势内发起；不支持的能力静默降级
    document.documentElement.requestFullscreen().catch(() => {});
    const so = screen.orientation as ScreenOrientation & { lock?(o: string): Promise<void> };
    if (typeof so.lock === 'function') so.lock('landscape').catch(() => {});
    const wl = (navigator as unknown as {
      wakeLock?: { request(t: 'screen'): Promise<unknown> };
    }).wakeLock;
    wl?.request('screen').catch(() => {});
    showScreen('screen-menu');
    refreshChartLab();
  });
}

// ---------- 启动 ----------
/** TV 大屏形态：APK 壳带 ?tv=1（UiModeManager 判定），或电视浏览器 UA */
function isTvDevice(): boolean {
  if (new URLSearchParams(location.search).has('tv')) return true;
  return /TV|SmartTV|Smart-TV|AppleTV|GoogleTV|HbbTV|NetCast|Viera|BRAVIA|Tizen.+TV|Web0S|AFT|XiaoBai/i
    .test(navigator.userAgent);
}

function boot(): void {
  // URL 参数：手机传感器模式 / 投屏接收端（电视）
  const params = new URLSearchParams(location.search);
  const role = params.get('role');
  const code = params.get('code');
  if (role === 'sensor' && code) {
    void runSensorMode(code);
    return;
  }

  setupMenu();
  setupCast();
  window.addEventListener('resize', () => syncForceLandscape());
  window.addEventListener('orientationchange', () => window.setTimeout(syncForceLandscape, 60));
  syncForceLandscape(); // 打开即横排：首屏直接生效（CSS 兜底不依赖手势）
  // 全屏+转向锁需用户手势：首次触摸/按键时补一次请求（结果仍由 resize 回调收敛）
  const onceGesture = () => void requestLandscape();
  document.addEventListener('pointerdown', onceGesture, { once: true, capture: true });
  document.addEventListener('keydown', onceGesture, { once: true, capture: true });

  // P0/P1：星星计数 + 影子挑战横幅（菜单可见前预置）
  refreshStarCount();
  pendingGhost = parseGhostHash();
  refreshGhostBanner();

  // 邀请链接直达：带 ?pkroom= 打开就进 PK 大厅自动加入（深链优先于海报墙/TV 首屏，
  // 必须放在此处——setupMenu 里的直达会被后面的首屏 showScreen 盖掉）
  if (params.get('pkroom')) {
    pkLevelDef = null; // 关卡以房间为准
    pkEnter();
    return;
  }

  if (role === 'cast' && code) {
    // 一键投屏接收端：直接以「手机当识别器」进海报墙（固定配对码，发起端手机自动连上）
    castCode = code;
    userPickedSource = true;
    selectCard('source', 'phone');
    void audio.init();
    showScreen('screen-menu');
    return;
  }

  // TV 形态：跳过体检直达海报墙；默认手机当识别器（进准备屏扫码配对，摄像头对着人）
  if (isTvDevice()) {
    document.documentElement.classList.add('tv-mode');
    $('#tv-hint-bar').hidden = false;
    userPickedSource = true;
    selectCard('source', 'phone');
    void audio.init();
    showScreen('screen-menu');
    return;
  }

  // App 首屏 = 海报墙选关（体检已是工具，不在启动路径上；不启动摄像头）
  showScreen('screen-menu');
}

function setupMenu(): void {
  // 体检按钮
  $('#btn-enter').addEventListener('click', () => {
    checkSkipped = true; // 离开体检 = 不接受迟到结论
    showScreen(checkFrom);
  });
  $('#btn-recheck').addEventListener('click', () => {
    checkSkipped = false; // 重新体检 = 愿意听结论
    void runDeviceCheck();
  });
  $('#btn-back-check').addEventListener('click', () => {
    checkSkipped = false; // 回体检重测 = 重新听体检结论
    showScreen('screen-check');
    void runDeviceCheck();
  });
  $('#btn-settings').addEventListener('click', () => {
    settingsFrom = 'screen-menu';
    showScreen('screen-settings');
  });
  $<HTMLButtonElement>('#btn-pk-back').addEventListener('click', () => {
    cleanupPk();
    showScreen(pendingLevel ? 'screen-prepare' : 'screen-menu');
  });
  $<HTMLButtonElement>('#btn-pk-create').addEventListener('click', () => void pkCreateFlow());
  // 首页房间入口 + 大厅列表
  $('#room-banner').addEventListener('click', () => {
    pendingLevel = null; // 大厅入口不带关卡，由列表/关卡选择器决定
    pkEnter();
  });
  $('#room-banner').addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      $('#room-banner').click();
    }
  });
  // 首页每日挑战横幅（点击/回车/空格开跑）
  $('#daily-banner').addEventListener('click', () => startDaily());
  $('#daily-banner').addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      startDaily();
    }
  });
  $<HTMLButtonElement>('#btn-pk-refresh').addEventListener('click', () => void pkRefreshRoomList());
  // 自绘关卡下拉：点按钮开关、点外面/按 Esc 收起
  $<HTMLButtonElement>('#pk-level').addEventListener('click', () => {
    const menu = $('#pk-level-menu');
    pkOpenLevelMenu(!!menu?.hidden);
  });
  document.addEventListener('click', (e) => {
    if (e.target instanceof Element && !e.target.closest('.pk-level-picker')) {
      pkOpenLevelMenu(false);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') pkOpenLevelMenu(false);
  });
  $<HTMLButtonElement>('#btn-pk-join').addEventListener('click', () => {
    const code = $<HTMLInputElement>('#pk-code').value.trim();
    if (!code) {
      showToast('先输入房间码再加入');
      return;
    }
    void pkJoinRoomFlow(code);
  });
  $<HTMLInputElement>('#pk-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $<HTMLButtonElement>('#btn-pk-join').click();
  });
  $<HTMLButtonElement>('#btn-pk-copy').addEventListener('click', () => {
    if (!pkRoom) return;
    const url = pkInviteUrl(pkRoom.roomCode);
    void navigator.clipboard?.writeText(url).then(
      () => showToast('邀请链接已复制，发给好友来 PK ⚡'),
      () => showToast('复制失败，请长按二维码让好友扫码'),
    );
  });
  $<HTMLButtonElement>('#btn-pk-cancel').addEventListener('click', () => {
    cleanupPk();
    pkShowPanel('idle');
  });
  $<HTMLButtonElement>('#btn-pk-abort').addEventListener('click', () => {
    cleanupPk();
    pkShowPanel('idle');
    showScreen(pendingLevel ? 'screen-prepare' : 'screen-menu');
  });
  // 昵称（右上角 chip → 自绘弹层）+ 在线邀请收发
  // 旧版 PK 昵称一次性迁移为全局昵称
  if (!localStorage.getItem('wu.lbName') && localStorage.getItem('wu.pkname')) {
    localStorage.setItem('wu.lbName', localStorage.getItem('wu.pkname')!);
  }
  renderNick();
  startPresencePoll();
  // 首次进入本设备：自动弹昵称引导（保存后右上角常驻显示，重复进入沿用）
  if (!localStorage.getItem('wu.lbName')) openNickModal(true);
  document.querySelectorAll<HTMLElement>('.nick-chip').forEach((el) => {
    el.addEventListener('click', openNickModal);
  });
  $<HTMLButtonElement>('#btn-nick-save').addEventListener('click', saveNick);
  $<HTMLButtonElement>('#btn-nick-cancel').addEventListener('click', closeNickModal);
  $<HTMLInputElement>('#nick-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveNick();
    if (e.key === 'Escape') closeNickModal();
  });
  $<HTMLButtonElement>('#btn-invite-accept').addEventListener('click', () => void respondInvite(true));
  $<HTMLButtonElement>('#btn-invite-reject').addEventListener('click', () => void respondInvite(false));
  $('#pk-online-list')?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (!btn) return;
    if (btn.classList.contains('pk-invite-btn')) {
      void sendInviteTo({ id: btn.dataset.to ?? '', name: btn.dataset.name ?? '玩家' });
    } else if (btn.classList.contains('pk-invite-cancel')) {
      void cancelInviteTo(btn.dataset.inv ?? '');
    }
  });
  $('#btn-settings-jump').addEventListener('click', () => {
    settingsFrom = 'screen-prepare';
    showScreen('screen-settings');
  });

  // 菜单卡片
  document.querySelectorAll<HTMLElement>('.mode-card[data-scene]').forEach((el) => {
    el.addEventListener('click', () => selectCard('scene', el.dataset.scene ?? 'class'));
  });
  document.querySelectorAll<HTMLElement>('.set-src-row[data-source]').forEach((el) => {
    el.addEventListener('click', () => {
      userPickedSource = true;
      selectCard('source', el.dataset.source ?? 'direct');
    });
  });
  document.querySelectorAll<HTMLElement>('.mode-card[data-difficulty]').forEach((el) => {
    el.addEventListener('click', () => selectDifficulty((el.dataset.difficulty as Difficulty) ?? 'normal'));
  });

  // 手柄连接状态（Joy-Con 蓝牙配对后自动识别；Chrome 系需按键一次才上报）
  window.addEventListener('gamepadconnected', refreshPadStatus);
  window.addEventListener('gamepaddisconnected', refreshPadStatus);
  refreshPadStatus();
  window.setInterval(refreshPadStatus, 1500);
  // 连接向导弹层入口：顶部 chip / 设置页「连接手柄」
  $('#pad-chip')?.addEventListener('click', openPadModal);
  $('#btn-pad-help')?.addEventListener('click', openPadModal);
  $('#btn-pad-close')?.addEventListener('click', closePadModal);

  updateMenuSummary();

  // 定制音乐
  $<HTMLButtonElement>('#btn-music-pick').addEventListener('click', () => {
    $<HTMLInputElement>('#music-file').click();
  });
  $<HTMLInputElement>('#music-file').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void loadMusicFile(file);
  });
  $<HTMLButtonElement>('#btn-music-clear').addEventListener('click', () => {
    music = null;
    $<HTMLInputElement>('#music-file').value = '';
    updateMusicCard();
    refreshChartLab();
  });
  document.querySelectorAll<HTMLButtonElement>('.adj-btn').forEach((el) => {
    el.addEventListener('click', () => adjustMusic(el.dataset.adj ?? ''));
  });

  // 节奏工坊（风格/重新生成/导出）
  document.querySelectorAll<HTMLElement>('.style-chip').forEach((el) => {
    el.addEventListener('click', () => {
      chartStyle = (el.dataset.style as ChartStyle) ?? 'mix';
      document.querySelectorAll<HTMLElement>('.style-chip').forEach((c) =>
        c.classList.toggle('selected', c === el));
      refreshChartLab();
    });
  });
  $<HTMLButtonElement>('#btn-chart-regen').addEventListener('click', () => {
    chartSeed = Math.floor(Math.random() * 997);
    refreshChartLab();
  });
  $<HTMLButtonElement>('#btn-chart-export').addEventListener('click', exportChart);
  refreshChartLab();

  // 主题装扮（背景/领操员）
  document.querySelectorAll<HTMLElement>('.look-chip[data-bg]').forEach((el) => {
    el.addEventListener('click', () => {
      const t = (el.dataset.bg as SceneTheme) ?? 'neon';
      if (t === 'custom') {
        if (look.bgImage) {
          look.theme = 'custom';
          saveLook();
          refreshLookUi();
        } else {
          $<HTMLInputElement>('#bg-file').click();
        }
        return;
      }
      if (!ensureLookUnlocked(`bg:${t}`)) return;
      look.theme = t;
      saveLook();
      refreshLookUi();
    });
  });
  $<HTMLInputElement>('#bg-file').addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const url = await shrinkImage(file, 1280, 'image/jpeg', 0.82);
      const img = await loadImage(url);
      look.bgImage = url;
      look.bgPalette = paletteFromAverage(averageColor(img));
      look.theme = 'custom';
      saveLook();
      refreshLookUi();
    } catch {
      // 图片解码失败：保持原装扮
    }
    (e.target as HTMLInputElement).value = '';
  });
  document.querySelectorAll<HTMLElement>('.look-chip[data-skin]').forEach((el) => {
    el.addEventListener('click', () => {
      const t = (el.dataset.skin as CoachSkin) ?? 'mage';
      if (t === 'custom') {
        if (look.coachImage) {
          look.skin = 'custom';
          saveLook();
          refreshLookUi();
        } else {
          $<HTMLInputElement>('#skin-file').click();
        }
        return;
      }
      if (!ensureLookUnlocked(`skin:${t}`)) return;
      look.skin = t;
      saveLook();
      refreshLookUi();
    });
  });
  $<HTMLInputElement>('#skin-file').addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      look.coachImage = await shrinkImage(file, 640, 'image/png');
      look.skin = 'custom';
      saveLook();
      refreshLookUi();
    } catch {
      // 图片解码失败：保持原装扮
    }
    (e.target as HTMLInputElement).value = '';
  });
  $<HTMLButtonElement>('#btn-look-reset').addEventListener('click', () => {
    look = { theme: 'neon', bgImage: null, bgPalette: null, skin: 'mage', coachImage: null };
    saveLook();
    refreshLookUi();
  });
  refreshLookUi();

  // 判定校准
  updateCalibUi();
  $<HTMLInputElement>('#calib-range').addEventListener('input', (e) => {
    setCalib(Number((e.target as HTMLInputElement).value));
  });
  $<HTMLButtonElement>('#btn-calib').addEventListener('click', () => {
    void runAutoCalib();
  });
  $<HTMLButtonElement>('#calib-close').addEventListener('click', () => {
    $('#calib-overlay').classList.remove('show');
  });

  $('#btn-start').addEventListener('click', () => {
    if (source === 'phone' && pairing && !pairing.isConnected) {
      const el = $('#pair-status');
      el.textContent = '手机还没连上：点 ⚙️ 设置 扫码配对（或改用本机摄像头）';
      el.classList.remove('connected');
      return;
    }
    // 流程：海报墙选关 → 此处配置完 → 开玩；竞技 PK → 进房间邀人对战
    if (scene === 'pk') {
      if (!pendingLevel) {
        showToast('竞技 PK 需要先选一个关卡（同图对决）');
        return;
      }
      pkEnter();
      return;
    }
    if (pendingLevel) {
      void startLevel(pendingLevel);
    } else {
      currentLevel = null;
      void startGame();
    }
  });

  // 游戏退出
  $('#btn-quit').addEventListener('click', quitGame);

  // 结算按钮
  $('#btn-again').addEventListener('click', restartCurrent);
  $('#btn-next-level').addEventListener('click', () => {
    const next = currentLevel ? nextLevel(currentLevel.id) : null;
    if (!next) return;
    quitGame();
    void startLevel(next);
  });
  $('#btn-menu').addEventListener('click', () => {
    quitGame();
  });

  // P0：我的档案
  $('#btn-profile').addEventListener('click', () => {
    renderProfile();
    showScreen('screen-profile');
  });

  // P0：成绩海报（Canvas 生成 PNG 下载）
  $('#btn-share').addEventListener('click', () => {
    if (!lastRun) {
      showToast('先玩一局再分享～');
      return;
    }
    const cv = drawSharePoster(lastRun.stats, {
      grade: lastRun.grade, stars: lastRun.stars, levelName: lastRun.levelName,
    });
    const a = document.createElement('a');
    a.download = `律动跑酷-${lastRun.levelName}.png`;
    a.href = cv.toDataURL('image/png');
    a.click();
    showToast('成绩海报已保存 📸');
  });

  // P1：发起影子挑战（紧凑谱面 + 分数时间轴压进链接）
  $('#btn-ghost-share').addEventListener('click', () => {
    if (!lastRun || !currentChart) {
      showToast('先玩一局再发起挑战～');
      return;
    }
    const g = ghostFromRun(currentChart, ghostTrace, lastRun.stats, lastRun.grade);
    const url = ghostShareUrl(g);
    const ok = (): void => showToast('影子挑战链接已复制，发给好友来 PK 👻');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(ok).catch(() =>
        showToast('复制失败，请手动复制地址栏链接'));
    } else {
      showToast('当前浏览器不支持自动复制，请用新版浏览器');
    }
  });

  // P1：影子挑战接受 / 忽略
  $('#btn-ghost-accept').addEventListener('click', () => {
    const g = pendingGhost;
    if (!g) return;
    pendingGhost = null;
    ghostRival = g;
    currentLevel = null; // 影子挑战按自由模式跑（同谱面）
    $('#ghost-banner').hidden = true;
    void startGame(chartFromGhost(g));
  });
  $('#btn-ghost-dismiss').addEventListener('click', () => {
    pendingGhost = null;
    refreshGhostBanner();
  });

  // 子屏统一返回（← 返回）
  document.querySelectorAll<HTMLElement>('[data-back]').forEach((el) => {
    el.addEventListener('click', () => goBack());
  });

  // 遥控器/键盘（normKey：老 WebView 键名 'Left'/'Up' 与 keyCode 两路兼容）
  window.addEventListener('keydown', (e) => {
    const key = normKey(e);
    if (key === 'Escape' && game) quitGame();
    if (!game || e.repeat) return;
    if (key === 'Enter' || key === ' ') {
      // 电视遥控确认键可当"跳"输入（备用交互）
      game.pushAction('jump', audio.now);
      return;
    }
    // 电视遥控方向键 → 动作映射（备用交互：没手机/手柄时也能玩）
    const arrowMap: Record<string, GameAction> = {
      ArrowUp: 'jump',
      ArrowDown: 'squat',
      ArrowLeft: 'left',
      ArrowRight: 'right',
    };
    const act = arrowMap[key];
    if (act) game.pushAction(act, audio.now);
  });

  // TV/遥控器：菜单焦点导航（游戏中不抢按键；校准弹层时也放行）
  attachTvNav(
    () => game !== null || document.querySelector('#calib-overlay')?.classList.contains('show') === true,
  );

  // TV APK 返回键钩子：1=已在网页内处理（退出对局/返回上屏），0=留给壳双击退出
  (window as unknown as { __tvBack?: () => number }).__tvBack = () => goBack();
}

boot();

// 端到端命中特效验证入口：仅 ?hit-test 时启用（截图测试驱动判定用，正常游玩无影响）
if (new URLSearchParams(location.search).has('hit-test')) {
  (window as unknown as { __hitTick?: () => void }).__hitTick = () => {
    const actions: GameAction[] = ['jump', 'squat', 'punch', 'stomp', 'run', 'left', 'right'];
    for (const a of actions) game?.pushAction(a, audio.now);
  };
}
