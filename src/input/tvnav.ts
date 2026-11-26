// TV / 遥控器 D-pad 焦点导航（对齐腾讯视频 TV / New TV 极光的焦点规则）
// - 焦点唯一且醒目（.tv-focus 白圈 + 金圈零模糊环，见 styles.css）
// - 十字就近：方向键在当前层的可聚焦元素间按几何方位移动
// - 引导用户：进屏/进弹层焦点自动落位（主内容区优先，弹层落层内）
// - 焦点记忆：「上次从哪来，就回哪去」——离层再回来，焦点回到原处
// - 顶层弹层优先：弹层打开时焦点困在弹层内，不跑到弹层背后（遥控唯一真理）
// - OK/Enter/Space 触发；游戏对局中（busy）完全放行，不抢游戏按键
// - 原生壳按键桥 __tvKey：盒子焦点链路丢键时由 MainActivity 注入，合成事件走同一套处理
//
// P16 性能改造（TV「不灵敏 / 卡顿」根治）：
//   ① 焦点几何缓存：一次批量读取所有候选的 rect，按键时只做纯算术，不再
//      querySelectorAll + getComputedStyle + getBoundingClientRect 逐元素读写交替
//      （原来每次方向键触发几十次强制同步布局，是电视盒子上最大的延迟源）。
//   ② 方向键长按 repeat 限速 90ms；系统 repeat 约 50ms 一发，会把几何计算压垮。
//   ③ scrollIntoView 移到下一帧，与按键处理解耦，避免同帧强制布局。
//   ④ .tv-focus 去掉 scale(1.05)（CSS 侧）：焦点不再改变元素 rect，几何稳定不跳格。
//   缓存失效：层/弹层 class 变化、窗口 resize、任意滚动容器滚动。

type Dir = 'up' | 'down' | 'left' | 'right';

// 老 Android WebView（电视盒子 System WebView 常停在 Chrome 54 以前）的
// KeyboardEvent.key 用旧 DOM3 命名（'Left'/'Up'…），部分遥控/盒子只给 keyCode。
// 统一归一到 'Arrow*' / 'Enter' / ' ' / 'Escape'，否则方向键全部失灵、只剩确定键可用。
const KEY_ALIASES: Record<string, string> = {
  Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
  Spacebar: ' ', OK: 'Enter', Select: 'Enter', Esc: 'Escape',
};
const KEYCODE_MAP: Record<number, string> = {
  38: 'ArrowUp', 40: 'ArrowDown', 37: 'ArrowLeft', 39: 'ArrowRight',
  13: 'Enter', 23: 'Enter', 66: 'Enter', 32: ' ', 4: 'Escape',
};

/** 按键名归一化（新旧 WebView / 遥控键码三路兼容） */
export function normKey(e: KeyboardEvent): string {
  const k = e.key ?? '';
  if (!k || k === 'Unidentified') return KEYCODE_MAP[e.keyCode || e.which] ?? k;
  return KEY_ALIASES[k] ?? k;
}

/**
 * 原生壳按键桥（window.__tvKey）：部分盒子在 Activity 焦点链路里丢方向键，
 * MainActivity 无法把 KeyEvent 送进 DOM 时调用这里，合成 KeyboardEvent
 * 走 window keydown 同一套处理（tvnav + 游戏按键映射全部生效）。
 * 网页侧没有任何 keyup 消费者，壳侧只注入 ACTION_DOWN，每键跨桥次数减半。
 */
export function injectTvKey(key: string, up = false, repeat = false): void {
  window.dispatchEvent(new KeyboardEvent(up ? 'keyup' : 'keydown', {
    key, repeat, bubbles: true, cancelable: true,
  }));
}

const FOCUSABLE =
  'button:not([disabled]), [role="button"], input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]';

const NATIVE_INPUT = 'input, textarea, select';

interface FocusNode { el: HTMLElement; cx: number; cy: number; }

let cur: HTMLElement | null = null;

/** 焦点记忆：层 id → 上次聚焦元素（「从哪来，回哪去」） */
const focusMemory = new Map<string, HTMLElement>();

/* ---------- 焦点几何缓存 ---------- */
let cacheValid = false;
let cachedItems: HTMLElement[] = [];
let cachedNodes: FocusNode[] = [];

function invalidateFocusCache(): void {
  cacheValid = false;
}

/** 当前交互层：最上层弹层优先（弹层打开时焦点不许跑到背后），否则当前屏 */
function activeLayer(): HTMLElement | null {
  const overlays = document.querySelectorAll<HTMLElement>('.nick-overlay.show, .calib-overlay.show');
  if (overlays.length) return overlays[overlays.length - 1];
  return document.querySelector<HTMLElement>('.screen.active');
}

function layerKey(layer: HTMLElement): string {
  return layer.id || layer.className;
}

/**
 * 一次批量建缓存：先读完全部样式（不写），再读完全部 rect（不写）。
 * 交替读写会强制浏览器每轮重排；分开读只触发一次布局。
 */
function buildCache(): void {
  const layer = activeLayer();
  if (!layer) {
    cachedItems = []; cachedNodes = []; cacheValid = true;
    return;
  }
  const all = layer.querySelectorAll<HTMLElement>(FOCUSABLE);
  const visible: HTMLElement[] = [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    visible.push(el);
  }
  const nodes: FocusNode[] = [];
  for (let i = 0; i < visible.length; i++) {
    const el = visible[i];
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    nodes.push({ el, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
  }
  cachedNodes = nodes;
  cachedItems = nodes.map((n) => n.el);
  cacheValid = true;
}

function focusables(): HTMLElement[] {
  if (!cacheValid) buildCache();
  return cachedItems;
}

function focusEl(el: HTMLElement): void {
  if (cur) cur.classList.remove('tv-focus');
  el.classList.add('tv-focus');
  el.focus({ preventScroll: true });
  cur = el;
  const layer = activeLayer();
  if (layer) focusMemory.set(layerKey(layer), el);
  // 滚动延到下一帧：与按键几何计算解耦，避免同帧强制同步布局
  requestAnimationFrame(() => {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

/** 初始/回归焦点：优先焦点记忆，其次主内容区（topbar 是辅助操作，开场不落它），兜底第一个 */
function initialFocus(items: HTMLElement[]): HTMLElement {
  const layer = activeLayer();
  const remembered = layer ? focusMemory.get(layerKey(layer)) : undefined;
  if (remembered && items.indexOf(remembered) >= 0) return remembered;
  return items.find((el) => !el.closest('.topbar')) ?? items[0];
}

function move(dir: Dir): void {
  const items = focusables();
  if (!items.length) return;
  if (!cur || items.indexOf(cur) < 0) {
    focusEl(initialFocus(items));
    return;
  }
  let self: FocusNode | null = null;
  for (let i = 0; i < cachedNodes.length; i++) {
    if (cachedNodes[i].el === cur) { self = cachedNodes[i]; break; }
  }
  if (!self) {
    focusEl(initialFocus(items));
    return;
  }
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < cachedNodes.length; i++) {
    const n = cachedNodes[i];
    if (n.el === cur) continue;
    const dx = n.cx - self.cx;
    const dy = n.cy - self.cy;
    // 主轴必须在目标方向上；同排优先（横移惩罚纵偏）
    let primary: number;
    let cross: number;
    if (dir === 'left') { primary = -dx; cross = Math.abs(dy); }
    else if (dir === 'right') { primary = dx; cross = Math.abs(dy); }
    else if (dir === 'up') { primary = -dy; cross = Math.abs(dx); }
    else { primary = dy; cross = Math.abs(dx); }
    if (primary <= 8) continue;
    const score = primary + cross * 2.2;
    if (score < bestScore) {
      bestScore = score;
      best = n.el;
    }
  }
  if (best) focusEl(best);
}

/** 屏幕/弹层切换、DOM 重建后焦点自动落位（有记忆回记忆，否则主内容区） */
let resetPending = false;
function resetSoon(): void {
  if (resetPending) return; // 同一帧多次 class 变化只算一次
  resetPending = true;
  requestAnimationFrame(() => {
    resetPending = false;
    invalidateFocusCache();
    const items = focusables();
    if (!items.length) {
      if (cur) cur.classList.remove('tv-focus');
      cur = null;
      return;
    }
    if (!cur || items.indexOf(cur) < 0) focusEl(initialFocus(items));
  });
}

/**
 * 挂载 TV 导航。
 * @param isBusy 返回 true 时（游戏对局中 / 校准弹层）本模块不拦截任何按键
 */
export function attachTvNav(isBusy: () => boolean): void {
  let lastMoveAt = 0;
  const REPEAT_MS = 90; // 系统 repeat 约 50ms/发；限速后长按仍能连移，但不会压垮主线程

  window.addEventListener('keydown', (e) => {
    if (isBusy()) return;
    const tag = (document.activeElement?.tagName ?? '').toLowerCase();
    const nativeInput = tag === 'input' || tag === 'textarea' || tag === 'select';
    const key = normKey(e);
    const dirMap: Record<string, Dir> = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
    };
    const dir = dirMap[key];
    if (dir) {
      // 输入控件（滑杆/文本框）内方向键保留原生行为
      if (nativeInput && document.activeElement?.matches(NATIVE_INPUT)) return;
      e.preventDefault();
      if (e.repeat && Date.now() - lastMoveAt < REPEAT_MS) return;
      lastMoveAt = Date.now();
      move(dir);
      return;
    }
    if (key === 'Enter' || key === ' ') {
      if (e.repeat) return;
      const items = focusables();
      const target = (cur && items.indexOf(cur) >= 0 ? cur : initialFocus(items)) ?? null;
      if (!target) return;
      e.preventDefault();
      focusEl(target);
      target.click();
    }
  });

  // 缓存失效：窗口尺寸变化、任意滚动容器滚动（capture 才能捕获内部容器的 scroll）
  window.addEventListener('resize', invalidateFocusCache);
  window.addEventListener('scroll', invalidateFocusCache, true);

  // 触摸板/触屏遥控器兜底：滑动 = 方向键，轻点空白 = 确认。
  // 部分手机遥控器触摸板模式只发触摸事件不发按键，方向键链路靠它才能操作。
  // 注意：tv-mode class 是 boot 后段才加的，挂载时机判不到，必须在事件时判断。
  {
    let sx = 0, sy = 0, st = 0, tracking = false;
    window.addEventListener('touchstart', (e) => {
      if (!document.documentElement.classList.contains('tv-mode') || isBusy() || e.touches.length !== 1) {
        tracking = false;
        return;
      }
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY; st = Date.now(); tracking = true;
    }, { passive: true });
    window.addEventListener('touchend', (e) => {
      if (!tracking || !e.changedTouches.length) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      const nativeInput = tag === 'input' || tag === 'textarea' || tag === 'select';
      if (Date.now() - st > 800) return;
      if (dist < 24) {
        // 轻点：点在可聚焦元素上走原生点击；点在空白处 = 确认当前焦点
        const el = t.target instanceof Element ? t.target.closest(FOCUSABLE) : null;
        if (el) return;
        const items = focusables();
        const target = (cur && items.indexOf(cur) >= 0 ? cur : initialFocus(items)) ?? null;
        if (!target) return;
        focusEl(target);
        target.click();
        return;
      }
      if (dist < 40) return;
      if (nativeInput && document.activeElement?.matches(NATIVE_INPUT)) return;
      move(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
    }, { passive: true });
  }

  // 屏幕切换 / 弹层开关（.show）后自动落位焦点
  const obs = new MutationObserver(() => {
    invalidateFocusCache();
    resetSoon();
  });
  document
    .querySelectorAll('.screen, .nick-overlay, .calib-overlay')
    .forEach((s) => obs.observe(s, { attributes: true, attributeFilter: ['class'] }));
  resetSoon();
}
