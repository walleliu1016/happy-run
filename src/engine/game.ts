import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { Chart, ChartEvent, GameAction, GameStats, JudgeQuality, JudgeResult, SceneMode } from '../types';
import { comboMultiplier, emptyStats } from '../types';
import { ACTION_COLOR, ACTION_LABEL, ACTION_LABEL_EN, ACTION_WINDOW, chartDuration, eventTime } from './chart';
import { drawPoseGlyph, poseSilhouetteCanvas } from './pose-shapes';
import type { BeatAudio } from './audio';
import { duskSkyTexture, glowTexture, gridTerrainTexture, iconTexture, neonMaterial, roadTexture } from './neon-textures';
import { SKIN_CONFIG, THEME_PALETTE, type GameLook, type SkinConfig, type WorldPalette } from './look';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export interface GameOpts {
  /** 机位：first = LV1 跑酷第一人称 / third = 经典第三人称 */
  cameraMode?: 'first' | 'third';
  /** 砖块形态：block 经典 / wall 墙来墙板 / glass 玻璃桥半透明 */
  brickStyle?: 'block' | 'wall' | 'glass';
  /** 分屏对战：界面对半切，右半是对手舞台（同一世界摆到对手时钟镜像渲染） */
  split?: boolean;
}

export interface GameHooks {
  onBanner: (label: string, color: string, action?: GameAction) => void;
  onJudge: (r: JudgeResult) => void;
  onHud: (s: GameStats) => void;
  onCountdown: (text: string) => void;
  onEnd: (s: GameStats) => void;
  /** 教练开始/结束动作演示（null = 回到待机） */
  onDemo?: (action: GameAction | null) => void;
  /** 连击里程碑（每 10 连击爆发庆祝） */
  onMilestone?: (combo: number) => void;
  /** 底部 pictogram 时间轴（Just Dance 式），每帧上报未来数秒的动作 */
  onTimeline?: (items: Array<{ beat: number; action: GameAction; inSecs: number; gold: boolean }>) => void;
  /** 红绿灯窗口切换（null = 无红灯机制，LV4） */
  onPhase?: (kind: 'go' | 'stop' | null) => void;
  /** 关卡倒计时（4Hz）：剩余秒数 + 进度 0–1 */
  onTimer?: (secsLeft: number, progress: number) => void;
}

/** 动作块（拍点的视觉载体：按节拍飞向玩家，命中碎裂） */
interface Brick {
  ev: ChartEvent;
  judged: boolean;
  /** 命中碎裂 vs 未命中穿身 */
  hit: boolean;
  group: THREE.Group;
  glow: THREE.PointLight | null;
  spin: number;
  /** 车道起始 x（向中心漏斗汇聚） */
  baseX: number;
  /** 本块主色（碎裂碎片用） */
  color: number;
  /** 块体材质（未命中淡出用） */
  bodyMat: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
  /** 预判光柱材质（近判定线渐隐；非 block 形态为 null） */
  pillar?: THREE.MeshBasicMaterial | null;
}

const GRAVITY = 26;
const SPEED = 9.5; // 世界单位/秒（约 m/s）
const RING_Z = 6; // 判定线深度：动作块在事件时刻正好触线
const DEMO_LEAD = 1.0; // 提前 1 秒演示

/** 3 跑道世界 X（相机看向 +Z，世界 +X = 屏幕左）：lane 0/1/2 = 世界左/中/右道 */
const LANE3_X: readonly number[] = [-3.7, 0, 3.7];
/** 事件车道 → 世界 X（出现在哪条道，块就渲染在哪条道） */
const laneXOf = (lane: number | undefined): number => LANE3_X[lane ?? 1] ?? 0;

/** 墙来墙板纹理缓存（白墙 + 霓虹洞口描边 + 姿势剪影 + 中英口令） */
const wallTexCache = new Map<string, THREE.CanvasTexture>();
function wallPanelTexture(action: GameAction): THREE.CanvasTexture {
  const hit = wallTexCache.get(action);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 320;
  const g = c.getContext('2d')!;
  g.fillStyle = '#efece6';
  g.fillRect(0, 0, 512, 320);
  const color = ACTION_COLOR[action];
  g.strokeStyle = color;
  g.lineWidth = 16;
  g.strokeRect(30, 30, 452, 260);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(18,10,28,0.88)';
  drawPoseGlyph(g, action, 'rgba(18,10,28,0.88)', 256, 152, 190);
  g.font = 'bold 40px sans-serif';
  g.fillStyle = color;
  g.fillText(ACTION_LABEL_EN[action], 256, 262);
  g.fillStyle = '#221a30';
  g.font = '34px sans-serif';
  g.fillText(ACTION_LABEL[action], 256, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  wallTexCache.set(action, tex);
  return tex;
}

/** 姿势剪影 GL 纹理缓存（玻璃板面牌 / 动作块贴片用） */
const silTexCache = new Map<string, THREE.Texture>();
function silhouetteTexture(action: GameAction, color: string): THREE.Texture {
  const key = `${action}|${color}`;
  let tex = silTexCache.get(key);
  if (!tex) {
    tex = new THREE.CanvasTexture(poseSilhouetteCanvas(action, color, 160));
    tex.colorSpace = THREE.SRGBColorSpace;
    silTexCache.set(key, tex);
  }
  return tex;
}

/** 踏板画布：只突出标记本身（无方块底板）——深色描边衬底 + 主题色光晕 + 白色实心符号 */
function padCanvas(action: GameAction, gold: boolean): HTMLCanvasElement {
  const W = 256; const H = 320;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  if (!g) return c;
  const accent = gold ? '#ffd60a' : ACTION_COLOR[action];
  // 深色描边衬底（略大一圈，保证浅色背景上也可辨）
  drawPoseGlyph(g, action, 'rgba(16,8,26,0.92)', W / 2, H / 2, W * 0.9);
  // 白色实心符号 + 主题色光晕（迎面提亮、放大）
  g.save();
  g.shadowColor = accent;
  g.shadowBlur = 24;
  drawPoseGlyph(g, action, gold ? '#fff6cf' : '#ffffff', W / 2, H / 2, W * 0.82);
  g.restore();
  return c;
}

/** 街舞打点踏板 GL 纹理缓存（动作块贴片用） */
const padTexCache = new Map<string, THREE.Texture>();
function padTexture(action: GameAction, gold: boolean): THREE.Texture {
  const key = `${action}|${gold ? 'g' : 'n'}`;
  let tex = padTexCache.get(key);
  if (!tex) {
    tex = new THREE.CanvasTexture(padCanvas(action, gold));
    tex.colorSpace = THREE.SRGBColorSpace;
    padTexCache.set(key, tex);
  }
  return tex;
}

// ================= 空中标记（手部动作） =================
/** 手部（上肢挥臂/出拳/侧挥）动作 → 空中悬浮标记；其余脚步（下肢）动作 → 地面踏板 */
const AIR_ACTIONS: ReadonlySet<GameAction> = new Set<GameAction>(['punch', 'left', 'right']);
const isAirAction = (a: GameAction): boolean => AIR_ACTIONS.has(a);
/** 空中标记高度（手部/出拳高度，明显高于路面、可出拳击中） */
const AIR_Y = 1.8;

/** 空中标记画布：只突出标记本身（无方块底板）——深色描边衬底 + 主题色光晕 + 白色实心符号，面向镜头 */
function airCanvas(action: GameAction, gold: boolean): HTMLCanvasElement {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  if (!g) return c;
  const accent = gold ? '#ffd60a' : ACTION_COLOR[action];
  // 深色描边衬底（略大一圈，保证亮背景上也可辨）
  drawPoseGlyph(g, action, 'rgba(16,8,26,0.92)', S / 2, S / 2, S * 0.9);
  // 白色实心符号 + 主题色光晕（迎面提亮、放大）
  g.save();
  g.shadowColor = accent;
  g.shadowBlur = 24;
  drawPoseGlyph(g, action, gold ? '#fff6cf' : '#ffffff', S / 2, S / 2, S * 0.82);
  g.restore();
  return c;
}

/** 空中标记 GL 纹理缓存 */
const airTexCache = new Map<string, THREE.Texture>();
function airTexture(action: GameAction, gold: boolean): THREE.Texture {
  const key = `${action}|${gold ? 'g' : 'n'}`;
  let tex = airTexCache.get(key);
  if (!tex) {
    tex = new THREE.CanvasTexture(airCanvas(action, gold));
    tex.colorSpace = THREE.SRGBColorSpace;
    airTexCache.set(key, tex);
  }
  return tex;
}

/** 动作块共享贴片几何（平铺路面踏板，逐块仅材质独立） */
const SIL_PLANE = new THREE.PlaneGeometry(1, 1);

const ROAD_W = 13; // 路面宽

/** 各动作块造型：拳击立方块 / 低栏（跳）/ 高板（钻）/ 踏板（踩）/ 冲刺门（穿） */
const BLOCK_STYLE: Record<GameAction, { w: number; h: number; d: number; y: number; icon: number }> = {
  punch: { w: 1.55, h: 1.55, d: 1.1, y: 1.42, icon: 1.25 },
  jump: { w: 2.8, h: 0.72, d: 0.85, y: 0.62, icon: 0.95 },
  squat: { w: 2.8, h: 1.05, d: 0.85, y: 2.1, icon: 1.05 },
  stomp: { w: 2.8, h: 0.42, d: 1.15, y: 0.42, icon: 0.9 },
  run: { w: 3.4, h: 1.75, d: 0.65, y: 1.15, icon: 1.15 },
  left: { w: 1.7, h: 1.7, d: 1.0, y: 1.35, icon: 1.2 },
  right: { w: 1.7, h: 1.7, d: 1.0, y: 1.35, icon: 1.2 },
};

/** 墙来墙板造型（大墙板 + 姿势纹理，纹理自带口令故 icon=0） */
const WALL_STYLE = { w: 10.8, h: 6.4, d: 0.6, y: 3.2, icon: 0 };

/** 碎裂碎片共享几何 */
const DEBRIS_GEO = new THREE.BoxGeometry(0.32, 0.32, 0.32);
interface Debris {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  rot: THREE.Vector3;
  life: number;
}

/** 教练视口背后的径向暗色 scrim（叠在主场景像素上，提升剪影对比度） */
function scrimTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(128, 132, 16, 128, 132, 128);
  grad.addColorStop(0, 'rgba(10,5,24,0.66)');
  grad.addColorStop(0.62, 'rgba(10,5,24,0.42)');
  grad.addColorStop(1, 'rgba(10,5,24,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

/**
 * 3D 大屏舞台版游戏主类（动作块卡点版）。
 * 主场景 = 红网格山脉 + 青色日盘 + 公路：拍点以动作块（拳击块/跳栏/钻板/踏板/冲刺门）
 * 飞向玩家，命中瞬间碎裂炸开；车道向中心漏斗汇聚增强"朝我飞"感，镜头随横移轻微转向。
 * 人物是"动作教练"，渲染在左下角独立视口，提前 1 秒演示下一动作。
 * 判定以"动作完成时刻"对齐拍点，audio 时钟唯一时钟源。
 */
export class Game {
  /** 识别延迟补偿（秒）：识别链路系统性偏晚时，判定时刻提前该值 */
  calibSec = 0;

  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private scene3 = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private raf = 0;

  // 教练（左下角演示）
  private coachScene = new THREE.Scene();
  private coachCamera: THREE.PerspectiveCamera;
  private mixer: THREE.AnimationMixer | null = null;
  private actions: Partial<Record<string, THREE.AnimationAction>> = {};
  private current: THREE.AnimationAction | null = null;
  /** 判定反馈（夸奖/鼓励）播到该时刻后恢复演示 */
  private reactUntil = 0;
  private stumbleUntil = 0; // miss 踉跄晃动到时

  private bricks: Brick[] = [];
  private debris: Debris[] = [];
  private bannerShown = new Set<number>();
  private demoShown = new Set<number>();
  private demoAction: GameAction | null = null;
  private demoUntil = 0;
  private particles: THREE.Sprite[] = [];
  private ripples: THREE.Mesh[] = [];
  private glowTex = glowTexture();

  // 判定环（动作线）
  private gateFlash = 0;
  private gateStrip!: THREE.MeshBasicMaterial;
  private gatePostMats: THREE.MeshStandardMaterial[] = [];

  private stats: GameStats = emptyStats();
  private jumpY = 0;
  private jumpVy = 0;
  private shake = 0;
  /** 顿帧（hit-stop）：命中瞬间冻结视觉 30~90ms，打击感核心 */
  private hitStop = 0;
  /** 视觉时钟：顿帧期间冻结，顿后 1.3× 追帧（判定时钟 songT 照走） */
  private visT = 0;
  /** 镜头冲击：命中 FOV 脉冲 */
  private fovKick = 0;
  private fovBase = 56;
  /** 速度线（赛道两侧流光） */
  private speedLines: THREE.Mesh[] = [];
  private speedLineMat: THREE.MeshBasicMaterial | null = null; // 速度线共享材质（冲刺强度调色用）
  private rush = 0; // 冲刺强度 0..1（连击倍率平滑驱动）
  private flash = 0;
  private state: 'idle' | 'countdown' | 'playing' | 'celebrate' | 'done' = 'idle';
  private t0 = 0;
  private endTime = 0;
  private runwayTex: THREE.CanvasTexture;
  private lowPerf = false;
  /** 镜头随玩家横移的转向/倾斜（-1..1） */
  private steer = 0;
  private steerTarget = 0;
  /** 相机机位（随屏幕宽高比自适应：窄屏/竖屏后撤抬高保车道完整） */
  private camY = 2.9;
  private camZ = -7.6;
  /** 机位模式：first = LV1 跑酷第一人称 / third = 经典第三人称 */
  private cameraMode: 'first' | 'third';
  /** 砖块形态：block 经典 / wall 墙来墙板 / glass 玻璃桥 */
  private brickStyle: 'block' | 'wall' | 'glass';
  /** 分屏对战：右半屏 = 对手舞台（同一世界按时钟平移镜像） */
  private split: boolean;
  /** 对手舞台时钟（秒）：sync 每秒上报后按墙钟推进插值 */
  private oppT = 0;
  private oppWallAt = 0;
  private bloomPass: UnrealBloomPass | null = null;
  /** BPM 呼吸：环境随拍脉动（日辉/尘埃/辉光） */
  private sunGlowSprite: THREE.Sprite | null = null;
  private dustMat: THREE.PointsMaterial | null = null;
  /** 判定辉光脉冲（perfect 瞬间 kick，随帧衰减并入 bloom 强度） */
  private bloomKick = 0;
  // 自适应画质（连续低帧 → 降载）
  private degraded = false;
  private fpsAcc = 0;
  private fpsN = 0;
  private lowFpsWindows = 0;
  // 关卡倒计时 / 红绿灯
  private timerAcc = 0;
  private lastPhase: 'go' | 'stop' | null = null;

  // 主题装扮
  private look: GameLook;
  private pal: WorldPalette;
  private skinCfg: SkinConfig;
  /** 自定义人物（2D 纸片人领操员） */
  private avatar: THREE.Mesh | null = null;
  private avatarT = 0;
  private coachModel: THREE.Object3D | null = null; // 3D 教练（踉跄位移用）

  constructor(
    private canvas: HTMLCanvasElement,
    private chart: Chart,
    private audio: BeatAudio,
    private scene: SceneMode,
    private hooks: GameHooks,
    look?: GameLook,
    opts?: GameOpts,
  ) {
    this.cameraMode = opts?.cameraMode ?? 'third';
    this.brickStyle = opts?.brickStyle ?? 'block';
    this.split = opts?.split ?? false;
    this.look = look ?? { theme: 'neon', skin: 'mage' };
    this.pal = this.look.theme === 'custom' && this.look.bgPalette
      ? this.look.bgPalette
      : THEME_PALETTE[this.look.theme === 'custom' ? 'neon' : this.look.theme];
    this.skinCfg = this.look.skin === 'custom' ? SKIN_CONFIG.mage : SKIN_CONFIG[this.look.skin];
    this.lowPerf = document.body.dataset.lowperf === '1';
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !this.lowPerf, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.lowPerf ? 1 : 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;

    const first = this.cameraMode === 'first';
    this.camera = new THREE.PerspectiveCamera(first ? 62 : 56, 16 / 9, 0.1, 380);
    this.camY = first ? 1.35 : 2.9;
    this.camZ = first ? -5.2 : -7.6;
    this.camera.position.set(0, this.camY, this.camZ);
    this.camera.lookAt(0, first ? 1.15 : 1.35, 9);

    this.coachCamera = new THREE.PerspectiveCamera(40, 0.77, 0.1, 40);
    this.coachCamera.position.set(0, 1.25, 4.1);
    this.coachCamera.lookAt(0, 1.05, 0);

    this.scene3.fog = new THREE.Fog(this.pal.fog, 110, 560);
    // 天空：主题渐变兜底；自定义背景图异步就绪后替换
    this.scene3.background = duskSkyTexture(this.pal.skyStops, this.pal.starCss);
    if (this.look.bgImage) {
      new THREE.TextureLoader().load(this.look.bgImage, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        this.scene3.background = tex;
      });
    }

    this.runwayTex = roadTexture();
    this.buildWorld();
    this.buildCoachStage();

    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene3, this.camera));
    if (!this.lowPerf) {
      const bloom = new UnrealBloomPass(size, 0.42, 0.42, 0.38);
      this.composer.addPass(bloom);
      this.bloomPass = bloom;
    }
    this.composer.addPass(new OutputPass());

    this.resize();
    void this.loadCoach();
  }

  // ================= 主场景搭建（大屏舞台风，配色随主题装扮） =================
  private buildWorld(): void {
    const pal = this.pal;
    // 灯光：主光 + 左右轮廓光（主题着色）
    this.scene3.add(new THREE.HemisphereLight(pal.hemiSky, pal.hemiGround, 0.5));
    const key = new THREE.DirectionalLight(0xfff0dd, 0.85);
    key.position.set(4, 9, -6);
    this.scene3.add(key);
    const rimL = new THREE.DirectionalLight(pal.rimL, 1.0);
    rimL.position.set(-8, 4, 10);
    this.scene3.add(rimL);
    const rimR = new THREE.DirectionalLight(pal.rimR, 0.9);
    rimR.position.set(8, 3, 12);
    this.scene3.add(rimR);

    // 巨型日盘（地平线焦点，路面消失点方向）
    // 相机朝 +Z 看的是日盘 -Z 背面，须 DoubleSide 否则背面剔除致日盘不可见
    const sun = new THREE.Mesh(
      new THREE.CircleGeometry(72, 48),
      new THREE.MeshBasicMaterial({ color: pal.sun, toneMapped: false, fog: false, side: THREE.DoubleSide }),
    );
    sun.position.set(0, 17, 285);
    this.scene3.add(sun);
    const sunGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glowTex,
        color: pal.sunGlow,
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      }),
    );
    sunGlow.position.set(0, 17, 283);
    sunGlow.scale.setScalar(150);
    this.scene3.add(sunGlow);
    this.sunGlowSprite = sunGlow;

    // 网格地形（发光网格线，主题着色）
    const gridTex = gridTerrainTexture(pal.terrainBase, pal.terrainGrid, pal.terrainGrid);
    const terrain = new THREE.Mesh(
      new THREE.PlaneGeometry(420, 430),
      new THREE.MeshStandardMaterial({
        map: gridTex,
        emissive: pal.terrainEmissive,
        emissiveMap: gridTex,
        emissiveIntensity: 0.5,
        roughness: 0.92,
        metalness: 0.05,
      }),
    );
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.set(0, -0.08, 100);
    this.scene3.add(terrain);

    // 低多边形山脉 + 发光网格线框（两侧山脊，主题着色）
    const mtnCount = this.lowPerf ? 8 : 14;
    for (const side of [-1, 1]) {
      for (let i = 0; i < mtnCount; i++) {
        const h = 8 + Math.random() * 20;
        const r = 5 + Math.random() * 10;
        const geo = new THREE.ConeGeometry(r, h, 4);
        const mtn = new THREE.Mesh(
          geo,
          new THREE.MeshStandardMaterial({
            color: pal.mtn,
            emissive: pal.mtnEmissive,
            emissiveIntensity: 0.55,
            roughness: 0.88,
            flatShading: true,
          }),
        );
        const x = side * (20 + Math.random() * 58);
        const z = 12 + i * (200 / mtnCount) + Math.random() * 6;
        mtn.position.set(x, h / 2 - 0.2, z);
        mtn.rotation.y = Math.random() * Math.PI;
        this.scene3.add(mtn);
        if (!this.lowPerf) {
          const wire = new THREE.Mesh(
            geo,
            new THREE.MeshBasicMaterial({
              color: pal.wire,
              wireframe: true,
              transparent: true,
              opacity: 0.45,
            }),
          );
          wire.position.copy(mtn.position);
          wire.rotation.copy(mtn.rotation);
          wire.scale.setScalar(1.003);
          this.scene3.add(wire);
        }
      }
    }

    // 路面（深色公路 + 暖色边线，滚动）
    const runway = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_W, 260),
      new THREE.MeshStandardMaterial({
        map: this.runwayTex,
        roughness: 0.72,
        metalness: 0.18,
        emissive: 0x1c0c08,
        emissiveIntensity: 0.3,
      }),
    );
    runway.rotation.x = -Math.PI / 2;
    runway.position.set(0, 0, 100);
    this.scene3.add(runway);

    // 3 跑道导轨（极细发光线，跑道定位用）
    for (const x of LANE3_X) {
      const rail = new THREE.Mesh(
        new THREE.PlaneGeometry(0.05, 220),
        new THREE.MeshBasicMaterial({
          color: 0xffd9b0,
          transparent: true,
          opacity: 0.12,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      rail.rotation.x = -Math.PI / 2;
      rail.position.set(x, 0.035, 100);
      this.scene3.add(rail);
    }

    this.buildGate();

    // 拱门装饰（贴在路面上的门框，向镜头滚动，主题着色）
    const archGeo = new THREE.TorusGeometry(7.1, 0.32, 8, 48, Math.PI);
    for (let i = 0; i < 5; i++) {
      const arch = new THREE.Mesh(
        archGeo,
        new THREE.MeshStandardMaterial({
          color: pal.arch,
          emissive: pal.archEmissive,
          emissiveIntensity: 0.85,
          roughness: 0.75,
        }),
      );
      arch.position.set(0, 0.1, 18 + i * 34);
      arch.userData.baseZ = arch.position.z;
      this.scene3.add(arch);
    }

    // 悬浮光点（主题着色）
    const dustGeo = new THREE.BufferGeometry();
    const N = this.lowPerf ? 110 : 200;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 42;
      pos[i * 3 + 1] = Math.random() * 15;
      pos[i * 3 + 2] = Math.random() * 160;
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const dust = new THREE.Points(
      dustGeo,
      new THREE.PointsMaterial({
        map: this.glowTex,
        size: 0.42,
        transparent: true,
        opacity: 0.42,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        color: pal.dust,
      }),
    );
    this.scene3.add(dust);
    this.dustMat = dust.material as THREE.PointsMaterial;

    // 静态网格冻结矩阵（滚动拱门除外），省每帧矩阵重算
    this.scene3.traverse((o) => {
      if (o.userData.baseZ !== undefined) return;
      const obj = o as THREE.Mesh;
      if (obj.isMesh || (o as THREE.Sprite).isSprite || (o as THREE.Points).isPoints) {
        o.matrixAutoUpdate = false;
        o.updateMatrix();
      }
    });

    // 速度线（赛道两侧流光，强化冲刺感）：需逐帧移动，矩阵不冻结
    const lineGeo = new THREE.BoxGeometry(0.055, 0.055, 2.8);
    const lineMat = new THREE.MeshBasicMaterial({
      color: 0x9fd8ff,
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.speedLineMat = lineMat;
    const nLines = this.lowPerf ? 8 : 18;
    for (let i = 0; i < nLines; i++) {
      const m = new THREE.Mesh(lineGeo, lineMat);
      const side = i % 2 ? 1 : -1;
      m.position.set(side * (4.9 + Math.random() * 2.6), 0.3 + Math.random() * 3.4, Math.random() * 186);
      this.scene3.add(m);
      this.speedLines.push(m);
    }
  }

  /** 判定线（动作线）：琴键行触线瞬间做动作 */
  private buildGate(): void {
    // 横贯路面的暖白光带
    this.gateStrip = new THREE.MeshBasicMaterial({
      color: 0xffe6c8,
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_W + 0.4, 1.0), this.gateStrip);
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(0, 0.045, RING_Z);
    this.scene3.add(strip);

    // 两侧矮光柱
    const postGeo = new THREE.BoxGeometry(0.22, 1.7, 0.22);
    for (const side of [-1, 1]) {
      const mat = neonMaterial(0xff9a5a, 0.85);
      this.gatePostMats.push(mat);
      const post = new THREE.Mesh(postGeo, mat);
      post.position.set(side * (ROAD_W / 2 + 0.5), 0.85, RING_Z);
      this.scene3.add(post);
    }

    // 3 跑道菱形标记（贴地，跑道定位）
    for (const x of LANE3_X) {
      const mark = new THREE.Mesh(
        new THREE.CircleGeometry(0.5, 4),
        new THREE.MeshBasicMaterial({
          color: 0xffd9b0,
          transparent: true,
          opacity: 0.28,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      mark.rotation.x = -Math.PI / 2;
      mark.rotation.z = Math.PI / 4;
      mark.position.set(x, 0.05, RING_Z);
      this.scene3.add(mark);
    }
  }

  // ================= 教练舞台（左下角视口） =================
  private buildCoachStage(): void {
    this.coachScene.background = null;
    this.coachScene.add(new THREE.HemisphereLight(0xb08cff, 0x2a1548, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(2, 4, -3);
    this.coachScene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.55);
    fill.position.set(-2, 2, 4);
    this.coachScene.add(fill);
    const rim = new THREE.DirectionalLight(this.skinCfg.rim1, 0.7);
    rim.position.set(-3, 2, 3);
    this.coachScene.add(rim);
    const rim2 = new THREE.DirectionalLight(this.skinCfg.rim2, 0.5);
    rim2.position.set(3, 1, 3);
    this.coachScene.add(rim2);

    // scrim：叠在主场景像素上的径向暗色渐变（透明边缘，无缝融合）
    const scrim = new THREE.Mesh(
      new THREE.PlaneGeometry(7, 7),
      new THREE.MeshBasicMaterial({
        map: scrimTexture(),
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    scrim.position.set(0, 1.1, -2.2);
    this.coachScene.add(scrim);

    // 脚下光晕"演示台"（皮肤着色）
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(1.5, 40),
      new THREE.MeshBasicMaterial({
        map: this.glowTex,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        color: this.skinCfg.disc,
      }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.02;
    this.coachScene.add(disc);
  }

  private async loadCoach(): Promise<void> {
    // 自定义人物：2D 纸片人领操员（跳过 3D 模型）
    if (this.look.coachImage) {
      this.buildAvatar(this.look.coachImage);
      return;
    }
    try {
      const loader = new GLTFLoader();
      const url = new URL('models/coach.glb', document.baseURI).href;
      const gltf = await loader.loadAsync(url);
      const model = gltf.scene;

      // 卸下武器/道具（教练空手示范）：KayKit 角色自带装备网格
      model.traverse((o) => {
        if (/spellbook|wand|staff/i.test(o.name)) o.visible = false;
      });

      // 骨骼查找：精确名优先（避免误抓 IK 骨/同名网格）
      const norm = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, '');
      const findBone = (key: string): THREE.Object3D | undefined => {
        let exact: THREE.Object3D | undefined;
        let loose: THREE.Object3D | undefined;
        model.traverse((o) => {
          if (o.type !== 'Bone') return;
          const n = norm(o.name);
          if (n === key) exact ??= o;
          else if (!loose && n.includes(key)) loose ??= o;
        });
        return exact ?? loose;
      };

      // 动画映射：游戏逻辑名 → 模型内嵌剪辑名（KayKit 自包含 76 clips，无需重定向）
      const CLIP: Record<string, string> = {
        idle: 'Idle',
        run: 'Running_A',
        walk: 'Walking_A',
        squat: 'PickUp',
        punch: 'Unarmed_Melee_Attack_Punch_A',
        jump: 'Jump_Full_Short',
        cheer: 'Cheer',
        hit: 'Hit_A',
      };
      this.mixer = new THREE.AnimationMixer(model);
      for (const [logical, clipName] of Object.entries(CLIP)) {
        const clip = gltf.animations.find((a) => a.name === clipName);
        if (clip) this.actions[logical] = this.mixer.clipAction(clip);
      }
      this.playAnim('idle', 0);

      // 归一化到 ~1.75m：SkinnedMesh 几何盒是绑定姿态（常与动画骨架不一致），
      // 必须摆姿后按骨骼世界坐标测量
      this.mixer.update(0.1);
      model.updateMatrixWorld(true);
      let minY = Infinity;
      let maxY = -Infinity;
      const tmp = new THREE.Vector3();
      const probes: Array<[string, number]> = [
        ['head', 0.24], ['footl', -0.09], ['footr', -0.09],
        ['handl', 0], ['handr', 0], ['hips', 0],
      ];
      for (const [key, pad] of probes) {
        const o = findBone(key);
        if (!o) continue;
        o.getWorldPosition(tmp);
        minY = Math.min(minY, tmp.y + pad);
        maxY = Math.max(maxY, tmp.y + pad);
      }
      if (!Number.isFinite(minY) || maxY - minY < 0.5) {
        // 兜底：几何包围盒
        const bbox = new THREE.Box3().setFromObject(model);
        minY = bbox.min.y;
        maxY = bbox.max.y;
      }
      // 角色帽子/头饰很高（巫师帽顶远高于头骨），按整体视觉高度（含头饰）归一化，
      // 否则按身体高度缩放会把帽顶推出画面
      const visBox = new THREE.Box3().setFromObject(model);
      const visTop = Math.max(maxY, visBox.max.y);
      const s = 2.15 / Math.max(visTop - minY, 0.001);
      model.scale.setScalar(s);
      model.position.y = -minY * s;

      // 皮肤染色：克隆材质乘色（保留原生卡通渐变图集，白 = 原色）
      const tint = new THREE.Color(this.skinCfg.tint);
      if (this.skinCfg.tint !== 0xffffff) {
        model.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const apply = (m: THREE.Material): THREE.Material => {
            const mc = m.clone();
            const colored = mc as THREE.MeshStandardMaterial;
            if (colored.color) colored.color.multiply(tint);
            return mc;
          };
          mesh.material = Array.isArray(mesh.material)
            ? mesh.material.map(apply)
            : apply(mesh.material);
        });
      }

      this.coachModel = model;
      this.coachScene.add(model);
    } catch {
      // 模型加载失败：教练缺席但游戏照常
    }
  }

  /** 自定义人物：图片平面领操员（待机浮动 / 示范脉冲 / 判定反馈摇摆） */
  private buildAvatar(dataUrl: string): void {
    new THREE.TextureLoader().load(dataUrl, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      const img = tex.image as { width: number; height: number };
      const aspect = (img?.width || 1) / (img?.height || 1);
      const maxH = 2.35;
      const maxW = 2.3;
      const h = Math.min(maxH, maxW / aspect);
      const w = h * aspect;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }),
      );
      mesh.position.set(0, h / 2 + 0.1, 0);
      mesh.userData.baseY = h / 2 + 0.1;
      this.avatar = mesh;
      this.coachScene.add(mesh);
    });
  }

  /** 纸片人动画（每帧）：待机浮动 + 示范脉冲 + 判定反馈弹跳 */
  private updateAvatar(dt: number): void {
    const av = this.avatar;
    if (!av) return;
    this.avatarT += dt;
    const t = this.avatarT;
    const songT = this.audio.now - this.t0;
    const demoing = this.demoAction !== null && this.demoUntil > songT;
    const reacting = this.reactUntil > songT;
    const baseY = (av.userData.baseY as number) ?? 1.2;
    // 节拍弹跳（bop）：每拍下沉回弹，让领操员跟着节奏律动
    const beat = songT * (this.chart.bpm / 60);
    const bop = Math.pow(1 - (beat % 1), 3);
    av.position.y = baseY + Math.sin(t * 2.1) * 0.05 - bop * 0.085;
    av.rotation.z = Math.sin(t * 1.4) * 0.02;
    let s = 1 + bop * 0.028;
    if (demoing) {
      s = 1 + 0.055 * (0.5 + 0.5 * Math.sin(t * 7.5));
      av.rotation.z += Math.sin(t * 6) * 0.045;
    }
    if (reacting) {
      s = 1 + 0.09 * Math.max(0, Math.sin(t * 16));
      av.rotation.z += Math.sin(t * 26) * 0.06;
    }
    av.scale.setScalar(s);
  }

  private playAnim(name: string, fade = 0.18, timeScale = 1): void {
    const next = this.actions[name];
    if (!next || next === this.current) return;
    next.reset();
    next.setEffectiveTimeScale(timeScale);
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.fadeIn(fade).play();
    if (this.current) this.current.fadeOut(fade);
    this.current = next;
  }

  // ================= 生命周期 =================
  resize(): void {
    const w = this.canvas.clientWidth || 1280;
    const h = this.canvas.clientHeight || 720;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    // 分屏对战：每半屏各自持一半宽，机位按半屏比例取景
    const aspect = this.split ? (w / 2) / h : w / h;
    this.camera.aspect = aspect;
    // 窄屏/竖屏自适应：加大视场 + 后撤抬高镜头，保车道与块完整入画
    const t = Math.max(0, Math.min(1, (1.45 - aspect) / 0.95));
    const first = this.cameraMode === 'first';
    this.camera.fov = (first ? 62 : 56) + t * (first ? 22 : 24);
    this.fovBase = this.camera.fov;
    this.camZ = (first ? -5.2 : -7.6) - t * (first ? 6.5 : 8.5);
    this.camY = (first ? 1.35 : 2.9) + t * (first ? 1.5 : 1.9);
    this.camera.position.z = this.camZ;
    this.camera.position.y = this.camY;
    this.camera.updateProjectionMatrix();
  }

  get running(): boolean {
    return this.state === 'playing' || this.state === 'countdown';
  }

  async start(): Promise<void> {
    this.stats = emptyStats(this.chart.events.length);
    this.bricks = this.chart.events.map((ev) => this.spawnBrick(ev));
    this.bannerShown = new Set();
    this.demoShown = new Set();
    this.demoAction = null;
    this.lastPhase = null;
    this.timerAcc = 0;
    this.state = 'countdown';

    await this.audio.init();
    for (let n = 3; n >= 1; n--) {
      this.hooks.onCountdown(String(n));
      this.audio.beep(false);
      await delay(700);
    }
    this.hooks.onCountdown('GO!');
    this.audio.beep(true);
    this.audio.start(this.chart.bpm);
    this.t0 = this.audio.songStart;
    this.endTime = chartDuration(this.chart) + 1.2;
    this.state = 'playing';
    await delay(500);
    this.hooks.onCountdown('');
    this.clock.start();
    this.loop();
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.audio.stop();
    this.state = 'done';
    this.hooks.onCountdown('');
    this.hooks.onDemo?.(null);
    this.mixer?.stopAllAction();
  }

  /** 玩家横移信号（-1..1）：镜头随身体位置轻微转向/倾斜 */
  setSteer(v: number): void {
    this.steerTarget = Math.max(-1, Math.min(1, v));
  }

  /** 对手舞台时钟（秒）：分屏右半镜像用；sync 到达时刷新，其间按墙钟插值推进 */
  setOpponent(t: number): void {
    this.oppT = t;
    this.oppWallAt = Date.now();
  }

  /** 红灯乱动惩罚：清连击 + 震屏 + 低警示音（LV4 RED LIGHT GREEN LIGHT） */
  penalty(): void {
    if (this.state !== 'playing') return;
    this.stats.combo = 0;
    this.stats.multiplier = 1;
    this.shake = 0.65;
    this.gateFlash = 0.6;
    this.audio.beep(false);
    this.hooks.onHud({ ...this.stats });
  }

  /** 当前红绿灯窗口（无 phases 返回 null） */
  phaseAt(songT: number): 'go' | 'stop' | null {
    const phases = this.chart.phases;
    if (!phases || phases.length === 0) return null;
    const beat = ((songT - (this.chart.offsetSec ?? 0)) * this.chart.bpm) / 60;
    for (const p of phases) {
      if (beat >= p.startBeat && beat < p.startBeat + p.lenBeats) return p.kind;
    }
    return null;
  }

  /** 玩家动作（at = 识别时刻，秒）。判定按"完成时刻对齐拍点"取四档。 */
  pushAction(action: GameAction, at: number): void {
    if (this.state !== 'playing') return;
    const songT = at - this.t0 - this.calibSec;
    // 红灯窗口乱动 → 惩罚（RED LIGHT GREEN LIGHT）
    if (this.phaseAt(songT) === 'stop') {
      this.penalty();
      return;
    }
    let best: Brick | null = null;
    let bestDelta = Infinity;
    for (const br of this.bricks) {
      if (br.judged || br.ev.action !== action) continue;
      const delta = Math.abs(songT - eventTime(this.chart, br.ev));
      const win = ACTION_WINDOW[br.ev.action].good * (br.ev.window ?? 1);
      if (delta <= win && delta < bestDelta) {
        best = br;
        bestDelta = delta;
      }
    }
    if (!best) return;
    best.judged = true;

    const w = ACTION_WINDOW[best.ev.action];
    const mult = best.ev.window ?? 1;
    const quality: JudgeQuality =
      bestDelta <= w.perfect * mult ? 'perfect' : bestDelta <= w.great * mult ? 'great' : 'good';
    this.applyJudge({
      event: best.ev,
      quality,
      offset: songT - eventTime(this.chart, best.ev),
      multiplier: 1,
      gold: !!best.ev.gold,
    });
    this.shatter(best);
    this.triggerVisual(action);
  }

  // ================= 动作块 =================
  private spawnBrick(ev: ChartEvent): Brick {
    const group = new THREE.Group();
    const gold = !!ev.gold;
    const colorHex = gold ? 0xffd60a : new THREE.Color(ACTION_COLOR[ev.action]).getHex();
    const style = this.brickStyle === 'wall' ? WALL_STYLE : BLOCK_STYLE[ev.action];
    const scale = gold ? 1.12 : 1;

    // 块体三种形态：
    // block = ★ 平面姿势剪影贴片（动作块本身就是姿势形状，对齐参考视频）
    // wall = 墙来白墙板（姿势洞口纹理）；glass = 玻璃桥半透明板 + 剪影面牌
    let bodyMat: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
    if (this.brickStyle === 'wall') {
      bodyMat = new THREE.MeshStandardMaterial({
        map: wallPanelTexture(ev.action),
        transparent: true,
        roughness: 0.82,
        metalness: 0.06,
        emissive: gold ? 0x2b2200 : 0x0d0716,
        emissiveIntensity: 0.4,
      });
      const body = new THREE.Mesh(
        new RoundedBoxGeometry(style.w * scale, style.h * scale, style.d * scale, 3, 0.14),
        bodyMat,
      );
      group.add(body);
    } else if (this.brickStyle === 'glass') {
      bodyMat = neonMaterial(colorHex, gold ? 1.15 : 0.72);
      bodyMat.transparent = true;
      bodyMat.opacity = 0.42;
      const body = new THREE.Mesh(
        new RoundedBoxGeometry(style.w * scale, style.h * scale, style.d * scale, 3, 0.14),
        bodyMat,
      );
      group.add(body);
      // 剪影面牌（侧身姿势，标示该走哪边）
      const icon = new THREE.Mesh(
        new THREE.PlaneGeometry(style.icon * scale, style.icon * scale),
        new THREE.MeshBasicMaterial({
          map: silhouetteTexture(ev.action, gold ? '#ffd60a' : ACTION_COLOR[ev.action]),
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      icon.position.z = -style.d * scale * 0.5 - 0.02;
      icon.rotation.y = Math.PI;
      group.add(icon);
    } else if (isAirAction(ev.action)) {
      // ★ 手部动作 = 空中悬浮标记（深色实心徽章，手高度，面向镜头，可出拳击中）
      const airMat = new THREE.MeshBasicMaterial({
        map: airTexture(ev.action, gold),
        transparent: true,
        opacity: 1,
        depthWrite: false,
        toneMapped: false,
      });
      bodyMat = airMat;
      const mark = new THREE.Mesh(SIL_PLANE, airMat);
      mark.scale.set(1.95 * scale, 1.95 * scale, 1);
      // 左右分侧抬高（idea 5）：手部左右标记升到左上/右上，鼓励左右开弓
      mark.position.y = AIR_Y + (ev.action === 'left' || ev.action === 'right' ? 0.5 : 0);
      mark.rotation.y = Math.PI; // 面向镜头（相机看 -Z 面）
      group.add(mark);
    } else {
      // ★ 脚步动作 = 地面平铺踏板（深色实心圆角板 + 白色填充符号，铺向地平线）
      const padMat = new THREE.MeshBasicMaterial({
        map: padTexture(ev.action, gold),
        transparent: true,
        opacity: 1,
        depthWrite: false,
        toneMapped: false,
      });
      bodyMat = padMat;
      const pad = new THREE.Mesh(SIL_PLANE, padMat);
      pad.scale.set(2.3 * scale, 2.85 * scale, 1);
      pad.position.y = 0.06;
      pad.rotation.x = -Math.PI / 2; // 平铺路面，随车道滑来
      group.add(pad);
    }

    // 预判光柱（idea 6）：块位细光柱提前提示出招位置，近判定线渐隐（仅 block 形态）
    let pillar: THREE.MeshBasicMaterial | null = null;
    if (this.brickStyle === 'block') {
      pillar = new THREE.MeshBasicMaterial({
        map: this.glowTex,
        color: gold ? 0xffd60a : colorHex,
        transparent: true,
        opacity: 0.4,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const beam = new THREE.Mesh(SIL_PLANE, pillar);
      beam.scale.set(0.72, 3.6, 1);
      beam.position.y = isAirAction(ev.action) ? AIR_Y : 1.7;
      beam.rotation.y = Math.PI;
      group.add(beam);
    }

    // 金块：星标 + 点光（普通块只靠自发光+bloom，保性能）
    let glow: THREE.PointLight | null = null;
    if (gold) {
      const star = new THREE.Mesh(
        new THREE.PlaneGeometry(0.58, 0.58),
        new THREE.MeshBasicMaterial({
          map: iconTexture('⭐', 'rgba(255,214,10,0.95)'),
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      // 空中标记：星标悬浮徽章旁；地面踏板：悬浮板上方；玻璃/墙板：贴板角
      const isBlock = this.brickStyle === 'block';
      const air = isBlock && isAirAction(ev.action);
      const starX = isBlock ? (air ? 1.15 : 0.8) : style.w * scale * 0.52;
      const starY = isBlock ? (air ? AIR_Y + 1.0 : 0.95) : style.h * scale * 0.55;
      const starZ = isBlock ? -0.2 : -style.d * scale * 0.5 - 0.03;
      star.position.set(starX, starY, starZ);
      star.rotation.y = Math.PI;
      group.add(star);
      glow = new THREE.PointLight(0xffd60a, 3.2, 8, 1.8);
      glow.position.y = 0.3;
      group.add(glow);
    }

    // 3 跑道：事件分配到哪条道，块就渲染在哪条道（左右移由谱面固定到左右道）
    const baseX = this.brickStyle === 'wall' ? 0 : laneXOf(ev.lane);
    // 踏板贴路面（yBase=0，片内抬 0.06）；玻璃/墙板用造型高度
    const yBase = this.brickStyle === 'block' ? 0 : style.y;
    group.position.set(baseX, yBase, 120);
    this.scene3.add(group);
    return {
      ev, judged: false, hit: false, group, glow,
      spin: gold ? 0.8 : 0, baseX, color: colorHex, bodyMat, pillar,
    };
  }

  /** 命中碎裂：块体炸成碎片 + 粒子迸发 */
  private shatter(br: Brick): void {
    br.group.visible = false;
    // 踏板/空中标记无漏斗：原点在车道本位；空中标记在手高度，地面踏板贴近路面
    const isBlock = this.brickStyle === 'block';
    const air = isBlock && isAirAction(br.ev.action);
    const oX = isBlock ? br.baseX : br.baseX * 0.22;
    const oY = air ? AIR_Y : isBlock ? 0.55 : 1.2;
    const origin = new THREE.Vector3(oX, oY, RING_Z);
    // 击中特效分部位（idea 1）：脚→地面冲击波环；手→空中星爆环
    this.spawnHitRing(br.ev.gold ? 0xffd60a : br.color, oX, air ? AIR_Y : 0.08, air);
    // 连击电火花（idea 3）：COMBO 拉满追加电光碎片
    const hot = this.stats.combo >= 10;
    const total = 10 + (hot ? 6 : 0);
    for (let i = 0; i < total; i++) {
      const electric = hot && i >= 10;
      const mat = new THREE.MeshBasicMaterial({ color: electric ? 0x66e0ff : br.color, transparent: true });
      const m = new THREE.Mesh(DEBRIS_GEO, mat);
      m.position.copy(origin).add(new THREE.Vector3(
        (Math.random() - 0.5) * 1.6,
        (Math.random() - 0.2) * 1.4,
        (Math.random() - 0.5) * 1.2,
      ));
      m.userData.life = 1;
      this.scene3.add(m);
      this.debris.push({
        mesh: m,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 9,
          Math.random() * 6.5 + 2,
          -Math.random() * 5 - 1,
        ),
        rot: new THREE.Vector3(
          (Math.random() - 0.5) * 12,
          (Math.random() - 0.5) * 12,
          (Math.random() - 0.5) * 12,
        ),
        life: 1,
      });
    }
    this.burst(br.ev.gold ? 0xffd60a : br.color, oX, air ? AIR_Y : isBlock ? 0.6 : 1.3, RING_Z);
    if (hot) this.burst(0x66e0ff, oX, air ? AIR_Y : 0.6, RING_Z); // 连击电光迸发
  }

  // ================= 判定与特效 =================
  private applyJudge(r: JudgeResult): void {
    const gold = r.gold;
    if (r.quality === 'miss') {
      this.stats.combo = 0;
      this.stats.multiplier = 1;
      this.stats.misses++;
      if (this.scene !== 'class') {
        this.shake = 0.5;
      }
    } else {
      this.stats.hits++;
      this.stats.combo++;
      this.stats.maxCombo = Math.max(this.stats.maxCombo, this.stats.combo);
      const mult = comboMultiplier(this.stats.combo);
      this.stats.multiplier = mult;
      const base = r.quality === 'perfect' ? 100 : r.quality === 'great' ? 70 : 40;
      this.stats.score += base * mult * (gold ? 2 : 1);
      if (r.quality === 'perfect') this.stats.perfects++;
      else if (r.quality === 'great') this.stats.greats++;
      else this.stats.goods++;
      if (gold) {
        this.stats.golds++;
        this.audio.goldHit();
      } else {
        this.audio.hit(r.quality);
      }
      this.flash = r.quality === 'perfect' ? 0.5 : r.quality === 'great' ? 0.34 : 0.22;
      if (r.quality === 'perfect') this.bloomKick = gold ? 1.15 : 1;
      this.burst(r.quality === 'perfect' ? 0xffd60a : r.quality === 'great' ? 0x66d9ff : 0x9fd8ff);
      // 顿帧 + 镜头冲击（打击感核心）：金砖加长
      this.hitStop = Math.max(
        this.hitStop,
        (r.quality === 'perfect' ? 0.07 : r.quality === 'great' ? 0.05 : 0.032) + (gold ? 0.02 : 0),
      );
      if (r.quality !== 'good') {
        this.fovKick = Math.max(this.fovKick, r.quality === 'perfect' ? 1 : 0.55);
      }
      // 连击里程碑（每 10 连击爆发一次；50/100 连击分级加码）
      if (this.stats.combo % 10 === 0) {
        const tier = this.stats.combo >= 100 ? 2 : this.stats.combo >= 50 ? 1 : 0;
        this.hooks.onMilestone?.(this.stats.combo);
        this.spawnHitRing(0xffd60a, 0, 1.3, true);
        this.burst(0xffd60a, 0, 1.9, RING_Z);
        if (tier > 0) this.burst(0xff9f0a, 0, 2.3, RING_Z);
        if (tier > 1) this.burst(0xff375f, 0, 2.7, RING_Z);
        this.shake = Math.max(this.shake, 0.32 + tier * 0.16);
        this.fovKick = Math.max(this.fovKick, 0.9 + tier * 0.3);
      }
    }
    this.gateFlash = 1;
    this.reactCoach(r.quality);
    this.hooks.onJudge({ ...r, multiplier: this.stats.multiplier, gold });
    this.hooks.onHud({ ...this.stats });
  }

  private triggerVisual(action: GameAction): void {
    if (action === 'jump') {
      this.jumpVy = 9.2;
    } else if (action === 'punch') {
      this.shake = 0.22;
      this.spawnRipple(0xff3b30, 1.2);
    } else if (action === 'stomp') {
      this.jumpVy = 3.2;
      this.spawnRipple(0x34ffb0, 2.2);
    } else if (action === 'left' || action === 'right') {
      this.spawnRipple(0x5ac8fa, 1.8);
    } else {
      this.spawnRipple(0x22e1ff, 1.6);
    }
  }

  private burst(color: number, x = 0, y = 1.3, z = RING_Z): void {
    for (let i = 0; i < 14; i++) {
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTex,
          color,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      sp.position.set(x, y, z);
      sp.scale.setScalar(0.5 + Math.random() * 0.5);
      sp.userData.vel = new THREE.Vector3(
        (Math.random() - 0.5) * 7,
        Math.random() * 5 + 1,
        Math.random() * 4 - 2,
      );
      sp.userData.life = 1;
      this.scene3.add(sp);
      this.particles.push(sp);
    }
  }

  private spawnRipple(color: number, size: number): void {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 0.95, 40),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.06, RING_Z);
    ring.scale.setScalar(size);
    ring.userData.life = 1;
    this.scene3.add(ring);
    this.ripples.push(ring);
  }

  /** 击中特效环（idea 1）：脚→地面冲击波环；手→空中星爆环，扩张渐隐 */
  private spawnHitRing(color: number, x: number, y: number, air: boolean): void {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.9, 40),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    ring.position.set(x, y, RING_Z);
    if (air) ring.rotation.y = Math.PI; // 空中环面向镜头
    else ring.rotation.x = -Math.PI / 2; // 地面环平铺
    ring.scale.setScalar(1);
    ring.userData.life = 1;
    this.scene3.add(ring);
    this.ripples.push(ring);
  }

  // ================= 教练演示（提前 1 秒） =================
  /** 演示动作用的剪辑名映射 */
  private static readonly DEMO_ANIM: Record<GameAction, string> = {
    run: 'run',
    squat: 'squat',
    stomp: 'walk',
    punch: 'punch',
    jump: 'jump',
    left: 'walk',
    right: 'walk',
  };

  private startDemo(action: GameAction, holdUntil: number): void {
    this.demoAction = action;
    this.demoUntil = holdUntil;
    this.reactUntil = 0;
    this.hooks.onDemo?.(action);
    if (action === 'run') this.playAnim('run', 0.15, 1.4);
    else if (action === 'stomp') this.playAnim('walk', 0.15, 1.7);
    else if (action === 'punch') this.playAnim('punch', 0.12);
    else if (action === 'jump') this.playAnim('jump', 0.12, 1.15);
    else if (action === 'left' || action === 'right') this.playAnim('walk', 0.15, 1.4);
    else this.playAnim('squat', 0.15);
  }

  /** 判定反馈：夸奖欢呼 / miss 鼓励性受击，播完恢复演示（3D 模型播剪辑，纸片人弹跳） */
  private reactCoach(quality: JudgeQuality): void {
    const songT = this.audio.now - this.t0;
    if (quality === 'miss') {
      this.playAnim('hit', 0.1);
      this.reactUntil = songT + 0.55;
      this.stumbleUntil = songT + 0.55; // 踉跄：受击后左右晃动衰减
    } else {
      this.playAnim('cheer', 0.12);
      this.reactUntil = songT + (quality === 'perfect' ? 0.8 : quality === 'great' ? 0.6 : 0.5);
    }
  }

  private updateDemo(_dt: number, songT: number): void {
    // 判定反馈到时后恢复演示或待机
    if (this.reactUntil > 0 && songT > this.reactUntil) {
      this.reactUntil = 0;
      if (this.demoAction) this.playAnim(Game.DEMO_ANIM[this.demoAction], 0.2);
      else this.playAnim('run', 0.25, 0.8); // 反馈结束回原地慢跑（角色不静立）
    }

    // 找最近未判定事件，提前 1 秒开演
    let next: Brick | null = null;
    let nextT = Infinity;
    for (const br of this.bricks) {
      if (br.judged) continue;
      const t = eventTime(this.chart, br.ev);
      if (t < nextT) {
        nextT = t;
        next = br;
      }
    }
    if (next && nextT - songT <= DEMO_LEAD && !this.demoShown.has(next.ev.beat)) {
      this.demoShown.add(next.ev.beat);
      const hold = next.ev.action === 'run' ? 1.0 : 0.45;
      this.startDemo(next.ev.action, nextT + hold);
    }
    if (this.demoAction && songT > this.demoUntil) {
      this.demoAction = null;
      if (this.reactUntil <= 0) this.playAnim('run', 0.25, 0.8);
      this.hooks.onDemo?.(null);
    }

    // 常态跑步循环兜底：无演示/无反馈时维持原地慢跑，角色一直活着
    if (!this.demoAction && this.reactUntil <= 0 && songT > 0.8
      && this.actions.run && this.current !== this.actions.run) {
      this.playAnim('run', 0.3, 0.8);
    }
  }

  // ================= 主循环 =================
  private loop = (): void => {
    if (this.state !== 'playing' && this.state !== 'celebrate') return;
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const songT = this.audio.now - this.t0;
    // 冲线庆祝：只跑动画与渲染 1.15s（教练欢呼被看到），跳过判定/统计
    if (this.state === 'celebrate') {
      this.mixer?.update(dt);
      this.composer.render();
      this.renderCoach(dt);
      if (songT <= this.endTime + 1.15) this.raf = requestAnimationFrame(this.loop);
      return;
    }
    // 顿帧（hit-stop）：命中瞬间冻结视觉，判定时钟照走；帧后 1.3× 追帧
    if (this.hitStop > 0) {
      this.hitStop -= dt;
    } else {
      this.visT = Math.min(songT, this.visT + dt * 1.3);
    }
    const vdt = this.hitStop > 0 ? 0 : dt;

    // 判定过期（宽窗内未完成动作 → MISS）+ 口令横幅
    for (const br of this.bricks) {
      if (br.judged) continue;
      const t = eventTime(this.chart, br.ev);
      const win = ACTION_WINDOW[br.ev.action].good * (br.ev.window ?? 1);
      if (songT > t - 0.7 && !this.bannerShown.has(br.ev.beat)) {
        this.bannerShown.add(br.ev.beat);
        this.hooks.onBanner(ACTION_LABEL[br.ev.action], ACTION_COLOR[br.ev.action], br.ev.action);
      }
      if (songT > t + win) {
        br.judged = true;
        this.applyJudge({
          event: br.ev, quality: 'miss', offset: songT - t, multiplier: 1, gold: !!br.ev.gold,
        });
      }
    }

    // 教练提前演示
    this.updateDemo(dt, songT);

    // 底部 pictogram 时间轴：上报未来 6 秒的动作
    if (this.hooks.onTimeline) {
      const items: Array<{ beat: number; action: GameAction; inSecs: number; gold: boolean }> = [];
      for (const br of this.bricks) {
        if (br.judged) continue;
        const inSecs = eventTime(this.chart, br.ev) - songT;
        if (inSecs <= 6 && inSecs > -0.35) {
          items.push({ beat: br.ev.beat, action: br.ev.action, inSecs, gold: !!br.ev.gold });
        }
      }
      items.sort((a, b) => a.inSecs - b.inSecs);
      this.hooks.onTimeline(items);
    }

    this.stats.kcal = (songT / 60) * 7.2;
    this.hooks.onHud({ ...this.stats });

    // 红绿灯窗口切换通知（LV4）
    const ph = this.phaseAt(songT);
    if (ph !== this.lastPhase) {
      this.lastPhase = ph;
      this.hooks.onPhase?.(ph);
    }

    // 关卡倒计时（4Hz）
    this.timerAcc += dt;
    if (this.timerAcc >= 0.25) {
      this.timerAcc = 0;
      const remain = Math.max(0, this.endTime - songT);
      this.hooks.onTimer?.(remain, Math.min(1, Math.max(0, songT / this.endTime)));
    }

    // 自适应画质：连续 2 个 1 秒窗 < 40fps → 降 pixelRatio / 关 bloom（一次性不回弹）
    this.fpsAcc += dt;
    this.fpsN += 1;
    if (this.fpsAcc >= 1) {
      const fps = this.fpsN / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsN = 0;
      if (fps < 40) {
        this.lowFpsWindows += 1;
        if (this.lowFpsWindows >= 2) this.degradeQuality();
      } else {
        this.lowFpsWindows = 0;
      }
    }

    // 动作块/世界定位：位置 = songTime 纯函数（分屏对战时同一函数把世界摆到对手时钟）
    this.layoutWorldAt(this.visT);
    const bpm = this.chart.bpm;
    for (const br of this.bricks) {
      if (br.hit) continue;
      // 未命中：穿过判定线后缩没（poof）；未判定时随节拍呼吸（idea 2）
      if (br.judged) {
        const s = Math.max(0.001, br.group.scale.x - dt * 3);
        br.group.scale.setScalar(s);
        br.bodyMat.opacity = s;
      } else if (this.brickStyle === 'block') {
        // 节拍呼吸（idea 2）：亮度随拍脉动（保持实心填充，不走透明度）
        const phase = this.visT * (bpm / 60) * Math.PI * 2;
        br.bodyMat.color.setScalar(0.86 + 0.14 * (0.5 + 0.5 * Math.sin(phase)));
      }
      if (br.glow) br.glow.intensity = br.judged ? 0.8 : 3 + Math.sin(this.visT * 6) * 0.9;
    }

    // 判定环脉冲 + BPM 呼吸（gate/日辉/尘埃/辉光随拍包络明暗）
    if (this.gateFlash > 0) {
      this.gateFlash = Math.max(0, this.gateFlash - dt * 2.6);
    }
    const beatPhase = ((((this.visT - (this.chart.offsetSec ?? 0)) * bpm) / 60) % 1 + 1) % 1;
    const beatEnv = Math.pow(1 - beatPhase, 2.1);
    this.gateStrip.opacity = 0.32 + this.gateFlash * 0.68 + beatEnv * 0.12;
    if (this.sunGlowSprite) this.sunGlowSprite.material.opacity = 0.32 + beatEnv * 0.14;
    if (this.dustMat) this.dustMat.opacity = 0.38 + beatEnv * 0.12;
    for (const m of this.gatePostMats) m.emissiveIntensity = 0.8 + this.gateFlash * 1.7;
    if (this.bloomPass) {
      if (this.bloomKick > 0.002) this.bloomKick *= 0.9;
      else this.bloomKick = 0;
      this.bloomPass.strength = 0.42 + beatEnv * 0.05 + this.bloomKick * 0.4;
    }

    // 相机跳跃反馈（判定动作驱动）
    this.jumpVy -= GRAVITY * dt;
    this.jumpY = Math.max(0, this.jumpY + this.jumpVy * dt);
    if (this.jumpY === 0) this.jumpVy = 0;

    this.mixer?.update(vdt);

    // miss 踉跄：受击后 0.55s 内左右晃动衰减
    if (this.coachModel) {
      const sT = this.stumbleUntil - songT;
      this.coachModel.position.x = sT > 0 ? Math.sin((0.55 - sT) * 30) * 0.1 * (sT / 0.55) : 0;
    }
    // 冲刺强度：连击倍率平滑驱动，速度线随冲刺升温（冲刺拖影）
    const rushT = Math.min(1, Math.max(0, (this.stats.multiplier - 1) / 3));
    this.rush += (rushT - this.rush) * Math.min(1, dt * 2.2);
    if (this.speedLineMat) {
      this.speedLineMat.opacity = 0.22 + this.rush * 0.5;
      this.speedLineMat.color.setRGB(0.62 + this.rush * 0.38, 0.85 + this.rush * 0.12, 1);
    }

    // 装饰自转（增量；位置由 layoutWorldAt 按时钟摆）
    this.scene3.children.forEach((c) => {
      if (c.userData.spin) c.rotation.y += (c.userData.spin as number) * dt;
    });

    // 速度线推进（1.55× 世界速，强化冲刺感；顿帧时冻结）
    for (const m of this.speedLines) {
      m.position.z -= SPEED * (1.35 + this.rush * 0.85) * vdt;
      if (m.position.z < -6) m.position.z += 186;
    }

    // 碎裂碎片（命中炸开的块体残片）
    for (const d of this.debris) {
      d.mesh.position.addScaledVector(d.vel, dt);
      d.vel.y -= 14 * dt;
      d.mesh.rotation.x += d.rot.x * dt;
      d.mesh.rotation.y += d.rot.y * dt;
      d.mesh.rotation.z += d.rot.z * dt;
      d.life -= dt * 1.5;
      (d.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, d.life);
    }
    this.debris = this.debris.filter((d) => {
      if (d.life <= 0) {
        this.scene3.remove(d.mesh);
        return false;
      }
      return true;
    });

    // 粒子
    for (const sp of this.particles) {
      const vel = sp.userData.vel as THREE.Vector3;
      sp.position.addScaledVector(vel, dt);
      vel.y -= 9 * dt;
      sp.userData.life = (sp.userData.life as number) - dt * 1.4;
      sp.material.opacity = Math.max(0, sp.userData.life as number);
    }
    this.particles = this.particles.filter((sp) => {
      if ((sp.userData.life as number) <= 0) {
        this.scene3.remove(sp);
        return false;
      }
      return true;
    });
    for (const rg of this.ripples) {
      rg.userData.life = (rg.userData.life as number) - dt * 1.8;
      rg.scale.multiplyScalar(1 + dt * 3.2);
      (rg.material as THREE.MeshBasicMaterial).opacity = Math.max(0, rg.userData.life as number) * 0.85;
    }
    this.ripples = this.ripples.filter((rg) => {
      if ((rg.userData.life as number) <= 0) {
        this.scene3.remove(rg);
        return false;
      }
      return true;
    });

    // 相机：随玩家横移轻微转向/倾斜 + 震屏 + 跳跃起伏
    this.steer += (this.steerTarget - this.steer) * 0.055;
    const camBaseY = this.camY + this.jumpY * 0.22;
    const shakeX = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;
    const shakeY = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;
    this.camera.position.x = this.steer * 2.1 + shakeX;
    this.camera.position.y += (camBaseY + shakeY - this.camera.position.y) * 0.12;
    if (this.shake > 0) {
      this.shake *= 0.88;
      if (this.shake < 0.01) this.shake = 0;
    }
    this.camera.lookAt(this.steer * 1.15, 1.35 + this.jumpY * 0.35, 9);
    // 局部滚转（不能直接赋 rotation.z：会覆盖 lookAt 算出的翻转分量）
    this.camera.rotateZ(-this.steer * 0.045);

    // 镜头冲击（命中 FOV 脉冲，快速回落）
    if (this.fovKick > 0) {
      this.camera.fov = this.fovBase + this.fovKick * 3.6;
      this.camera.updateProjectionMatrix();
      this.fovKick *= 0.86;
      if (this.fovKick < 0.01) {
        this.fovKick = 0;
        this.camera.fov = this.fovBase;
        this.camera.updateProjectionMatrix();
      }
    }

    // 命中闪屏（泛光联动）
    if (this.flash > 0) {
      this.renderer.toneMappingExposure = 0.92 + this.flash * 0.6;
      this.flash *= 0.85;
    } else {
      this.renderer.toneMappingExposure += (0.92 - this.renderer.toneMappingExposure) * 0.2;
    }

    if (this.split) {
      // 分屏双舞台：左半我的时钟；右半同一世界摆到对手时钟（scissor 直渲，对战去 bloom 保帧率）
      const r = this.renderer;
      const w = this.canvas.clientWidth || 1280;
      const h = this.canvas.clientHeight || 720;
      const hw = Math.floor(w / 2);
      r.setScissorTest(true);
      r.setViewport(0, 0, hw, h);
      r.setScissor(0, 0, hw, h);
      r.render(this.scene3, this.camera);
      // 右半：对手舞台（位置纯函数摆到对手时钟 → 渲完摆回；碎裂缩放/淡出状态一并存还）
      const oppT = Math.min(this.endTime, this.oppT + (Date.now() - this.oppWallAt) / 1000);
      const saved = this.bricks.map((b) => [b.group.scale.x, b.bodyMat.opacity] as const);
      this.layoutWorldAt(oppT, true);
      r.setViewport(hw, 0, w - hw, h);
      r.setScissor(hw, 0, w - hw, h);
      r.render(this.scene3, this.camera);
      this.layoutWorldAt(this.visT, false);
      this.bricks.forEach((b, i) => {
        b.group.scale.setScalar(saved[i][0]);
        b.bodyMat.opacity = saved[i][1];
      });
      r.setScissorTest(false);
      r.setViewport(0, 0, w, h);
      r.setScissor(0, 0, w, h);
    } else {
      this.composer.render();
    }
    this.renderCoach(dt);

    if (songT > this.endTime) {
      if (this.state === 'playing') {
        this.state = 'celebrate';
        this.playAnim('cheer', 0.12, 1.12); // 冲线庆祝：结算欢呼
        this.stumbleUntil = 0;
        this.hooks.onEnd({ ...this.stats });
      }
      // 不 return：下帧走 celebrate 路径把欢呼播完再停帧
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  /** 降载：pixelRatio 1.0 + 关 bloom（一次性，不回弹防抖动） */
  private degradeQuality(): void {
    if (this.degraded) return;
    this.degraded = true;
    this.renderer.setPixelRatio(1);
    this.composer.setPixelRatio(1);
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    this.composer.setSize(size.x, size.y);
    if (this.bloomPass) this.bloomPass.enabled = false;
  }

  /** 世界定位：位置 = songTime 纯函数。分屏对战时同一函数把世界摆到对手时钟再摆回来 */
  private layoutWorldAt(t: number, forOpp = false): void {
    // 世界滚动（路面贴图 + 拱门）
    this.runwayTex.offset.y = (t * SPEED * 30) / 260;
    for (const c of this.scene3.children) {
      if (c.userData.baseZ !== undefined) {
        const span = 7 * 26;
        let z = (c.userData.baseZ - t * SPEED * 0.62) % span;
        if (z < -12) z += span;
        c.position.z = z;
      }
    }
    // 动作块沿时间轴推进（踏板保车道直线，玻璃/墙板向中心漏斗汇聚）
    for (const br of this.bricks) {
      const evT = eventTime(this.chart, br.ev);
      const z = (evT - t) * SPEED + RING_Z;
      br.group.position.z = z;
      const air = this.brickStyle === 'block' && isAirAction(br.ev.action);
      if (this.brickStyle === 'block') {
        br.group.position.x = br.baseX; // 纯透视车道，不漏斗汇聚
        if (air) {
          // 弧线入场（idea 4）：远处更高、抛物线落位 + 轻微浮动
          const arc = z > RING_Z ? Math.min(1.4, 0.00013 * (z - RING_Z) * (z - RING_Z)) : 0;
          br.group.position.y = arc + Math.sin(t * 2.2 + br.baseX * 0.6) * 0.14;
        }
      } else {
        const funnel = Math.max(0, Math.min(1, (120 - z) / 114));
        br.group.position.x = br.baseX * (1 - 0.78 * funnel);
      }
      // 预判光柱渐隐（idea 6）：远亮近隐，靠近判定线消失
      if (br.pillar) {
        br.pillar.opacity = z > RING_Z ? Math.max(0, Math.min(0.42, (z - RING_Z) / 70)) : 0;
      }
      if (forOpp) {
        // 对手舞台：对手已跑过的块不再显示（已判定），其余照常飞来
        br.group.visible = evT > t - 0.5 && z > -4.5 && z < 620;
      } else if (br.hit) {
        br.group.visible = false;
      } else {
        br.group.visible = z > -4.5 && z < 620;
      }
    }
  }

  /** 左下角教练视口：scissor 裁剪直渲（保留主场景像素，仅清深度） */
  private renderCoach(dt: number): void {    this.updateAvatar(dt);
    const w = this.canvas.clientWidth || 1280;
    const h = this.canvas.clientHeight || 720;
    // 窄屏缩到 ~112px，宽屏/大屏随宽度放大（上限 520px）
    const cw = Math.min(Math.max(w * 0.19, 112), 520);
    const ch = Math.min(h * 0.44, cw * 1.5);
    const x = w * 0.028;
    const y = h * 0.05;

    this.coachCamera.aspect = cw / ch;
    this.coachCamera.updateProjectionMatrix();

    const r = this.renderer;
    const oldAuto = r.autoClear;
    r.setScissorTest(true);
    r.setViewport(x, y, cw, ch);
    r.setScissor(x, y, cw, ch);
    r.clearDepth();
    r.autoClear = false;
    r.render(this.coachScene, this.coachCamera);
    r.autoClear = oldAuto;
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
    r.setScissor(0, 0, w, h);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
