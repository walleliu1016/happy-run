import type { GameAction } from '../types';

/**
 * 动作符号库（简单几何图形，非人物）。
 * 用抽象几何符号表示每个动作，**彻底替代人物剪影**——避免"一堆人冲过来"的惊吓感。
 * 符号体系（实心填充，无描边无辉光）：
 *   左移 ← / 右移 → / 跳 ↑ / 蹲 ↓   —— 粗块方向箭头
 *   原地跑 »   —— 双雪佛龙（快进）
 *   踩踏 ⌄⌄   —— 双下雪佛龙（重踏）
 *   出拳 ✳    —— 冲击星
 * 一份符号绘制驱动多处：路面踏板 / 时间轴卡片 / 圆盘口令 / 玻璃面牌 / 墙板洞口。
 */

/** 在任意 ctx 上画动作符号（居中 cx,cy，按 box 大小适配），实心填充 */
export function drawPoseGlyph(
  ctx: CanvasRenderingContext2D,
  action: GameAction,
  color: string,
  cx: number,
  cy: number,
  box: number,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  const s = box * 0.5;

  // 粗块箭头（填充多边形），rot=0 指向右
  const arrow = (rot: number): void => {
    ctx.save();
    ctx.rotate(rot);
    const pts: Array<[number, number]> = [
      [-0.95, -0.28], [0.1, -0.28], [0.1, -0.72],
      [0.98, 0], [0.1, 0.72], [0.1, 0.28], [-0.95, 0.28],
    ];
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * s, y * s) : ctx.lineTo(x * s, y * s)));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  // V 形雪佛龙（实心填充），rot=0 指向右，n 个叠成快进感
  const chev = (rot: number, n: number): void => {
    ctx.save();
    ctx.rotate(rot);
    const t = s * 0.3; // 条带厚度
    const offs = n === 2 ? [-0.46, 0.32] : [0];
    for (const off of offs) {
      const a: [number, number] = [(off - 0.34) * s, -0.62 * s];
      const b: [number, number] = [(off + 0.34) * s, 0];
      const c2: [number, number] = [(off - 0.34) * s, 0.62 * s];
      const seg = (p: [number, number], q: [number, number]): void => {
        const dx = q[0] - p[0]; const dy = q[1] - p[1];
        const L = Math.hypot(dx, dy) || 1;
        const ox = (-dy / L) * t * 0.5; const oy = (dx / L) * t * 0.5;
        ctx.beginPath();
        ctx.moveTo(p[0] + ox, p[1] + oy);
        ctx.lineTo(q[0] + ox, q[1] + oy);
        ctx.lineTo(q[0] - ox, q[1] - oy);
        ctx.lineTo(p[0] - ox, p[1] - oy);
        ctx.closePath();
        ctx.fill();
      };
      seg(a, b);
      seg(b, c2);
      // 圆角接头（补上两段条带交汇处）
      ctx.beginPath();
      ctx.arc(b[0], b[1], t * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };

  // 冲击星（8 尖，交替长短，像一记"命中"爆发）
  const star = (): void => {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2 - Math.PI / 2;
      const rad = i % 2 === 0 ? s : s * 0.38;
      const px = Math.cos(ang) * rad;
      const py = Math.sin(ang) * rad;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  };

  switch (action) {
    case 'left': arrow(Math.PI); break;
    case 'right': arrow(0); break;
    case 'jump': arrow(-Math.PI / 2); break;
    case 'squat': arrow(Math.PI / 2); break;
    case 'run': chev(0, 2); break;
    case 'stomp': chev(Math.PI / 2, 2); break;
    case 'punch': star(); break;
    default: arrow(0);
  }
  ctx.restore();
}

const silCanvasCache = new Map<string, HTMLCanvasElement>();
const silCache = new Map<string, string>();

/** 动作符号画布（缓存，GL 纹理/贴图共用同一份绘制） */
export function poseSilhouetteCanvas(action: GameAction, color: string, size = 160): HTMLCanvasElement {
  const key = `${action}|${color}|${size}`;
  const hit = silCanvasCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  if (g) drawPoseGlyph(g, action, color, size / 2, size / 2, size * 0.82);
  silCanvasCache.set(key, c);
  return c;
}

/** 动作符号 data URL（透明底，时间轴卡片 / 圆盘口令用） */
export function poseSilhouette(action: GameAction, color: string, size = 160): string {
  const key = `${action}|${color}|${size}`;
  const hit = silCache.get(key);
  if (hit) return hit;
  const url = poseSilhouetteCanvas(action, color, size).toDataURL('image/png');
  silCache.set(key, url);
  return url;
}
