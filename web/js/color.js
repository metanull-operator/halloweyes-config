// Color conversion and RGB565 quantization (DESIGN.md §4.7, §7.1).
// Mirrors firmware/src/color.h. DOM-free ES module.

/**
 * '#RRGGBB' (or a 0xRRGGBB integer) -> {r, g, b} float sRGB 0..1 (v / 255, no linearization).
 * @param {string|number} hex
 */
export function hexToRgbf(hex) {
  let v;
  if (typeof hex === 'number') {
    v = hex >>> 0;
  } else {
    const m = /^#([0-9A-Fa-f]{6})$/.exec(String(hex));
    if (!m) throw new Error(`hexToRgbf: invalid color ${JSON.stringify(hex)} (expected #RRGGBB)`);
    v = parseInt(m[1], 16);
  }
  return { r: ((v >>> 16) & 0xFF) / 255, g: ((v >>> 8) & 0xFF) / 255, b: (v & 0xFF) / 255 };
}

// 4x4 Bayer matrix, flattened row-major: BAYER[(py & 3) * 4 + (px & 3)].
const BAYER = Object.freeze([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);

function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

// Output transfer (RenderConfig.outGamma, docs/OLED.md §O9): code = c^gamma, applied to the
// clamped channel before the dither. A 257-entry float32 table (entries computed in double, then
// rounded, like the §4.4 tables) plus a lerp, so the firmware needs no per-pixel powf and both
// sides use the same table. gamma is taken as its float32 value (C++ RenderConfig.outGamma).
export const OUT_LUT_N = 256;
const outLutCache = new Map();

/** The transfer table for `gamma` (cached), or null for gamma 1 (no transfer: the LCD path). */
export function outTransferLut(gamma = 1) {
  const g = Math.fround(gamma);
  if (g === 1) return null;
  let lut = outLutCache.get(g);
  if (!lut) {                                              // C++: outTransferLut() (color.cpp)
    lut = new Float32Array(OUT_LUT_N + 1);
    for (let i = 0; i <= OUT_LUT_N; i++) lut[i] = Math.pow(i / OUT_LUT_N, g);
    outLutCache.set(g, lut);
  }
  return lut;
}

// x in [0, 1] (or NaN, which stays NaN and quantizes to 0) -> lut lerp; exact 0 -> 0, 1 -> 1.
function outTransfer(x, lut) {
  const s = x * OUT_LUT_N;
  const i = s | 0;
  if (i >= OUT_LUT_N) return lut[OUT_LUT_N];
  const f = s - i;
  return lut[i] + (lut[i + 1] - lut[i]) * f;
}

/**
 * Ordered-dither quantization to native-order RGB565. Exact black always yields 0x0000.
 * @param {{r:number,g:number,b:number}} c float sRGB
 * @param {number} px pixel x (dither phase)
 * @param {number} py pixel y (dither phase)
 * @param {Float32Array|null} [lut] output transfer (outTransferLut); null = none
 */
export function quantize565(c, px, py, lut = null) {
  const t = (BAYER[((py & 3) << 2) | (px & 3)] + 0.5) / 16;
  let r = clamp01(c.r), g = clamp01(c.g), b = clamp01(c.b);
  if (lut) { r = outTransfer(r, lut); g = outTransfer(g, lut); b = outTransfer(b, lut); }
  // (int) truncation == floor here because every argument is >= 0 (NaN -> 0).
  const R = Math.min(31, (r * 31 + t) | 0);
  const G = Math.min(63, (g * 63 + t) | 0);
  const B = Math.min(31, (b * 31 + t) | 0);
  return (R << 11) | (G << 5) | B;
}

/** Byte swap of a 16-bit value (wire order), as firmware swap565. */
export function swap565(c) { return ((c & 0xFF) << 8) | ((c >>> 8) & 0xFF); }

/** Native RGB565 -> [r, g, b] 8-bit, with bit replication. */
export function rgb565To888(c) {
  const R = (c >>> 11) & 0x1F, G = (c >>> 5) & 0x3F, B = c & 0x1F;
  return [(R << 3) | (R >> 2), (G << 2) | (G >> 4), (B << 3) | (B >> 2)];
}
