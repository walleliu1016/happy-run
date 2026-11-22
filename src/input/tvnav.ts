// TV / 遥控器 D-pad 焦点导航
// 方向键在当前屏幕的可聚焦元素间按几何方位移动焦点，OK/Enter/Space 触发；
// 游戏进行中（busy）完全放行，不抢游戏按键。
// 电视 3 米观看距离：焦点环要大、要亮（.tv-focus，见 styles.css）。

type Dir = 'up' | 'down' | 'left' | 'right';

const FOCUSABLE =
  'button:not([disabled]), [role="button"], input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]';

const NATIVE_INPUT = 'input, textarea, select';

let cur: HTMLElement | null = null;

function isVisible(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
}

function focusables(): HTMLElement[] {
  const screen = document.querySelector('.screen.active');
  if (!screen) return [];
  return [...screen.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isVisible);
}

function focusEl(el: HTMLElement): void {
  cur?.classList.remove('tv-focus');
  el.classList.add('tv-focus');
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  cur = el;
}

function move(dir: Dir): void {
  const items = focusables();
  if (!items.length) return;
  if (!cur || !items.includes(cur)) {
    focusEl(items[0]);
    return;
  }
  const r = cur.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    const dx = b.left + b.width / 2 - cx;
    const dy = b.top + b.height / 2 - cy;
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
      best = el;
    }
  }
  if (best) focusEl(best);
}

/** 屏幕切换 / DOM 重建后重置焦点到第一个可聚焦元素 */
function resetSoon(): void {
  requestAnimationFrame(() => {
    const items = focusables();
    if (!items.length) {
      cur?.classList.remove('tv-focus');
      cur = null;
      return;
    }
    if (!cur || !items.includes(cur)) focusEl(items[0]);
  });
}

/**
 * 挂载 TV 导航。
 * @param isBusy 返回 true 时（游戏对局中 / 校准弹层）本模块不拦截任何按键
 */
export function attachTvNav(isBusy: () => boolean): void {
  window.addEventListener('keydown', (e) => {
    if (isBusy()) return;
    const tag = (document.activeElement?.tagName ?? '').toLowerCase();
    const nativeInput = tag === 'input' || tag === 'textarea' || tag === 'select';
    const dirMap: Record<string, Dir> = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
    };
    const dir = dirMap[e.key];
    if (dir) {
      // 输入控件（滑杆/文本框）内方向键保留原生行为
      if (nativeInput && document.activeElement?.matches(NATIVE_INPUT)) return;
      e.preventDefault();
      move(dir);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      if (e.repeat) return;
      const items = focusables();
      const target = (cur && items.includes(cur) ? cur : items[0]) ?? null;
      if (!target) return;
      e.preventDefault();
      focusEl(target);
      target.click();
    }
  });

  // 屏幕切换（.screen.active 变化）后自动重置焦点
  const obs = new MutationObserver(() => resetSoon());
  document.querySelectorAll('.screen').forEach((s) => obs.observe(s, { attributes: true, attributeFilter: ['class'] }));
  resetSoon();
}
