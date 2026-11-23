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
  achievementsHtml, buyLook, calendarHtml, drawSharePoster, hasLook, loadProfile,
  LOOK_PRICES, lookPrice, recordGame, type ProfileData,
} from './engine/profile';
import {
  chartFromGhost, ghostFromRun, ghostScoreAt, ghostShareUrl, parseGhostHash, type GhostData,
} from './engine/ghost';
import { ActionClassifier } from './input/classifier';
import { GamepadInput, connectedPadNames } from './input/gamepad';
import { PoseInput } from './input/pose';
import { Pairing, randomCode } from './input/remote';
import { attachTvNav } from './input/tvnav';
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
  if (id === 'screen-menu') renderLevels(); // PB/星星可能更新，海报徽章刷一遍
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
    showScreen('screen-menu');
    return 1;
  }
  if (active === 'screen-prepare') {
    showScreen('screen-menu'); // 回海报墙重选关卡
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

/** 我的档案屏：生涯统计 / 打卡日历 / 成就墙 / 装扮商店 */
function renderProfile(): void {
  refreshStarCount();
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
  const sceneTxt = scene === 'class' ? '🏫 课堂模式' : '🔥 训练模式';
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
  document.querySelectorAll<HTMLElement>(`.mode-card[${attr}]`).forEach((el) => {
    el.classList.toggle('selected', el.getAttribute(attr) === value);
  });
  if (group === 'scene') scene = value as SceneMode;
  else {
    source = value as InputSource;
    updatePairCard();
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
      renderPrepareHead();
      showScreen('screen-prepare');
      refreshChartLab(); // 节奏工坊画布按真实宽度补绘
    });
  });
}

/** 开玩准备：所选关卡信息条 */
function renderPrepareHead(): void {
  $('#prepare-sub').textContent = pendingLevel ? `${pendingLevel.lv} · ${pendingLevel.nameCn}` : '自由练习';
  const rec = profile.levels[pendingLevel?.id ?? 'free'];
  const best = rec?.best
    ? `<div class="ph-best">⭐ ${rec.stars} · 最佳 ${rec.best.toLocaleString()}${rec.cleared ? ' · 已通关' : ''}</div>`
    : '<div class="ph-best new">首次挑战 · 加油！</div>';
  const head = pendingLevel
    ? `<div class="ph-emoji" style="--lp-accent:${pendingLevel.poster.accent}">${pendingLevel.poster.emoji}</div>
       <div class="ph-text"><b>${pendingLevel.lv} · ${pendingLevel.nameCn}</b><span>${pendingLevel.nameEn} · ${pendingLevel.poster.sub}</span></div>`
    : `<div class="ph-emoji" style="--lp-accent:#0071e3">🎛</div>
       <div class="ph-text"><b>FREE · 自由练习</b><span>工坊谱面 · 你的音乐你的节奏</span></div>`;
  $('#prepare-head').innerHTML = `${head}${best}`;
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

/** 再来一局（关卡模式：同关重开；影子挑战：同谱面重赛，不重看过场） */
function restartCurrent(): void {
  const rival = ghostRival;
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
  await audio.init();
  showScreen('screen-game');
  clearTimeline();
  shownScore = 0;
  shownCombo = 0;
  const hud = $('#game-hud');
  hud.style.display = 'flex';
  $('#hud-score').style.display = scene === 'train' ? 'flex' : 'none';
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
  if (ghostRival) {
    $('#gb-name').textContent = ghostRival.name;
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
      $('#countdown').textContent = text;
    },
    onEnd: (s: GameStats) => void showResult(s),
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
      // 连击里程碑横幅（每 10 连击爆发庆祝）
      const el = $('#combo-banner');
      el.innerHTML = `<b>${combo} COMBO!</b><small>节奏拉满 · 连击不断</small>`;
      el.classList.remove('show');
      void el.offsetWidth;
      el.classList.add('show');
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
  // miss 红色暗角（受击反馈）
  if (r.quality === 'miss') {
    const flash = $('#miss-flash');
    flash.classList.remove('show');
    void flash.offsetWidth;
    flash.classList.add('show');
  }
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
  mult.style.display = scene === 'train' && s.multiplier > 1 ? 'block' : 'none';
  // 分数滚动追值（每帧指数平滑）
  shownScore += (s.score - shownScore) * 0.16;
  if (Math.abs(s.score - shownScore) < 1) shownScore = s.score;
  $('#hud-score').textContent = String(Math.round(shownScore));
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
  if (ghostRival) {
    const rivalScore = ghostScoreAt(ghostRival, elapsedMs);
    $('#gb-rival').textContent = String(rivalScore);
    $('#gb-you').textContent = String(s.score);
    const peak = Math.max(rivalScore, s.score, 1);
    $('#gb-rival-fill').style.width = `${(rivalScore / peak) * 100}%`;
    $('#gb-you-fill').style.width = `${(s.score / peak) * 100}%`;
  }
}

async function showResult(s: GameStats): Promise<void> {
  const acc = s.total > 0 ? (s.perfects + s.greats * 0.75 + s.goods * 0.45) / s.total : 0;
  const accPct = Math.round(acc * 100);
  const stars = acc >= 0.95 ? 5 : acc >= 0.88 ? 4 : acc >= 0.75 ? 3 : acc >= 0.6 ? 2 : 1;
  // 评级徽章（S/A/B/C/D）
  const grade = acc >= 0.95 ? 'S' : acc >= 0.88 ? 'A' : acc >= 0.75 ? 'B' : acc >= 0.6 ? 'C' : 'D';
  const gradeEl = $('#rs-grade');
  gradeEl.textContent = grade;
  gradeEl.dataset.g = grade;
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
  // 星级逐个弹入
  $('#rs-stars').innerHTML = Array.from({ length: 5 }, (_, i) =>
    `<i class="${i < stars ? 'on' : ''}" style="animation-delay:${i * 130}ms">★</i>`).join('');
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
  });
  refreshStarCount();
  $('#rs-extra').hidden = false;
  $('#rs-record').hidden = !rec.newRecord;
  $('#rs-earn').innerHTML = `⭐ 本局 +${rec.starsEarned} 星星${rec.firstClear ? ' · 🚩 首通 +5' : ''}${rec.newRecord ? ' · 🔥 破纪录 +1' : ''}`;
  $('#rs-ach').innerHTML = rec.achievements
    .map((a) => `<span class="rs-ach-item">${a.icon} ${a.name}</span>`).join('');
  // 影子对决结果
  const rg = $('#rs-ghost');
  if (ghostRival) {
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
  if (rec.achievements.length) {
    showToast(`🏆 新成就：${rec.achievements.map((a) => a.name).join('、')}`);
  }
  // 下一关按钮（关卡链末尾隐藏）
  const next = currentLevel ? nextLevel(currentLevel.id) : null;
  $<HTMLButtonElement>('#btn-next-level').hidden = !next;
  // 通关 WIN 卡（1:1 双语）：打完 BONUS 才弹
  if (currentLevel && !next) {
    await showIntroCard('YOU WON THE AMAZING DIGITAL CIRCUS!', '你赢了神奇数字马戏团！', '🏆', 2300);
  }
  showScreen('screen-result');
}

function quitGame(): void {
  game?.stop();
  game = null;
  pose?.stop();
  pose = null;
  padInput?.stop();
  padInput = null;
  classifier = new ActionClassifier();
  ghostRival = null; // 影子对决只在本局有效（重赛由 restartCurrent 接棒）
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

  // P0/P1：星星计数 + 影子挑战横幅（菜单可见前预置）
  refreshStarCount();
  pendingGhost = parseGhostHash();
  refreshGhostBanner();

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
    void audio.init();
    showScreen('screen-menu');
    refreshChartLab(); // 菜单可见后按真实宽度重绘画布
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

  // 菜单卡片
  document.querySelectorAll<HTMLElement>('.mode-card[data-scene]').forEach((el) => {
    el.addEventListener('click', () => selectCard('scene', el.dataset.scene ?? 'class'));
  });
  document.querySelectorAll<HTMLElement>('.mode-card[data-source]').forEach((el) => {
    el.addEventListener('click', () => {
      userPickedSource = true;
      selectCard('source', el.dataset.source ?? 'direct');
    });
  });
  document.querySelectorAll<HTMLElement>('.mode-card[data-difficulty]').forEach((el) => {
    el.addEventListener('click', () => selectDifficulty((el.dataset.difficulty as Difficulty) ?? 'normal'));
  });

  // 手柄连接状态（Joy-Con 蓝牙配对后自动识别；Chrome 系需按键一次才上报）
  const padStatus = $('#pad-status');
  const refreshPadStatus = (): void => {
    const names = connectedPadNames();
    padStatus.textContent = names.length
      ? `✅ 已连接：${names[0].slice(0, 22)}`
      : '未连接 · 蓝牙配对后自动识别';
  };
  window.addEventListener('gamepadconnected', refreshPadStatus);
  window.addEventListener('gamepaddisconnected', refreshPadStatus);
  refreshPadStatus();
  window.setInterval(refreshPadStatus, 1500);

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
      el.textContent = '手机还没连上，请先扫码（或改用本机摄像头）';
      el.classList.remove('connected');
      return;
    }
    // 流程：海报墙选关 → 此处配置完 → 开玩
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

  // 遥控器/键盘
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && game) quitGame();
    if (!game || e.repeat) return;
    if (e.key === 'Enter' || e.key === ' ') {
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
    const act = arrowMap[e.key];
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
