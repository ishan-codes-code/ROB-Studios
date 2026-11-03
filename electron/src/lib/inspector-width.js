/**
 * Pure inspector-width policy for the editor workspace. The resizable
 * right inspector clamps user widths into [MIN, MAX] and moves in fixed
 * keyboard steps; this module holds that logic so the splitter component
 * stays a thin event binding and the policy is unit-testable.
 */

export const INSPECTOR_MIN_WIDTH = 280;
export const INSPECTOR_MAX_WIDTH = 480;
export const INSPECTOR_DEFAULT_WIDTH = 340;
export const INSPECTOR_KEYBOARD_STEP = 16;
export const INSPECTOR_KEYBOARD_LARGE_STEP = 64;

/** Clamp a requested width into the usable inspector range. */
export function clampInspectorWidth(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return INSPECTOR_DEFAULT_WIDTH;
  }
  return Math.min(
    INSPECTOR_MAX_WIDTH,
    Math.max(INSPECTOR_MIN_WIDTH, Math.round(value)),
  );
}

/**
 * Move a width by one keyboard step. `direction` is +1 (grow, ArrowRight)
 * or -1 (shrink, ArrowLeft); any other value leaves the width unchanged.
 * `large` selects the Shift-Arrow stride.
 */
export function stepInspectorWidth(value, direction, large = false) {
  const base = clampInspectorWidth(value);
  const stride = large ? INSPECTOR_KEYBOARD_LARGE_STEP : INSPECTOR_KEYBOARD_STEP;
  if (direction === 1) {
    return clampInspectorWidth(base + stride);
  }
  if (direction === -1) {
    return clampInspectorWidth(base - stride);
  }
  return base;
}
