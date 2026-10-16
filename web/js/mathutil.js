// Shared math helpers (DESIGN.md §4.3, §4.4). Mirrors firmware/src/mathutil.h.
// DOM-free ES module. JS computes in double; the firmware in float32 (§12 R17).

export const TAU = 6.28318531;

export function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
export function lerp(a, b, t) { return a + (b - a) * t; }

/** floor as an integer; the C++ version is (int)x minus 1 when x < (int)x. */
export function floorToInt(x) { return Math.floor(x); }
export function fract(x) { return x - Math.floor(x); }

/** Hermite step. e0 == e1 is a caller error (§6.5 trap), exactly as in C++. */
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function len(x, y) { return Math.sqrt(x * x + y * y); }
export function sign(x) { return x > 0 ? 1 : (x < 0 ? -1 : 0); }

// Colors are plain {r, g, b} objects with float sRGB channels 0..1.
export function lerpRGB(a, b, t) {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}
export function mulRGB(c, k) { return { r: c.r * k, g: c.g * k, b: c.b * k }; }

/** Three-stop gradient: core at t=0, mid at 0.5, rim at 1 (t clamped to [0,1]). */
export function grad3(t, core, mid, rim) {
  t = clamp(t, 0, 1);
  return t <= 0.5 ? lerpRGB(core, mid, 2 * t) : lerpRGB(mid, rim, 2 * t - 1);
}

/**
 * Polynomial atan2 (§4.4 coefficients, normative). Returns 0 for (0, 0).
 * Measured max |error| is 2.03e-4 rad (at |y| == |x|), within the |err| < 2.1e-4 rad of §3.3;
 * firmware uses the same polynomial, so parity is unaffected.
 */
export function fastAtan2(y, x) {
  const ax = Math.abs(x), ay = Math.abs(y);
  if (ax === 0 && ay === 0) return 0;
  const a = Math.min(ax, ay) / Math.max(ax, ay);
  const s = a * a;
  let r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a + a;
  if (ay > ax) r = 1.57079637 - r;
  if (x < 0) r = 3.14159274 - r;
  if (y < 0) r = -r;
  return r;
}

/** Normalized angle in [0, 1]: fastAtan2(y, x) / 2π + 0.5. */
export function aNorm(y, x) { return fastAtan2(y, x) * 0.159154943 + 0.5; }
