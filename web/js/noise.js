// Integer hash and value noise (DESIGN.md §4.4). The integer hash is bit-exact with
// firmware/src/noise.h; all integer math is 32-bit wrapping (Math.imul, |0, >>>).
// DOM-free ES module.

import { floorToInt } from './mathutil.js?v=fdf99b96fa';

/** Hash an int32 to [0, 1] (16-bit resolution). */
export function hash01(i) {
  let h = Math.imul(i | 0, 0x9E3779B1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85EBCA77);
  h ^= h >>> 13;
  return (h & 0xFFFF) / 65535;
}

/** Combine a lattice index and a seed: int32(uint32(i) + uint32(s) * 7919), wrapping. */
export function hkey(i, s) { return (i + Math.imul(s, 7919)) | 0; }

/** Smooth 1D value noise in [0, 1]. */
export function vnoise(x, seed) {
  const i = floorToInt(x);
  const f = x - i;
  const w = f * f * (3 - 2 * f);
  const a = hash01(hkey(i, seed));
  const b = hash01(hkey(i + 1, seed));
  return a + (b - a) * w;
}

/** Value noise periodic in x with integer period P >= 1. */
export function vnoiseP(x, P, seed) {
  const i = floorToInt(x);
  const f = x - i;
  const w = f * f * (3 - 2 * f);
  let i0 = i % P;                     // one remainder: i0 = i mod P, i1 = (i + 1) mod P (exact)
  if (i0 < 0) i0 += P;
  const i1 = (i0 + 1 === P) ? 0 : i0 + 1;
  const a = hash01(hkey(i0, seed));
  const b = hash01(hkey(i1, seed));
  return a + (b - a) * w;
}
