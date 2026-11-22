import type { GameAction } from '../types';

/** 手柄/键盘输入源：Gamepad API 轮询 + 键盘兜底，事件式触发动作。
 *  - 标准映射：A(0)跳 B(1)踩 X(2)挥 Y(3)蹲 · L1(4)/十字左(14)=左 R1(5)/十字右(15)=右 · L2/R2/L3/R3=跑
 *  - 摇杆：上=跳 下=踩 左右=移动（0.6 触发 / 0.35 回中，迟滞防抖）
 *  - 键盘：↑/W 跳 ↓/S 踩 ←/A 左 →/D 右 J 挥 K 蹲 L 跑
 *  （空格/Enter 的"跳"由全局既有监听负责，这里不重复绑定，避免一次按键双触发）
 *  - Joy-Con 单只/一对均按此映射直认；不同系统对单只横握的键位上报不一，
 *    故每个动作绑多个键位 + 摇杆/十字冗余，边沿触发 + 140ms 去重，双绑无副作用。
 */

const BUTTON_ACTIONS: Array<[number, GameAction]> = [
  [0, 'jump'], [12, 'jump'],
  [1, 'stomp'], [13, 'stomp'],
  [2, 'punch'],
  [3, 'squat'],
  [4, 'left'], [14, 'left'],
  [5, 'right'], [15, 'right'],
  [6, 'run'], [7, 'run'], [10, 'run'], [11, 'run'],
];

const KEY_ACTIONS: Record<string, GameAction> = {
  ArrowUp: 'jump', w: 'jump', W: 'jump',
  ArrowDown: 'stomp', s: 'stomp', S: 'stomp',
  ArrowLeft: 'left', a: 'left', A: 'left',
  ArrowRight: 'right', d: 'right', D: 'right',
  j: 'punch', J: 'punch',
  k: 'squat', K: 'squat',
  l: 'run', L: 'run',
};

const COOLDOWN_MS = 140;

export function connectedPadNames(): string[] {
  return (navigator.getGamepads?.() ?? [])
    .filter((p): p is Gamepad => !!p)
    .map((p) => p.id);
}

export class GamepadInput {
  private raf = 0;
  private lastFire: Record<GameAction, number> = {
    jump: 0, squat: 0, punch: 0, stomp: 0, run: 0, left: 0, right: 0,
  };
  private prevButtons = new Map<number, boolean[]>();
  private prevAxes = new Map<number, [boolean, boolean, boolean, boolean]>();

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    const a = KEY_ACTIONS[e.key];
    if (a) this.fire(a);
  };

  constructor(private emit: (action: GameAction) => void) {}

  start(): void {
    window.addEventListener('keydown', this.onKeyDown);
    const loop = (): void => {
      this.poll();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    cancelAnimationFrame(this.raf);
    this.prevButtons.clear();
    this.prevAxes.clear();
  }

  private fire(action: GameAction): void {
    const now = performance.now();
    if (now - this.lastFire[action] < COOLDOWN_MS) return;
    this.lastFire[action] = now;
    this.emit(action);
  }

  private poll(): void {
    const pads = navigator.getGamepads?.() ?? [];
    for (const pad of pads) {
      if (!pad) continue;
      const prev = this.prevButtons.get(pad.index) ?? [];
      const cur = pad.buttons.map((b) => b.pressed);
      for (const [idx, action] of BUTTON_ACTIONS) {
        if (cur[idx] && !prev[idx]) this.fire(action);
      }
      this.prevButtons.set(pad.index, cur);

      const x = pad.axes[0] ?? 0;
      const y = pad.axes[1] ?? 0;
      const [pl, pr, pu, pd] = this.prevAxes.get(pad.index) ?? [false, false, false, false];
      const l = x < -0.6 || (pl && x < -0.35);
      const r = x > 0.6 || (pr && x > 0.35);
      const u = y < -0.6 || (pu && y < -0.35);
      const d = y > 0.6 || (pd && y > 0.35);
      if (l && !pl) this.fire('left');
      if (r && !pr) this.fire('right');
      if (u && !pu) this.fire('jump');
      if (d && !pd) this.fire('stomp');
      this.prevAxes.set(pad.index, [l, r, u, d]);
    }
  }
}
