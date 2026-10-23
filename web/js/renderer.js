// Procedural eye renderer (DESIGN.md §4; reference implementation).
//
// The firmware renderer (firmware/src/renderer.cpp) is a line-for-line port of this file,
// so the code is deliberately written in a C-like style:
//   - EyeUniforms is a plain object whose fields map 1:1 to the C++ struct EyeUniforms;
//     prepareEye() fills every field once per eye per frame.
//   - Per-pixel code uses no division by frame constants: every reciprocal is precomputed
//     in prepareEye (§3.4.1 a); exponentials come from the §4.4 float32 tables (§3.4.1 b);
//     renderRect culls with rowSpan and advances (ex, ey) incrementally (§3.4.1 a, d);
//     the halo is evaluated only when alpha < 1 and the fill only when alpha > 0 (§3.4.1 e).
//   - Exact early-outs (§3.4.1 i): the cluster bead Chebyshev bound, the catch-light / bead-glint
//     squared-distance tests and the Round pupil's reuse of |(ix, iy)| skip only work whose result
//     is provably unchanged (they rely on len() being a correctly rounded sqrt).
//   - Colors are {r, g, b} float sRGB objects (C++ RGBf).
// JS computes in double; the firmware in float32. Parity tolerance: §10.4 (§12 R17).
//
// DOM-free ES module (§7.1): importable from the browser and from Node tools.

import { OutlineType, FillMode, PupilType, BlinkKind, GazeKind, PANEL_PX, R_DISP_MM } from './constants.js?v=fdf99b96fa';
import { clamp, lerp, len, fract, floorToInt, lerpRGB, mulRGB, grad3, aNorm } from './mathutil.js?v=fdf99b96fa';
import { hash01, hkey, vnoise, vnoiseP } from './noise.js?v=fdf99b96fa';
import { quantize565, outTransferLut } from './color.js?v=fdf99b96fa';
import { outlineRb, outlineExtents } from './styles.js?v=fdf99b96fa';

// Panel geometry comes from RenderConfig {spacingMm, panelPx, rDispMm} (docs/OLED.md §O4;
// defaults PANEL_PX / R_DISP_MM). prepareEye stores it in EyeUniforms: halfPx = panelPx/2 (panel
// radius in pixels), aa = 1/halfPx (one pixel in display units); the per-pixel code reads u only.
// RenderConfig.outGamma (default 1) selects the output transfer table u.outLut that quantize565
// applies (OLED: 2.2, docs/OLED.md §O9); at 1 it is null and the output is unchanged bit for bit.

// Constant-edge smoothstep reciprocals (§3.4.1 a).
const INV_SPIRAL_EDGE = 1 / 0.04;    // Spiral: (tri - 0.25)/0.04
const INV_VEIN_LINE = 1 / 0.08;      // veinAmount: smoothstep(0, 0.08, |fs - 0.5|)
const INV_VEIN_FADE = 1 / 0.33;      // veinAmount: smoothstep(irisR + 0.02, irisR + 0.35, ri)
const INV_VEIN_EX = 1 / 0.5;         // veinAmount: (|ex| - 0.15)/0.5
const VIGNETTE_R0 = 0.81;            // panel-edge vignette on rr = u² + v² (§4.7)
const INV_VIGNETTE = 1 / (0.96 - 0.81);

// ---------------------------------------------------------------------------------
// §4.4 constant tables: float32, entries computed in double then rounded (Float32Array).

export const GLOW_N = 256;
export const GLOW_TABLE = new Float32Array(GLOW_N + 1);   // G
export const EXP_TABLE = new Float32Array(GLOW_N + 1);    // X

(function buildTables() {                                  // C++: rendererInit()
  const E = Math.exp(-2.5);
  for (let i = 0; i < GLOW_N; i++) {
    GLOW_TABLE[i] = Math.pow((Math.exp(-2.5 * i / 256) - E) / (1 - E), 1 / 2.2);
    EXP_TABLE[i] = Math.exp(-8 * i / 256);
  }
  GLOW_TABLE[GLOW_N] = 0;
  EXP_TABLE[GLOW_N] = 0;
})();

/** Halo falloff, t = d/reach >= 0; luminance falls as a normalized exp(-2.5 t); 0 at t >= 1. */
export function glowShape(t) {
  if (t >= 1) return 0;
  const x = t * 256;
  const i = x | 0;                    // (int)x, x >= 0
  const f = x - i;
  return GLOW_TABLE[i] + (GLOW_TABLE[i + 1] - GLOW_TABLE[i]) * f;
}

/** ≈ exp(-s) for s >= 0; exactly 0 for s >= 8. */
export function expNeg(s) {
  if (s >= 8) return 0;
  const x = s * 32;
  const i = x | 0;
  const f = x - i;
  return EXP_TABLE[i] + (EXP_TABLE[i + 1] - EXP_TABLE[i]) * f;
}

// Debug mode: assert that no NaN/Infinity reaches the quantizer (§10.2 a).
let debugChecks = false;
export function setRendererDebug(on) { debugChecks = !!on; }

// ---------------------------------------------------------------------------------
// EyeUniforms (C++ struct EyeUniforms). Every value prepareEye stores; callers treat the
// fields as private. Field order follows the C++ declaration.

const BLACK = Object.freeze({ r: 0, g: 0, b: 0 });

/** A zeroed EyeUniforms (empty: renders black). Reuse one per eye to avoid allocation. */
export function createEyeUniforms() {
  return {
    empty: true,
    // --- frame / transform ---
    m: 1,                                  // mirror factor: +1 L, -1 R
    cx: 0, cy: 0,                          // eye center, display units (screen sense, +v up)
    cphi: 1, sphi: 0,                      // cos/sin of φ = rot + m·headTilt
    row0x: 1, row0y: 0, row1x: 0, row1y: 1, // (ex, ey) = [row0; row1]·(u - cx, v - cy)
    panelPx: PANEL_PX,                     // panel width/height in pixels (RenderConfig.panelPx)
    halfPx: PANEL_PX / 2,                  // panel radius in pixels (1.0 display unit)
    aa: 1 / (PANEL_PX / 2),                // one pixel in display units (1/halfPx)
    outLut: null,                          // output transfer table (RenderConfig.outGamma); null = none
    k: 1,                                  // eye-local distance -> display units
    kp: PANEL_PX / 2,                      // eye-local distance -> pixels (k·halfPx)
    pX: 0, pY: 0,                          // pupil offset, eye-local
    inten: 1,                              // brightness multiplier
    // --- outline ---
    outlineType: OutlineType.Circle,
    oW: 0, oH: 0, oInvW: 0, oInvH: 0, oMinWH: 0, oCorner: 0, oRing: 0,
    vesSwap: false, vesW: 0, vesC: 0, vesR: 0,                  // outline sdVesica constants
    triQx: 0, triQy: 0, triInvQQ: 0, triInvQx: 0,               // sdTriangle constants
    moonRa: 0, moonRb: 0, moonD: 0, moonA: 0, moonB: 0,          // sdMoon constants
    beadCount: 0,
    beadX: [0, 0, 0, 0], beadY: [0, 0, 0, 0], beadR: [0, 0, 0, 0],
    beadInvR: [0, 0, 0, 0],
    beadGain: [1, 1, 1, 1],
    // --- lids: yU(x) = AU - BU·x - CU·x², yL(x) = AL - BL·x + CL·x² ---
    lidsEnabled: false,
    AU: 0, BU: 0, CU: 0, nU: 1, AL: 0, BL: 0, CL: 0, nL: 1,
    // --- glow ---
    reach: 0, reachAA: 0, invReach: 0, gainEff: 0,
    // --- blink ---
    blinkKind: BlinkKind.None,
    xm: Infinity,                          // membrane edge (covered: ex > xm)
    membraneAlpha: 0,
    // --- fill ---
    fillMode: FillMode.Iris,
    seed: 0,
    irisR: 0, invIrisR: 0,
    sclera: false, scleraCol: BLACK,
    limbal: 0, invLimbal: 0,
    texSpokes: 0, texAmp: 0, texRadFreq: 0, texPhase: 0,
    veins: 0, veinCount: 18, veinFadeE0: 0,
    spiralArms: 2, spiralTwist: 0, spinPhase: 0,
    hotCx: 0, hotCy: 0, invHotR: 0,
    invRimW: 0,
    edgeRing: 0, invEdgeRing: 0, edgeK: 0,
    scanBx: 0, scanDir: 1, invScanBarW: 0, invScanTrail: 0,
    // --- palette ---
    core: BLACK, mid: BLACK, rim: BLACK, accent: BLACK, highlightCol: BLACK, glowCol: BLACK,
    // --- highlight (catch-light) ---
    hlR: 0, hlAlpha: 0, hlX: 0, hlY: 0, hx0: 0, hy0: 0,
    hlT2: 0,                               // squared skip radius of the catch-light
    beadHlT2: [0, 0, 0, 0],                // squared skip radii of the bead glints
    // --- pupil ---
    pupilType: PupilType.None,
    psize: 0, pupilCol: BLACK,
    levelOn: false, levelC: 1, levelS: 0,  // Rot(levelAng)
    slitSwap: false, slitW: 0, slitC: 0, slitR: 0,               // pupil sdVesica constants
    barW: 0, barH: 0, barCr: 0,                                  // pupil sdRoundBox
    // --- bounds (pixels, x1/y1 exclusive) and row-span half-extents ---
    bx0: 0, by0: 0, bx1: 0, by1: 0,
    spanAx: 0, spanAy: 0,
  };
}

// sdVesica constants for (w, h) (§4.5): swap to the horizontal form, then c and R.
function setVesica(w, h) {
  const swap = h > w;
  const W = swap ? h : w;
  const H = swap ? w : h;
  const q = W * W / H;
  return { swap, w: W, c: (q - H) / 2, R: (q + H) / 2 };
}

/**
 * Per-frame preparation (§4.6). Fills and returns `u` (a new EyeUniforms if omitted).
 * @param {object} style normalized style (styles.js)
 * @param {object} es EyeState (§4.2 field names)
 * @param {number} side 0 = L, 1 = R
 * @param {{spacingMm:number, panelPx?:number, rDispMm?:number, outGamma?:number}} rc RenderConfig
 *   (panelPx defaults to PANEL_PX, rDispMm to R_DISP_MM, outGamma to 1)
 * @param {object} [u] EyeUniforms to reuse
 */
export function prepareEye(style, es, side, rc, u = createEyeUniforms()) {
  const S = style;
  const O = S.outline;
  const m = side === 0 ? 1 : -1;
  u.m = m;

  // Panel geometry.
  const panelPx = rc.panelPx ?? PANEL_PX;
  const rDispMm = rc.rDispMm ?? R_DISP_MM;
  const halfPx = panelPx / 2;
  const AA = 1 / halfPx;
  u.panelPx = panelPx; u.halfPx = halfPx; u.aa = AA;
  u.outLut = outTransferLut(rc.outGamma ?? 1);

  // Pair geometry and head tilt (rotation of the pair about the world midpoint).
  const Dh = (rc.spacingMm / 2) / rDispMm;
  const Dc = side === 0 ? -Dh : Dh;
  const th = es.headTilt;
  let cx = m * (O.medialOffset + es.medialAdj) + es.headDx + Dc * (Math.cos(th) - 1);
  let cy = O.centerY + es.headDy + Dc * Math.sin(th);
  const phi = O.rot + m * th;
  const cphi = Math.cos(phi);
  const sphi = Math.sin(phi);
  u.cphi = cphi; u.sphi = sphi;

  // Gaze -> pupil offset (eye-local) or whole-eye translation (screen).
  let pX = 0, pY = 0;
  if (S.gaze.kind === GazeKind.Pupil) {
    const a = m * es.gazeX * S.gaze.rangeX;           // toLocal(a, b)
    const b = es.gazeY * S.gaze.rangeY;
    pX = cphi * a + sphi * b + es.vergence;
    pY = -sphi * a + cphi * b;
  } else if (S.gaze.kind === GazeKind.Whole) {
    cx += es.gazeX * S.gaze.rangeX + m * es.vergence;
    cy += es.gazeY * S.gaze.rangeY;
  }
  u.cx = cx; u.cy = cy; u.pX = pX; u.pY = pY;

  // Blink kind.
  const bl = es.blink;
  let sx = 1, sy = 1, inten = es.intensity, o = es.openness;
  for (let i = 0; i < 4; i++) u.beadGain[i] = 1;
  switch (S.blink.kind) {
    case BlinkKind.Lid:
      o = es.openness * (1 - bl);
      break;
    case BlinkKind.Fade:
      inten *= (1 - bl);
      break;
    case BlinkKind.Squash:
      sy = lerp(1, 0.08, bl);
      inten *= (bl < 0.8) ? (1 - 0.5 * bl) : 0.6 * (1 - bl) / 0.2;   // continuous at 0.8, 0 at b = 1
      break;
    case BlinkKind.Crt:
      if (bl < 0.5) { sy = lerp(1, 0.03, 2 * bl); } else { sy = 0.03; sx = lerp(1, 0.03, 2 * bl - 1); }
      inten *= (bl < 0.85) ? (1 + 0.4 * bl) : (1.34 * (1 - bl) / 0.15);
      break;
    case BlinkKind.Ripple:
      for (let i = 0; i < 4; i++) u.beadGain[i] = 1 - 0.9 * clamp((bl - 0.15 * i) / 0.55, 0, 1);
      break;
    default:                                            // None, Membrane (xm below)
      break;
  }
  u.blinkKind = S.blink.kind;
  u.inten = inten;

  const sc = es.scale;
  const k = sc * Math.max(sx, sy);
  u.k = k;
  u.kp = k * halfPx;
  const Rb = outlineRb(O, true);
  u.xm = (S.blink.kind === BlinkKind.Membrane) ? lerp(Rb + 2 * AA / k, -Rb - 2 * AA / k, bl) : Infinity;
  u.membraneAlpha = S.fx.membraneAlpha;

  // (ex, ey) = diag(1/(sc·sx), 1/(sc·sy)) · Rot(-φ) · diag(m, 1) · (u - cx, v - cy)
  const isx = 1 / (sc * sx);
  const isy = 1 / (sc * sy);
  u.row0x = m * cphi * isx; u.row0y = sphi * isx;
  u.row1x = -m * sphi * isy; u.row1y = cphi * isy;

  // Outline constants.
  u.outlineType = O.type;
  u.oW = O.w; u.oH = O.h;
  u.oInvW = 1 / O.w; u.oInvH = 1 / O.h; u.oMinWH = Math.min(O.w, O.h);
  u.oCorner = O.corner; u.oRing = O.ring;
  if (O.type === OutlineType.Vesica) {
    const V = setVesica(O.w, O.h);
    u.vesSwap = V.swap; u.vesW = V.w; u.vesC = V.c; u.vesR = V.R;
  }
  if (O.type === OutlineType.Triangle) {
    u.triQx = O.w; u.triQy = -2 * O.h;
    u.triInvQQ = 1 / (u.triQx * u.triQx + u.triQy * u.triQy);
    u.triInvQx = 1 / u.triQx;
  }
  if (O.type === OutlineType.Moon) {
    const ra = O.w, rb = O.h, d = O.d;
    u.moonRa = ra; u.moonRb = rb; u.moonD = d;
    u.moonA = (ra * ra - rb * rb + d * d) / (2 * d);
    u.moonB = Math.sqrt(Math.max(ra * ra - u.moonA * u.moonA, 0));
  }
  u.beadCount = O.type === OutlineType.Cluster ? O.beadCount : 0;
  for (let i = 0; i < 4; i++) {
    const bd = i < u.beadCount ? O.beads[i] : null;
    u.beadX[i] = bd ? bd.x : 0;
    u.beadY[i] = bd ? bd.y : 0;
    u.beadR[i] = bd ? bd.r : 0;
    u.beadInvR[i] = bd ? 1 / bd.r : 0;
  }

  // Lids (only if enabled).
  const L = S.lids;
  u.lidsEnabled = L.enabled;
  const oc = clamp(o, 0, 1.25);
  if (L.enabled) {
    const Uo = L.upper + L.trackU * pY;
    const Lo = L.lower + L.trackL * pY;
    const ymeet = Lo + 0.25 * (Uo - Lo);
    const g = 0.02;
    u.AU = (ymeet - g) * (1 - oc) + oc * Uo; u.BU = oc * L.tiltU; u.CU = oc * L.curvU;
    u.nU = 1 / Math.sqrt(1 + u.BU * u.BU);
    u.AL = (ymeet + g) * (1 - oc) + oc * Lo; u.BL = oc * L.tiltL; u.CL = oc * L.curvL;
    u.nL = 1 / Math.sqrt(1 + u.BL * u.BL);
  } else {
    u.AU = 0; u.BU = 0; u.CU = 0; u.nU = 1; u.AL = 0; u.BL = 0; u.CL = 0; u.nL = 1;
  }

  // Glow.
  const openF = L.enabled ? Math.sqrt(clamp(o, 0, 1)) : 1;   // o already includes the Lid blink
  const sigmaD = S.glow.sigma * sc;
  const reach = 2.5 * sigmaD;
  u.reach = reach;
  u.reachAA = reach + AA;
  u.invReach = 1 / reach;
  u.gainEff = S.glow.gain * es.glowGain * openF;

  // Fill constants.
  const F = S.fill;
  u.fillMode = F.mode;
  u.seed = S.seed;
  u.irisR = F.irisR; u.invIrisR = 1 / F.irisR;
  u.sclera = F.sclera;
  u.scleraCol = mulRGB(S.pal.sclera, F.scleraLevel);
  u.limbal = F.limbal; u.invLimbal = F.limbal > 0 ? 1 / F.limbal : 0;
  u.texSpokes = F.texSpokes; u.texAmp = F.texAmp; u.texRadFreq = F.texRadFreq;
  u.texPhase = es.texPhase;
  u.veins = F.veins; u.veinCount = F.veinCount; u.veinFadeE0 = F.irisR + 0.02;
  u.spiralArms = F.spiralArms; u.spiralTwist = F.spiralTwist; u.spinPhase = es.spinPhase;
  u.hotCx = F.hotX + pX; u.hotCy = F.hotY + pY; u.invHotR = 1 / F.hotR;
  u.invRimW = 1 / F.rimW;
  u.edgeRing = F.edgeRing; u.invEdgeRing = F.edgeRing > 0 ? 1 / F.edgeRing : 0;
  u.edgeK = 0.9 * clamp(es.glowGain, 0, 1.5) / 1.5;
  u.invScanBarW = 1 / F.scanBarW; u.invScanTrail = 1 / F.scanTrail;

  // Palette.
  u.core = S.pal.core; u.mid = S.pal.mid; u.rim = S.pal.rim; u.accent = S.pal.accent;
  u.highlightCol = S.pal.highlight; u.glowCol = S.pal.glow;

  // Highlight (catch-light): screen-sense offset rotated into eye-local.
  const ha = m * S.highlight.x, hb = S.highlight.y;
  u.hx0 = cphi * ha + sphi * hb;
  u.hy0 = -sphi * ha + cphi * hb;
  u.hlX = u.hx0 + 0.3 * pX;
  u.hlY = u.hy0 + 0.3 * pY;
  u.hlR = S.highlight.r; u.hlAlpha = S.highlight.alpha;
  // Squared skip radii of the catch-light and the bead glints: at |q| >= hlR + 0.5/kp the weight
  // clamp(0.5 - dH*kp) is exactly 0. The AA term 0.5/kp is not scaled by the bead radius. The 1e-5
  // eye-unit margin (~1e-3 px) keeps the float32 test (C++) strictly conservative.
  const hlEdge = u.kp > 0 ? 0.5 / u.kp : Infinity;
  const hlT = u.hlR + hlEdge + 1e-5;
  u.hlT2 = hlT * hlT;
  for (let i = 0; i < 4; i++) {
    const bt = u.hlR * u.beadR[i] + hlEdge + 1e-5;
    u.beadHlT2[i] = bt * bt;
  }

  // Pupil.
  const P = S.pupil;
  u.pupilType = P.type;
  u.psize = lerp(P.pMin, P.pMax, es.pupil);
  u.pupilCol = lerpRGB(S.pal.pupil, S.pal.accent, P.shine * es.pupil);
  const levelAng = P.level ? phi : 0;
  u.levelOn = levelAng !== 0;
  u.levelC = Math.cos(levelAng); u.levelS = Math.sin(levelAng);
  if (P.type === PupilType.Slit) {
    const V = setVesica(u.psize, P.h);
    u.slitSwap = V.swap; u.slitW = V.w; u.slitC = V.c; u.slitR = V.R;
  }
  if (P.type === PupilType.Bar) {
    u.barW = u.psize;
    u.barH = u.psize * P.aspect;
    u.barCr = Math.min(0.04, u.barH);
  }

  // Scanner beam (world mm -> display units -> eye-local x).
  const Xc = side === 0 ? -rc.spacingMm / 2 : rc.spacingMm / 2;
  const uB = (es.scanXmm - Xc) / rDispMm;
  u.scanBx = u.row0x * (uB - cx);
  u.scanDir = m * es.scanDir;

  // Empty test and conservative bounds.
  u.empty = (inten <= 0.002) || (L.enabled && oc <= 0);
  const ext = outlineExtents(O);
  const f = (O.type === OutlineType.Ellipse) ? Math.max(O.w, O.h) / Math.min(O.w, O.h) : 1;
  const mg = (reach + 2 * AA) * f;                     // f compensates the sdEllipse underestimate
  const Ax = sc * sx * ext.Ex;
  const Ay = sc * sy * ext.Ey;
  const acp = Math.abs(cphi), asp = Math.abs(sphi);
  const hx = acp * Ax + asp * Ay + mg;
  const hy = asp * Ax + acp * Ay + mg;
  u.spanAx = Ax + mg;
  u.spanAy = Ay + mg;
  u.bx0 = clampPx(Math.floor(halfPx + halfPx * (cx - hx)) - 1, panelPx);
  u.bx1 = clampPx(Math.ceil(halfPx + halfPx * (cx + hx)) + 1, panelPx);
  u.by0 = clampPx(Math.floor(halfPx - halfPx * (cy + hy)) - 1, panelPx);
  u.by1 = clampPx(Math.ceil(halfPx - halfPx * (cy - hy)) + 1, panelPx);
  return u;
}

function clampPx(x, n) { return x < 0 ? 0 : (x > n ? n : x); }

/** Conservative bbox of all non-black pixels {x0, y0, x1, y1} (x1/y1 exclusive); all 0 when empty. */
export function eyeBounds(u) {
  if (u.empty) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0: u.bx0, y0: u.by0, x1: u.bx1, y1: u.by1 };
}

/**
 * Conservative x-interval [sx0, sx1) of possibly non-black pixels on row py (§4.7).
 * Returns [0, 0] when the row is empty. Ignores u.empty (renderRect checks it).
 */
export function rowSpan(u, py) {
  const dv = (u.halfPx - (py + 0.5)) * u.aa - u.cy;
  let lo = -Infinity, hi = Infinity;
  for (let j = 0; j < 2; j++) {                        // |a·du + b| <= A for both eye-frame axes
    const a = j === 0 ? u.m * u.cphi : -u.m * u.sphi;
    const b = j === 0 ? u.sphi * dv : u.cphi * dv;
    const A = j === 0 ? u.spanAx : u.spanAy;
    if (Math.abs(a) < 1e-6) {
      if (Math.abs(b) > A) return [0, 0];
      continue;
    }
    const t1 = (-A - b) / a;
    const t2 = (A - b) / a;
    lo = Math.max(lo, Math.min(t1, t2));
    hi = Math.min(hi, Math.max(t1, t2));
  }
  if (lo >= hi) return [0, 0];
  const sx0 = Math.floor(u.halfPx + u.halfPx * (u.cx + lo) - 0.5) - 1;
  const sx1 = Math.ceil(u.halfPx + u.halfPx * (u.cx + hi) - 0.5) + 2;
  return [clampPx(sx0, u.panelPx), clampPx(sx1, u.panelPx)];
}

// ---------------------------------------------------------------------------------
// Signed distance functions (§4.5; eye-local, negative inside). Frame constants come
// precomputed from EyeUniforms.

function sdVesicaPre(x, y, swap, w, c, R) {
  let ax = Math.abs(x), ay = Math.abs(y);
  if (swap) { const t = ax; ax = ay; ay = t; }         // vertical slit form
  if ((ax - w) * c > ay * w) return len(ax - w, ay);
  return len(ax, ay + c) - R;
}

function sdTrianglePre(u, x, y) {
  const qx = u.triQx, qy = u.triQy;
  const px = Math.abs(x);
  const py = y - u.oH;
  const t1 = clamp((px * qx + py * qy) * u.triInvQQ, 0, 1);
  const ax = px - qx * t1, ay = py - qy * t1;
  const t2 = clamp(px * u.triInvQx, 0, 1);
  const bx = px - qx * t2, by = py - qy;
  const dd = Math.min(ax * ax + ay * ay, bx * bx + by * by);
  const sg = Math.min(px * qy - py * qx, py - qy);
  return -Math.sqrt(dd) * (sg > 0 ? 1 : (sg < 0 ? -1 : 0)) - u.oCorner;
}

function sdMoonPre(u, x, y) {
  const X = -y, Y = Math.abs(x);                       // IQ frame: bite toward +X (below)
  const d = u.moonD, a = u.moonA, b = u.moonB;
  if (d * (X * b - Y * a) > d * d * Math.max(b - Y, 0)) return len(X - a, Y - b);
  return Math.max(len(X, Y) - u.moonRa, -(len(X - d, Y) - u.moonRb));
}

function sdRoundBox(x, y, w, h, cr) {
  const qx = Math.abs(x) - w + cr;
  const qy = Math.abs(y) - h + cr;
  return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - cr;
}

// Outline + lid aperture at an eye-local point. Writes {dOut, iBead, dAp} into `hit`
// (C++: a small struct on the caller's stack, so both render cores stay independent).
function aperture(u, ex, ey, hit) {
  let dOut;
  let iBead = 0;
  let bLen = 0;
  switch (u.outlineType) {
    case OutlineType.Circle:
      dOut = len(ex, ey) - u.oW;
      break;
    case OutlineType.Ellipse:
      dOut = (len(ex * u.oInvW, ey * u.oInvH) - 1) * u.oMinWH;
      break;
    case OutlineType.Vesica:
      dOut = sdVesicaPre(ex, ey, u.vesSwap, u.vesW, u.vesC, u.vesR);
      break;
    case OutlineType.Triangle:
      dOut = sdTrianglePre(u, ex, ey);
      break;
    case OutlineType.Moon:
      dOut = sdMoonPre(u, ex, ey);
      break;
    case OutlineType.RoundBox:
      dOut = sdRoundBox(ex, ey, u.oW, u.oH, u.oCorner);
      break;
    default: {                                         // Cluster: min over beads, argmin for every pixel
      // max(|dx|, |dy|) - r is a lower bound of len - r (correctly rounded sqrt, monotone rounding),
      // so a bead whose bound is already >= dOut cannot win the strict '<': skipping it is exact.
      dOut = Infinity;
      for (let i = 0; i < u.beadCount; i++) {
        const dx = ex - u.beadX[i], dy = ey - u.beadY[i];
        if (Math.max(Math.abs(dx), Math.abs(dy)) - u.beadR[i] >= dOut) continue;
        const l = len(dx, dy);
        const di = l - u.beadR[i];
        if (di < dOut) { dOut = di; iBead = i; bLen = l; }
      }
      break;
    }
  }
  if (u.oRing > 0) dOut = Math.abs(dOut) - u.oRing;

  let dAp = dOut;
  if (u.lidsEnabled) {
    const dU = (ey - (u.AU - u.BU * ex - u.CU * ex * ex)) * u.nU;
    const dL = ((u.AL - u.BL * ex + u.CL * ex * ex) - ey) * u.nL;
    dAp = Math.max(dAp, dU, dL);
  }
  hit.dOut = dOut;
  hit.iBead = iBead;
  hit.dAp = dAp;
  hit.bLen = bLen;
}

const HIT = { dOut: 0, iBead: 0, dAp: 0, bLen: 0 };   // JS scratch (single-threaded); bLen: Cluster |e - bead[iBead]|

// ---------------------------------------------------------------------------------
// Per-pixel shading (§4.7).

/** Native RGB565 of pixel (px, py). */
export function shadePixel(u, px, py) {
  if (u.empty) return 0;
  const uu = (px + 0.5 - u.halfPx) * u.aa;
  const vv = (u.halfPx - (py + 0.5)) * u.aa;
  const dx = uu - u.cx, dy = vv - u.cy;
  const ex = u.row0x * dx + u.row0y * dy;
  const ey = u.row1x * dx + u.row1y * dy;
  return shadeLocal(u, ex, ey, uu * uu + vv * vv, px, py);
}

// Shade an eye-local point; rr = u² + v² (screen) for the vignette; (px, py) for the dither.
function shadeLocal(u, ex, ey, rr, px, py) {
  aperture(u, ex, ey, HIT);
  const dOut = HIT.dOut, iBead = HIT.iBead, bLen = HIT.bLen;
  const dA = HIT.dAp * u.k;                                     // display units
  if (dA >= u.reachAA) return 0;                                // fast path (exact black)
  const alpha = clamp(0.5 - dA * u.halfPx, 0, 1);               // aperture coverage
  let col;
  if (alpha >= 1) {
    col = styleFill(u, ex, ey, dOut, iBead, bLen);              // exact: lerp(halo, fill, 1) = fill
  } else {
    let halo = mulRGB(u.glowCol, u.gainEff * glowShape(Math.max(dA, 0) * u.invReach));
    if (u.fillMode === FillMode.Beads) halo = mulRGB(halo, u.beadGain[iBead]);   // ripple dims the glow too
    col = (alpha <= 0) ? halo : lerpRGB(halo, styleFill(u, ex, ey, dOut, iBead, bLen), alpha);
  }
  col = mulRGB(col, u.inten);
  if (rr > VIGNETTE_R0) col = mulRGB(col, 1 - ss(VIGNETTE_R0, INV_VIGNETTE, rr));   // panel-edge vignette
  if (debugChecks && !(Number.isFinite(col.r) && Number.isFinite(col.g) && Number.isFinite(col.b))) {
    throw new Error(`renderer: non-finite color at (${px}, ${py}): ${JSON.stringify(col)}`);
  }
  return quantize565(col, px, py, u.outLut);
}

// smoothstep with a precomputed 1/(e1 - e0).
function ss(e0, inv, x) {
  const t = clamp((x - e0) * inv, 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------------
// Fill models (§4.8).

// bLen: the Beads fill reuses the winning bead's length from aperture() (HIT.bLen).
function styleFill(u, ex, ey, dOut, iBead, bLen) {
  let col;
  const ix = ex - u.pX, iy = ey - u.pY;
  switch (u.fillMode) {
    case FillMode.Iris: {
      const ri = len(ix, iy);
      const rN = ri * u.invIrisR;
      let aN = 0;
      if (u.texSpokes > 0 || u.veins > 0) aN = aNorm(iy, ix);
      let tIdx = Math.min(rN, 1);
      if (u.texSpokes > 0) {
        const n1 = vnoiseP(aN * u.texSpokes, u.texSpokes, u.seed);
        let tv;
        if (u.texRadFreq > 0) {
          const n2 = vnoiseP((Math.min(rN, 1.5) - u.texPhase) * u.texRadFreq + 7 * n1, u.texRadFreq, u.seed + 1);
          tv = 0.5 * n1 + 0.5 * n2;
        } else {
          tv = n1;
        }
        tIdx = clamp(tIdx + u.texAmp * (tv - 0.5), 0, 1);
      }
      let irisCol = grad3(tIdx, u.core, u.mid, u.rim);
      if (u.limbal > 0) {
        const lim = 1 - ss(0, u.invLimbal, Math.abs(rN - 1));
        irisCol = mulRGB(irisCol, 1 - 0.6 * lim);
      }
      irisCol = applyPupil(u, irisCol, ix, iy, ri);
      if (u.sclera) {
        let scl = u.scleraCol;
        if (u.veins > 0) scl = lerpRGB(scl, u.accent, veinAmount(u, aN, ri, ex));
        const aI = clamp(0.5 - (ri - u.irisR) * u.kp, 0, 1);
        col = lerpRGB(scl, irisCol, aI);
      } else {
        col = irisCol;
      }
      break;
    }
    case FillMode.Spiral: {
      const ri = len(ix, iy);
      const aN = aNorm(iy, ix);
      const phs = fract(u.spiralArms * aN + u.spiralTwist * ri - u.spinPhase);
      const tri = Math.abs(phs - 0.5);
      const s = clamp((tri - 0.25) * INV_SPIRAL_EDGE + 0.5, 0, 1);
      col = lerpRGB(u.mid, u.core, s);
      col = applyPupil(u, col, ix, iy, ri);
      break;
    }
    case FillMode.Hotspot: {
      const t = clamp(len(ex - u.hotCx, ey - u.hotCy) * u.invHotR, 0, 1);
      col = grad3(t, u.core, u.mid, u.rim);
      break;
    }
    case FillMode.Beads: {                                      // outline is a cluster
      const bx = u.beadX[iBead], by = u.beadY[iBead], br = u.beadR[iBead], gain = u.beadGain[iBead];
      const t = clamp(bLen * u.beadInvR[iBead], 0, 1);
      col = mulRGB(grad3(t, u.core, u.mid, u.rim), gain);
      if (u.hlR > 0) {                                          // per-bead glint (bead-relative offset); weight exactly 0 beyond beadHlT2
        const qx = ex - (bx + u.hx0 * br), qy = ey - (by + u.hy0 * br);
        if (qx * qx + qy * qy < u.beadHlT2[iBead]) {
          const dH = len(qx, qy) - u.hlR * br;
          col = lerpRGB(col, u.highlightCol, clamp(0.5 - dH * u.kp, 0, 1) * u.hlAlpha * gain);
        }
      }
      return applyMembrane(u, col, ex);                         // skips edgeRing and the global highlight
    }
    case FillMode.Rim: {
      const t = clamp(1 + dOut * u.invRimW, 0, 1);              // 1 at the outline edge, 0 deep inside
      col = grad3(t, u.core, u.mid, u.rim);
      break;
    }
    default: {                                                  // Scanner
      const ddx = ex - u.scanBx;
      const q = ddx * u.invScanBarW;
      const gB = expNeg(q * q);
      const behind = -ddx * u.scanDir;
      const tr = behind > 0 ? 0.6 * expNeg(behind * u.invScanTrail) : 0;
      const I = Math.max(gB, tr);
      col = lerpRGB(u.rim, lerpRGB(u.mid, u.core, gB * gB), I);
      break;
    }
  }

  // Common post-steps (Beads skips both).
  if (u.edgeRing > 0) {
    const er = 1 - ss(0, u.invEdgeRing, -dOut);
    col = lerpRGB(col, u.accent, er * u.edgeK);
  }
  if (u.hlR > 0) {                                              // catch-light; weight exactly 0 beyond hlT2 (lerpRGB(col, hl, 0) == col)
    const qx = ex - u.hlX, qy = ey - u.hlY;
    if (qx * qx + qy * qy < u.hlT2) {
      const dH = len(qx, qy) - u.hlR;
      col = lerpRGB(col, u.highlightCol, clamp(0.5 - dH * u.kp, 0, 1) * u.hlAlpha);
    }
  }
  return applyMembrane(u, col, ex);
}

function applyMembrane(u, col, ex) {
  if (u.blinkKind !== BlinkKind.Membrane) return col;
  const aM = clamp(0.5 + (ex - u.xm) * u.kp, 0, 1);
  return lerpRGB(col, u.accent, aM * u.membraneAlpha);
}

// ri = |(ix, iy)| from the caller (Iris/Spiral): unrotated, it is exactly the Round pupil's length.
function applyPupil(u, col, ix, iy, ri) {
  if (u.pupilType === PupilType.None) return col;
  let jx = ix, jy = iy;
  if (u.levelOn) {                                              // Rot(levelAng)·(ix, iy): bar stays level
    jx = u.levelC * ix - u.levelS * iy;
    jy = u.levelS * ix + u.levelC * iy;
  }
  let dP;
  switch (u.pupilType) {
    case PupilType.Round: dP = (u.levelOn ? len(jx, jy) : ri) - u.psize; break;
    case PupilType.Slit: dP = sdVesicaPre(jx, jy, u.slitSwap, u.slitW, u.slitC, u.slitR); break;
    default: dP = sdRoundBox(jx, jy, u.barW, u.barH, u.barCr); break;    // Bar
  }
  return lerpRGB(col, u.pupilCol, clamp(0.5 - dP * u.kp, 0, 1));
}

function veinAmount(u, aN, ri, ex) {
  const n = u.veinCount;
  const s = aN * n + 0.8 * (vnoise(ri * 5, u.seed + 2) - 0.5);
  const fs = fract(s);
  const line = 1 - ss(0, INV_VEIN_LINE, Math.abs(fs - 0.5));
  const vi = ((floorToInt(s) % n) + n) % n;
  const present = hash01(hkey(vi, u.seed + 3)) > 0.4 ? 1 : 0;
  const fade = ss(u.veinFadeE0, INV_VEIN_FADE, ri) * clamp((Math.abs(ex) - 0.15) * INV_VEIN_EX, 0, 1);
  return u.veins * line * present * fade;
}

// ---------------------------------------------------------------------------------
// Debug / test access.

/**
 * Aperture coverage alpha of pixel (px, py) in [0, 1], or -1 when the pixel takes the
 * fast path (exact black) or the eye is empty. Used by the parity-vector classifier.
 */
export function pixelAlpha(u, px, py) {
  if (u.empty) return -1;
  const uu = (px + 0.5 - u.halfPx) * u.aa;
  const vv = (u.halfPx - (py + 0.5)) * u.aa;
  const dx = uu - u.cx, dy = vv - u.cy;
  const hit = { dOut: 0, iBead: 0, dAp: 0, bLen: 0 };
  aperture(u, u.row0x * dx + u.row0y * dy, u.row1x * dx + u.row1y * dy, hit);
  const dA = hit.dAp * u.k;
  if (dA >= u.reachAA) return -1;
  return clamp(0.5 - dA * u.halfPx, 0, 1);
}

// ---------------------------------------------------------------------------------
// Rectangle rendering.

/**
 * Render rows y0 + k (0 <= k < h, k % rowStep == rowPhase) of the rect into
 * out[k*w + (x - x0)], row-major, NATIVE RGB565 (§7.1; the firmware port writes
 * swap565(...) instead). Pixels outside rowSpan (and every pixel when empty) are 0.
 * (ex, ey) advance incrementally along the row (§3.4.1 a).
 * @param {Uint16Array} out at least w*h entries
 */
export function renderRect(u, x0, y0, w, h, out, rowPhase = 0, rowStep = 1) {
  const xEnd = x0 + w;
  const halfPx = u.halfPx, aa = u.aa;
  const dEx = u.row0x * aa;                         // d(ex)/d(px)
  const dEy = u.row1x * aa;                         // d(ey)/d(px)
  for (let k = rowPhase; k < h; k += rowStep) {
    const py = y0 + k;
    const row = k * w;
    let a = xEnd, b = xEnd;                         // shaded interval [a, b)
    if (!u.empty) {
      const span = rowSpan(u, py);
      a = Math.max(x0, span[0]);
      b = Math.min(xEnd, span[1]);
      if (a >= b) { a = xEnd; b = xEnd; }
    }
    for (let x = x0; x < a; x++) out[row + x - x0] = 0;
    if (a < b) {
      const vv = (halfPx - (py + 0.5)) * aa;
      const vv2 = vv * vv;
      const dy = vv - u.cy;
      let uu = (a + 0.5 - halfPx) * aa;
      const dx = uu - u.cx;
      let ex = u.row0x * dx + u.row0y * dy;
      let ey = u.row1x * dx + u.row1y * dy;
      for (let x = a; x < b; x++) {
        out[row + x - x0] = shadeLocal(u, ex, ey, uu * uu + vv2, x, py);
        ex += dEx; ey += dEy; uu += aa;
      }
    }
    for (let x = b; x < xEnd; x++) out[row + x - x0] = 0;
  }
}
