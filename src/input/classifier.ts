import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { GameAction } from '../types';

/**
 * 关键点 → 动作分类器（按"完成时刻"触发）。
 * Just Dance 式判定语义：动作的峰值时刻（跳=滞空最高点 / 蹲=最低点 / 拳=手臂到点）
 * 才是卡点判定的对齐目标，所以事件在峰值处触发，而不是动作起步时。
 * 1. 髋部 y 做指数平滑，速度用差分估计
 * 2. 状态机 + 迟滞 + 不应期，避免一个动作触发多次
 * 3. run 用膝盖抬升频率判定（2-4Hz 持续），周期性补发事件
 */
export class ActionClassifier {
  // 平滑髋部高度
  private hipSm = 0;
  private hipVel = 0;
  private inited = false;

  // 状态
  private airborne = false;
  private takeoffT = 0;
  private jumpFired = false;
  private squatting = false;
  private squatFired = false;
  private prevHipDrop = 0;
  private handsUp = false;
  private lastFire: Record<GameAction, number> = {
    jump: -10, squat: -10, punch: -10, stomp: -10, run: -10, left: -10, right: -10,
  };

  // 髋部横向位置平滑（侧移检测：面向摄像头时玩家自身左 = 图像右）
  private hipXSm = 0.5;

  // 跑步频率估计（膝盖抬升过零）
  private kneeSm = 0;
  private kneePrev = 0;
  private peakTimes: number[] = [];

  // 时间基准提供者（默认 performance.now()/1000，可注入 audio 时钟）
  constructor(private nowSec: () => number = () => performance.now() / 1000) {}

  push(landmarks: NormalizedLandmark[] | null): GameAction[] {
    const t = this.nowSec();
    if (!landmarks || landmarks.length < 25) return [];
    // 关键点整体可见度过低（遮挡/出画/过暗）：本帧不触发，防误判（画面有提示条引导）
    let visSum = 0;
    for (const lm of landmarks) visSum += lm.visibility ?? 1;
    if (visSum / landmarks.length < 0.5) return [];

    const fired: GameAction[] = [];
    const fire = (a: GameAction, cooldown: number) => {
      if (t - this.lastFire[a] < cooldown) return;
      this.lastFire[a] = t;
      fired.push(a);
    };

    // 关键点：23/24 髋，25/26 膝，27/28 踝，15/16 腕，7/8 耳
    const hip = {
      x: (landmarks[23].x + landmarks[24].x) / 2,
      y: (landmarks[23].y + landmarks[24].y) / 2,
    };
    const kneeY = (landmarks[25].y + landmarks[26].y) / 2;
    const ankleY = (landmarks[27].y + landmarks[28].y) / 2;
    const wristL = landmarks[15];
    const wristR = landmarks[16];
    const earY = (landmarks[7].y + landmarks[8].y) / 2;

    if (!this.inited) {
      this.hipSm = hip.y;
      this.hipXSm = hip.x;
      this.kneeSm = kneeY;
      this.inited = true;
      return [];
    }

    // ---- 髋部平滑与速度（y 轴向下为正，起跳 = y 变小） ----
    const alpha = 0.45;
    const prevHip = this.hipSm;
    this.hipSm = alpha * hip.y + (1 - alpha) * this.hipSm;
    this.hipVel = (this.hipSm - prevHip); // 每帧位移

    // ---- 侧移：髋部横偏持续超阈（LV1 跑酷左右闪避 / LV2 玻璃桥选边） ----
    this.hipXSm = 0.35 * hip.x + 0.65 * this.hipXSm;
    if (this.hipXSm > 0.62) fire('left', 0.9);
    else if (this.hipXSm < 0.38) fire('right', 0.9);

    // ---- 跳跃：滞空最高点触发（完成时刻 ≈ apex） ----
    if (this.hipVel < -0.016 && !this.airborne) {
      this.airborne = true;
      this.takeoffT = t;
      this.jumpFired = false;
    }
    if (this.airborne) {
      const since = t - this.takeoffT;
      // 速度过零 = 最高点；兜底超时（小跳/低帧率）也要出事件
      if (!this.jumpFired && since > 0.1 && (this.hipVel > -0.001 || since > 0.6)) {
        this.jumpFired = true;
        fire('jump', 0.5);
      }
      if (this.hipVel > 0.012 && since > 0.15) this.airborne = false;
    }

    // ---- 下蹲：最低点触发（髋部下压到谷底刚要回升的瞬间） ----
    const thighLen = Math.abs(landmarks[23].y - landmarks[25].y) + 1e-6;
    const hipDrop = hip.y - this.hipSm;
    const kneeBend = (ankleY - kneeY) / (thighLen + 1e-6);
    if (!this.squatting && hipDrop > 0.045 && kneeBend < 1.35) {
      this.squatting = true;
      this.squatFired = false;
    }
    if (this.squatting) {
      // hipDrop 由升转降 = 谷底刚过（EMA 追赶开始）→ 完成时刻
      if (!this.squatFired && this.prevHipDrop > 0.03 && hipDrop < this.prevHipDrop - 0.003) {
        this.squatFired = true;
        fire('squat', 0.8);
      }
      if (hipDrop < 0.018) this.squatting = false;
    }
    this.prevHipDrop = hipDrop;

    // ---- 踩踏：踝部大幅上下（抬腿跺地），在跑动之外 ----
    const legLift = this.kneeSm - kneeY;
    this.kneeSm = 0.5 * kneeY + 0.5 * this.kneeSm;

    // ---- 挥臂：任一手腕过耳且手臂展开（到点即触发） ----
    const handUpL = wristL.y < earY - 0.02;
    const handUpR = wristR.y < earY - 0.02;
    const handSpread = Math.hypot(wristL.x - wristR.x, wristL.y - wristR.y);
    if ((handUpL || handUpR) && handSpread > 0.18 && !this.handsUp) {
      this.handsUp = true;
      fire('punch', 0.4);
    }
    if (!handUpL && !handUpR) this.handsUp = false;

    // ---- 原地跑：膝盖抬升频率 2-4Hz ----
    if (legLift > 0.02 && this.kneePrev <= 0.02) {
      this.peakTimes.push(t);
      this.peakTimes = this.peakTimes.filter((x) => t - x < 3);
    }
    this.kneePrev = legLift;
    if (this.peakTimes.length >= 4) {
      const span = t - this.peakTimes[0];
      const freq = (this.peakTimes.length - 1) / Math.max(span, 0.001);
      if (freq >= 1.6 && freq <= 5) {
        fire('run', 0.9);
        // 跑步中大幅抬腿 = 踩踏节拍
        if (legLift > 0.05) fire('stomp', 0.55);
      }
    }

    return fired;
  }

  reset(): void {
    this.inited = false;
    this.peakTimes = [];
    this.airborne = false;
    this.squatting = false;
    this.prevHipDrop = 0;
    this.hipXSm = 0.5;
    this.lastFire = { jump: -10, squat: -10, punch: -10, stomp: -10, run: -10, left: -10, right: -10 };
  }
}
