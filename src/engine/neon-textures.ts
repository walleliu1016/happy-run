import * as THREE from 'three';

/** 程序化霓虹贴图工厂 —— 全部离线生成，零外部素材 */

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('canvas 2d 不可用');
  return [c, ctx];
}

/** 跑道贴图：深色底 + 发光泳道线 + 箭头格 */
export function runwayTexture(): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(256, 1024);
  const g = ctx.createLinearGradient(0, 0, 256, 0);
  g.addColorStop(0, '#120a24');
  g.addColorStop(0.5, '#1b1136');
  g.addColorStop(1, '#120a24');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 1024);

  // 泳道边界线
  for (const x of [24, 232]) {
    ctx.strokeStyle = 'rgba(255, 45, 149, 0.85)';
    ctx.lineWidth = 8;
    ctx.shadowColor = '#ff2d95';
    ctx.shadowBlur = 24;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 1024);
    ctx.stroke();
  }
  // 中线虚线
  ctx.strokeStyle = 'rgba(255, 122, 26, 0.55)';
  ctx.lineWidth = 4;
  ctx.shadowColor = '#FF7A1A';
  ctx.setLineDash([46, 46]);
  ctx.beginPath();
  ctx.moveTo(128, 0);
  ctx.lineTo(128, 1024);
  ctx.stroke();
  ctx.setLineDash([]);

  // 箭头格（节奏踩点感）
  ctx.shadowBlur = 0;
  for (let y = 0; y < 1024; y += 256) {
    ctx.fillStyle = 'rgba(34, 225, 255, 0.16)';
    ctx.beginPath();
    ctx.moveTo(64, y + 150);
    ctx.lineTo(128, y + 80);
    ctx.lineTo(192, y + 150);
    ctx.lineTo(128, y + 128);
    ctx.closePath();
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 24);
  tex.anisotropy = 4;
  return tex;
}

/** 径向光晕贴图（粒子/光斑通用） */
export function glowTexture(): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** 光束贴图：竖直渐变（顶亮底透） */
export function beamTexture(): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(64, 512);
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 512);
  const side = ctx.createLinearGradient(0, 0, 64, 0);
  side.addColorStop(0, 'rgba(0,0,0,1)');
  side.addColorStop(0.5, 'rgba(0,0,0,0)');
  side.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = side;
  ctx.fillRect(0, 0, 64, 512);
  return new THREE.CanvasTexture(c);
}

/** 图标贴图：圆形底 + emoji 字形（拳头/脚印/箭头等） */
export function iconTexture(glyph: string, color: string): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(256, 256);
  const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
  g.addColorStop(0, color);
  g.addColorStop(0.72, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  ctx.font = '130px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, 128, 138);
  return new THREE.CanvasTexture(c);
}

/** 天空渐变（深紫夜空 + 地平线霓虹光） */
export function skyTexture(): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(512, 512);
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, '#060312');
  g.addColorStop(0.42, '#150b33');
  g.addColorStop(0.72, '#3b1560');
  g.addColorStop(0.88, '#a028a8');
  g.addColorStop(1, '#2a0f4a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  // 星点
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 300;
    const a = Math.random() * 0.8 + 0.2;
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.fillRect(x, y, 2, 2);
  }
  return new THREE.CanvasTexture(c);
}

/** 霓虹拱门材质（自发光） */
export function neonMaterial(color: number, intensity = 1.6): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.35,
    metalness: 0.1,
    toneMapped: true,
  });
}

// ================= 大屏舞台风（红山 + 青日 + 琴键路面） =================

/** 暮色天空：竖向渐变（5 档色标）+ 星点 */
export function duskSkyTexture(
  stops: string[] = ['#0a0512', '#160818', '#3a1020', '#6b1c2c', '#2a0c14'],
  starCss = 'rgba(255,220,200,1)',
): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(512, 512);
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  stops.forEach((s, i) => g.addColorStop(i / Math.max(stops.length - 1, 1), s));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 280;
    const a = Math.random() * 0.55 + 0.15;
    ctx.fillStyle = withAlpha(starCss, a);
    ctx.fillRect(x, y, 2, 2);
  }
  return new THREE.CanvasTexture(c);
}

/** 任意 css 颜色改写透明度 */
function withAlpha(css: string, a: number): string {
  const m = css.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${a})`;
  return `rgba(255,255,255,${a})`;
}

/** 网格地形贴图：底色 + 发光网格线（主题着色） */
export function gridTerrainTexture(
  baseCss = '#380d18',
  gridCss = 'rgba(255,90,60,0.65)',
  glowCss = '#ff5a3c',
): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(256, 256);
  ctx.fillStyle = baseCss;
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = gridCss;
  ctx.lineWidth = 3;
  ctx.shadowColor = glowCss;
  ctx.shadowBlur = 10;
  for (let i = 0; i <= 256; i += 32) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 256);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(256, i);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(18, 24);
  return tex;
}

/** 公路路面贴图：深色路面 + 暖色边线 + 中央虚线 */
export function roadTexture(): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(256, 1024);
  const g = ctx.createLinearGradient(0, 0, 256, 0);
  g.addColorStop(0, '#170c10');
  g.addColorStop(0.5, '#221218');
  g.addColorStop(1, '#170c10');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 1024);
  for (const x of [10, 246]) {
    ctx.strokeStyle = 'rgba(255,160,90,0.8)';
    ctx.lineWidth = 8;
    ctx.shadowColor = '#ff9a5a';
    ctx.shadowBlur = 20;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 1024);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,190,130,0.4)';
  ctx.lineWidth = 5;
  ctx.shadowBlur = 8;
  ctx.setLineDash([56, 56]);
  ctx.beginPath();
  ctx.moveTo(128, 0);
  ctx.lineTo(128, 1024);
  ctx.stroke();
  ctx.setLineDash([]);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 30);
  tex.anisotropy = 4;
  return tex;
}

/**
 * 琴键行贴图（拍点的视觉载体）：暖白琴键条纹 + 动作色高亮块。
 * laneU = 高亮块中心在路面宽度方向的 u（0..1），gold = 金砖整行鎏金。
 */
export function keyRowTexture(laneU: number, tint: string, gold = false): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(512, 128);
  ctx.fillStyle = '#0c0608';
  ctx.fillRect(0, 0, 512, 128);
  const keys = 11;
  const kw = 512 / keys;
  for (let i = 0; i < keys; i++) {
    const x = i * kw + 4;
    const w = kw - 8;
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    const base = gold ? '255,214,10' : '255,238,200';
    g.addColorStop(0, `rgba(${base},0.95)`);
    g.addColorStop(1, `rgba(${base},0.55)`);
    ctx.fillStyle = g;
    ctx.fillRect(x, 8, w, 112);
  }
  // 动作高亮块：把 laneU 附近的琴键染成动作色、加亮
  const px = laneU * 512;
  ctx.globalCompositeOperation = 'source-atop';
  const hg = ctx.createRadialGradient(px, 64, 8, px, 64, 150);
  hg.addColorStop(0, gold ? 'rgba(255,230,120,0.95)' : hexA(tint, 0.95));
  hg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = hg;
  ctx.fillRect(0, 0, 512, 128);
  ctx.globalCompositeOperation = 'source-over';
  // 行前缘亮线（撞线感）
  const edge = ctx.createLinearGradient(0, 0, 0, 128);
  edge.addColorStop(0, gold ? 'rgba(255,240,170,1)' : 'rgba(255,255,255,0.9)');
  edge.addColorStop(0.12, 'rgba(255,255,255,0)');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, 512, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 8;
  return tex;
}

/** '#rrggbb' → 'rgba(r,g,b,a)' */
function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
