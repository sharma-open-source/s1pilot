import type { Locator } from 'playwright';

/** Bounds of a slider (`<input type="range">` attributes or `aria-value*`). */
export interface RangeBounds {
  min: number;
  max: number;
  /** Omitted for `step="any"` and ARIA sliders. */
  step?: number;
}

/** Result of a value conversion. Messages never contain the value (it may come from a secret). */
export type ValueResult = { ok: true; value: string } | { ok: false; message: string };

function decimals(n: number): number {
  const s = String(n);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/**
 * Converts a slider value to one `<input type="range">` accepts: a number within `min`..`max`,
 * snapped to the nearest `step` (the browser would otherwise reject or silently change it).
 */
export function normalizeRange(value: string, bounds: RangeBounds): ValueResult {
  const n = Number(value.trim());
  if (value.trim() === '' || !Number.isFinite(n)) {
    return { ok: false, message: `The slider value is not a number; it takes ${bounds.min} to ${bounds.max}` };
  }
  if (n < bounds.min || n > bounds.max) {
    return { ok: false, message: `The slider value is outside its range ${bounds.min} to ${bounds.max}` };
  }
  if (!bounds.step || bounds.step <= 0) return { ok: true, value: String(n) };
  // The epsilon keeps binary rounding (0.35 / 0.1 = 3.4999…) from snapping a midpoint down.
  const snapped = Math.min(bounds.max, bounds.min + Math.round((n - bounds.min) / bounds.step + 1e-9) * bounds.step);
  return { ok: true, value: snapped.toFixed(Math.max(decimals(bounds.step), decimals(bounds.min))).replace(/\.0+$/, '') };
}

/** Reads `min` / `max` / `step` of an `<input type="range">` (browser defaults 0, 100, 1). */
export async function rangeBounds(locator: Locator, timeout: number): Promise<RangeBounds> {
  const raw = await locator.evaluate(
    (el) => {
      const i = el as HTMLInputElement;
      return { min: i.min, max: i.max, step: i.step };
    },
    undefined,
    { timeout },
  );
  const num = (s: string, d: number): number => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : d);
  const bounds: RangeBounds = { min: num(raw.min, 0), max: num(raw.max, 100) };
  if (raw.step.toLowerCase() !== 'any') bounds.step = num(raw.step, 1);
  return bounds;
}

/**
 * Converts any CSS colour (`red`, `#F00`, `rgb(255 0 0)`, `hsl(0 100% 50%)`) to the lowercase
 * `#rrggbb` an `<input type="color">` accepts, using the page's own CSS parser.
 */
export async function normalizeColor(locator: Locator, value: string, timeout: number): Promise<ValueResult> {
  const hex = await locator.evaluate(
    (_el, v) => {
      const probe = new Option().style;
      probe.color = v;
      if (!probe.color) return null;
      const ctx = document.createElement('canvas').getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = v;
      return typeof ctx.fillStyle === 'string' ? ctx.fillStyle : null;
    },
    value.trim(),
    { timeout },
  );
  if (hex === null) return { ok: false, message: 'The colour field value is not a CSS colour; it takes #rrggbb or a colour name' };
  if (!/^#[0-9a-f]{6}$/.test(hex)) return { ok: false, message: 'The colour field cannot take a transparent colour; it takes #rrggbb' };
  return { ok: true, value: hex };
}

/** Upper bound of arrow-key presses when moving an ARIA slider. */
const MAX_SLIDER_PRESSES = 500;

/**
 * Moves a custom ARIA slider (`role="slider"`, not an `<input>`) to `value` with the arrow keys,
 * reading `aria-valuenow` after each press. Stops at the closest reachable value; fails when the
 * slider does not react to the keyboard.
 */
export async function setAriaSlider(locator: Locator, value: string, timeout: number): Promise<ValueResult> {
  const target = Number(value.trim());
  if (value.trim() === '' || !Number.isFinite(target)) return { ok: false, message: 'The slider value is not a number' };
  const now = async (): Promise<number> =>
    Number(await locator.evaluate((el) => el.getAttribute('aria-valuenow') ?? 'NaN', undefined, { timeout }));
  const bounds = await locator.evaluate(
    (el) => [Number(el.getAttribute('aria-valuemin') ?? 'NaN'), Number(el.getAttribute('aria-valuemax') ?? 'NaN')],
    undefined,
    { timeout },
  );
  const [min, max] = bounds as [number, number];
  if ((Number.isFinite(min) && target < min) || (Number.isFinite(max) && target > max)) {
    return { ok: false, message: `The slider value is outside its range ${min} to ${max}` };
  }
  let current = await now();
  if (!Number.isFinite(current)) return { ok: false, message: 'The slider has no aria-valuenow, so its value cannot be set' };
  await locator.focus({ timeout });
  for (let i = 0; i < MAX_SLIDER_PRESSES && current !== target; i += 1) {
    const up = current < target;
    await locator.press(up ? 'ArrowRight' : 'ArrowLeft', { timeout });
    const next = await now();
    if (next === current) return { ok: false, message: 'The slider does not react to the arrow keys' };
    // Overshot the target with this step size: keep whichever side is closer.
    if (up ? next > target : next < target) {
      if (Math.abs(next - target) > Math.abs(current - target)) await locator.press(up ? 'ArrowLeft' : 'ArrowRight', { timeout });
      break;
    }
    current = next;
  }
  return { ok: true, value: String(await now()) };
}
