// Deterministic RNG (DESIGN.md §6.2). Same method names and draw semantics as the
// C++ class Rng in firmware/src/rng.h. Each method makes exactly the draws listed
// in §6.2, in that order; callers own the draw-order rule. DOM-free ES module.

const DEFAULT_SEED = 0x1234567;

export class Rng {
  /** @param {number} seed uint32; 0 is replaced by 0x1234567 (xorshift32 must not be 0). */
  constructor(seed = DEFAULT_SEED) {
    this._x = DEFAULT_SEED;
    this.seed(seed);
  }

  seed(s) {
    s = s >>> 0;
    this._x = s === 0 ? DEFAULT_SEED : s;
  }

  /** xorshift32 step; returns the new uint32 state. */
  nextU32() {
    let x = this._x;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this._x = x;
    return x;
  }

  /** [0, 1): nextU32() / 2^32. */
  next() { return this.nextU32() / 4294967296; }

  uniform(a, b) { return a + (b - a) * this.next(); }

  logUniform(a, b) { return a * Math.exp(this.next() * Math.log(b / a)); }

  logNormal(median, sigma) { return median * Math.exp(sigma * this.gauss()); }

  /** Box-Muller; draws u1 then u2. */
  gauss() {
    const u1 = this.next();
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(Math.max(u1, 1e-12))) * Math.cos(2 * Math.PI * u2);
  }

  chance(p) { return this.next() < p; }

  /**
   * First i whose cumulative weight exceeds next() * sum (sums in double).
   * Returns -1 without drawing when sum <= 0.
   * @param {ArrayLike<number>} w
   * @param {number} [n=w.length]
   */
  pickWeighted(w, n = w.length) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += w[i];
    if (!(sum > 0)) return -1;
    const r = this.next() * sum;
    let acc = 0;
    let last = -1;
    for (let i = 0; i < n; i++) {
      acc += w[i];
      if (w[i] > 0) last = i;
      if (acc > r) return i;
    }
    return last; // unreachable with non-negative weights (r < sum); guards rounding
  }
}
