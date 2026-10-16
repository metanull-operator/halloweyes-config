// Style schema table and normalizer (DESIGN.md §5.2). This module holds the ONLY
// implementation of style defaults: tools/gen_styles.mjs and tools/validate_styles.mjs
// import it, and the simulator uses loadStyles(). DOM-free except loadStyles (fetch).
//
// ---------------------------------------------------------------------------------
// Normalized style object (output of normalizeStyle). Field paths match the C++
// StyleDef of §5.3 one to one (so `style.fill.irisR` here is `s.fill.irisR` there).
// Every number is Math.fround-ed (exactly the float32 value in styles_gen.h).
// Enums are integers in the order of §4.9 (see constants.js). Colors are {r,g,b}
// float sRGB 0..1 (v/255). Angles are radians.
//
// {
//   id: string, name: string,
//   tier: 0|1 (A|B), weight: number (0, 0.5, 1), seed: number (uint 0..65535),
//   pal:      { core, mid, rim, pupil, sclera, accent, highlight, glow },   // each {r,g,b}
//   outline:  { type: OutlineType, w, h, d, corner, rot /*rad, + = medial end up*/, ring,
//               medialOffset, centerY, beadCount: 0..4, beads: [{x,y,r}] /*length beadCount*/ },
//               // cluster: w = h = Rb (bounding radius of the beads, without ring)
//   lids:     { enabled: bool, upper, lower, tiltU, tiltL, curvU, curvL, trackU, trackL },
//   fill:     { mode: FillMode, irisR /*default Rb without ring*/, sclera: bool, scleraLevel, limbal,
//               texSpokes: int, texAmp, texRadFreq: int, texScrollHz, veins, veinCount: int,
//               spiralArms: int, spiralTwist, spinHz, hotX, hotY, hotR, rimW, edgeRing,
//               scanBarW, scanTrail, scanSpeedMm },
//   pupil:    { type: PupilType, pMin, pMax, h, aspect, shine, level: bool },  // JSON min/max -> pMin/pMax
//   highlight:{ x, y, r, alpha },
//   glow:     { sigma, gain, pulseHz, pulseAmp },
//   fx:       { flickerAmp, flickerHz, dropoutRate, breatheAmp, breatheHz, bobAmp, bobHz, membraneAlpha },
//   blink:    { kind: BlinkKind, tc, th, to /*ms*/, ibiMedian /*s*/, ibiSigma, pDouble, pTriple, pPartial, pWink },
//   gaze:     { kind: GazeKind, rangeX, rangeY, sacScale, overshoot, fixMedian /*s*/, viewerBias,
//               microHz, microAmp, vergence, pGazeBlink },
//   pupilDyn: { rest, tauC, tauD /*s*/, hippus, startle: StartleMode },
//   behavior: { lagMs, lagOffset, droopL, droopR, watchMedian /*s*/ },
//   events:   { w: number[13] }                    // indexed by EventType
// }
// ---------------------------------------------------------------------------------

import {
  OutlineType, OUTLINE_TYPE_NAMES, FILL_MODE_NAMES, PUPIL_TYPE_NAMES, BLINK_KIND_NAMES,
  GAZE_KIND_NAMES, STARTLE_MODE_NAMES, EVENT_NAMES, EV_COUNT,
} from './constants.js';
import { hexToRgbf } from './color.js';

const f32 = Math.fround;

// Field spec helpers. `def`: literal default; `required: true`; or `computed: '<doc>'`
// (the normalizer derives it). `out` renames the key in the normalized object.
const num = (min, max, def, extra = {}) => ({ type: 'number', min, max, def, ...extra });
const int = (min, max, def, extra = {}) => ({ type: 'integer', min, max, def, ...extra });
const bool = (def) => ({ type: 'boolean', def });
const enm = (values, def, extra = {}) => ({ type: 'enum', values, def, ...extra });
const hex = (def) => ({ type: 'hex', def });

/**
 * Machine-readable form of the §5.2 table, shared by the normalizer, the validator
 * and the documentation schema. Section and field order equal the C++ struct order.
 */
export const STYLE_SCHEMA = Object.freeze({
  top: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,23}$', required: true },
    name: { type: 'string', minLength: 1, maxLength: 32, required: true },
    tier: enm(['A', 'B'], undefined, { required: true }),
    weight: { type: 'number', oneOf: [0, 0.5, 1], computed: 'tier A -> 1, tier B -> 0.5' },
    seed: int(0, 65535, undefined, { required: true }),
  },
  sections: [
    { key: 'palette', out: 'pal', fields: {
      core: hex('#000000'), mid: hex('#000000'), rim: hex('#000000'), pupil: hex('#000000'),
      sclera: hex('#000000'), accent: hex('#000000'), highlight: hex('#FFFFFF'), glow: hex('#000000'),
    } },
    { key: 'outline', out: 'outline', fields: {
      type: enm(OUTLINE_TYPE_NAMES, undefined, { required: true }),
      w: num(0.02, 1.0, undefined, { computed: 'required unless cluster; cluster: w = h = Rb' }),
      h: num(0.02, 1.0, undefined, { computed: '= w (moon: required; cluster: Rb)' }),
      d: num(0.01, 1.0, 0.25),
      corner: num(0, 0.2, 0),
      rot: num(-90, 90, 0, { unit: 'deg' }),
      ring: num(0, 0.3, 0),
      medialOffset: num(-0.5, 0.5, 0),
      centerY: num(-0.5, 0.5, 0),
      beads: { type: 'beads', minItems: 1, maxItems: 4, xy: [-1, 1], r: [0.02, 0.6], computed: 'required iff cluster' },
    } },
    { key: 'lids', out: 'lids', fields: {
      enabled: bool(true),
      upper: num(-1, 1.2, undefined, { computed: 'outline top + 0.02' }),
      lower: num(-1.2, 1, undefined, { computed: 'outline bottom - 0.02' }),
      tiltU: num(-0.6, 0.6, 0), tiltL: num(-0.6, 0.6, 0),
      curvU: num(0, 1, 0), curvL: num(0, 1, 0),
      trackU: num(0, 1, 0.7), trackL: num(0, 1, 0.35),
    } },
    { key: 'fill', out: 'fill', fields: {
      mode: enm(FILL_MODE_NAMES, undefined, { required: true }),
      irisR: num(0.03, 1.5, undefined, { computed: 'Rb of the outline (without ring)' }),
      sclera: bool(false),
      scleraLevel: num(0, 1, 1),
      limbal: num(0, 0.5, 0),
      texSpokes: int(0, 64, 0),
      texAmp: num(0, 1, 0.3),
      texRadFreq: int(0, 12, 0),
      texScrollHz: num(-2, 2, 0),
      veins: num(0, 1, 0),
      veinCount: int(4, 48, 18),
      spiralArms: int(1, 6, 2),
      spiralTwist: num(0, 12, 3),
      spinHz: num(-2, 2, 0.6),
      hotX: num(-1, 1, 0), hotY: num(-1, 1, 0),
      hotR: num(0.05, 2, 0.8),
      rimW: num(0.01, 1, 0.1),
      edgeRing: num(0, 0.15, 0),
      scanBarW: num(0.02, 0.5, 0.12),
      scanTrail: num(0.02, 1, 0.25),
      scanSpeedMm: num(5, 200, 60),
    } },
    { key: 'pupil', out: 'pupil', fields: {
      type: enm(PUPIL_TYPE_NAMES, 'none'),
      min: num(0, 1, 0, { out: 'pMin' }),
      max: num(0, 1, 0, { out: 'pMax' }),
      h: num(0.05, 1, 0.5),
      aspect: num(0.05, 1, 0.26),
      shine: num(0, 1, 0),
      level: bool(false),
    } },
    { key: 'highlight', out: 'highlight', fields: {
      x: num(-1, 1, 0), y: num(-1, 1, 0), r: num(0, 0.4, 0), alpha: num(0, 1, 0.85),
    } },
    { key: 'glow', out: 'glow', fields: {
      sigma: num(0.01, 0.4, 0.065), gain: num(0, 2, 0.8), pulseHz: num(0, 3, 0), pulseAmp: num(0, 0.5, 0),
    } },
    { key: 'fx', out: 'fx', fields: {
      flickerAmp: num(0, 0.4, 0), flickerHz: num(0.1, 20, 6), dropoutRate: num(0, 2, 0),
      breatheAmp: num(0, 0.1, 0), breatheHz: num(0, 2, 0.25),
      bobAmp: num(0, 0.1, 0), bobHz: num(0, 2, 0.3),
      membraneAlpha: num(0, 1, 0.45),
    } },
    { key: 'blink', out: 'blink', fields: {
      kind: enm(BLINK_KIND_NAMES, 'lid'),
      tc: num(30, 1000, 90), th: num(0, 1000, 60), to: num(50, 2000, 220),
      ibiMedian: num(1, 30, 5), ibiSigma: num(0, 1.5, 0.7),
      pDouble: num(0, 1, 0.12), pTriple: num(0, 1, 0.03), pPartial: num(0, 1, 0.10), pWink: num(0, 1, 0),
    } },
    { key: 'gaze', out: 'gaze', fields: {
      kind: enm(GAZE_KIND_NAMES, 'pupil'),
      rangeX: num(0.02, 1, 0.30), rangeY: num(0.02, 1, 0.15),
      sacScale: num(0.3, 3, 1), overshoot: num(0, 1.5, 0.9), fixMedian: num(0.2, 8, 1.5),
      viewerBias: num(0, 1, 0.45), microHz: num(0, 4, 1.2), microAmp: num(0, 0.05, 0.012),
      vergence: num(0, 0.1, 0.02), pGazeBlink: num(0, 1, 0.6),
    } },
    { key: 'pupilDyn', out: 'pupilDyn', fields: {
      rest: num(0, 1, 0.5), tauC: num(0.05, 3, 0.25), tauD: num(0.05, 3, 1.2), hippus: num(0, 0.2, 0.05),
      startle: enm(STARTLE_MODE_NAMES, 'dilate'),
    } },
    { key: 'behavior', out: 'behavior', fields: {
      lagMs: num(0, 500, 0), lagOffset: num(-0.1, 0.1, 0), droopL: num(0, 0.8, 0), droopR: num(0, 0.8, 0),
      watchMedian: num(5, 40, 18),
    } },
    { key: 'events', out: 'events', fields: Object.fromEntries(EVENT_NAMES.map((n) => [n, num(0, Infinity, 0)])) },
  ],
});

// ---------------------------------------------------------------------------------
// Outline geometry (§4.5). Each takes an outline with an integer `type` (a normalized
// style.outline, or the normalizer's double-precision copy).

/** Bounding radius Rb; `withRing` adds outline.ring (the §4.5 table value). */
export function outlineRb(o, withRing = true) {
  let rb;
  switch (o.type) {
    case OutlineType.Circle: rb = o.w; break;
    case OutlineType.Ellipse:
    case OutlineType.Vesica: rb = Math.max(o.w, o.h); break;
    case OutlineType.Triangle: rb = Math.hypot(o.w, o.h) + o.corner; break;
    case OutlineType.Moon: rb = o.w; break;
    case OutlineType.RoundBox: rb = Math.hypot(o.w, o.h); break;
    case OutlineType.Cluster: rb = beadsRb(o.beads); break;
    default: throw new Error(`outlineRb: bad outline type ${o.type}`);
  }
  return withRing ? rb + o.ring : rb;
}

function beadsRb(beads) {
  let rb = 0;
  for (const b of beads) rb = Math.max(rb, Math.hypot(b.x, b.y) + b.r);
  return rb;
}

/** Eye-local half-extents {Ex, Ey} (§4.5), ring included (ring·f, f = max/min for ellipse). */
export function outlineExtents(o) {
  let Ex, Ey;
  switch (o.type) {
    case OutlineType.Circle:
    case OutlineType.Moon: Ex = o.w; Ey = o.w; break;
    case OutlineType.Ellipse:
    case OutlineType.Vesica:
    case OutlineType.RoundBox: Ex = o.w; Ey = o.h; break;
    case OutlineType.Triangle: Ex = o.w + o.corner; Ey = o.h + o.corner; break;
    case OutlineType.Cluster:
      Ex = 0; Ey = 0;
      for (const b of o.beads) { Ex = Math.max(Ex, Math.abs(b.x) + b.r); Ey = Math.max(Ey, Math.abs(b.y) + b.r); }
      break;
    default: throw new Error(`outlineExtents: bad outline type ${o.type}`);
  }
  const f = o.type === OutlineType.Ellipse ? Math.max(o.w, o.h) / Math.min(o.w, o.h) : 1;
  return { Ex: Ex + o.ring * f, Ey: Ey + o.ring * f };
}

/** Outline top / bottom used for the lid defaults (§5.2 normalizer table; ring ignored). */
export function outlineTopBottom(o) {
  switch (o.type) {
    case OutlineType.Circle:
    case OutlineType.Moon: return { top: o.w, bottom: -o.w };
    case OutlineType.Cluster: {
      let top = -Infinity, bottom = Infinity;
      for (const b of o.beads) { top = Math.max(top, b.y + b.r); bottom = Math.min(bottom, b.y - b.r); }
      return { top, bottom };
    }
    default: return { top: o.h, bottom: -o.h };   // ellipse, vesica, roundbox, triangle
  }
}

// ---------------------------------------------------------------------------------
// Normalizer

function fail(ctx, msg) { throw new Error(`style ${ctx}: ${msg}`); }

function convert(spec, raw, ctx, path) {
  switch (spec.type) {
    case 'number':
    case 'integer':
      if (typeof raw !== 'number' || !Number.isFinite(raw)) fail(ctx, `${path} must be a finite number`);
      return f32(raw);
    case 'boolean':
      if (typeof raw !== 'boolean') fail(ctx, `${path} must be a boolean`);
      return raw;
    case 'enum': {
      const i = spec.values.indexOf(raw);
      if (i < 0) fail(ctx, `${path} must be one of ${spec.values.join(', ')}`);
      return i;
    }
    case 'hex': {
      if (typeof raw !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(raw)) fail(ctx, `${path} must be #RRGGBB`);
      const c = hexToRgbf(raw);
      return { r: f32(c.r), g: f32(c.g), b: f32(c.b) };
    }
    default:
      throw new Error(`internal: unexpected spec type ${spec.type}`);
  }
}

function sectionOf(json, key, ctx) {
  const v = json[key];
  if (v === undefined) return {};
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(ctx, `${key} must be an object`);
  return v;
}

/**
 * Normalize one raw style (from shared/styles.json) into the shape documented at the
 * top of this file. Applies every §5.2 default. Throws on missing required fields,
 * wrong types, unknown keys and unknown enum strings; range and cross-field rules are
 * the validator's job (tools/validate_styles.mjs).
 * @param {object} json raw style
 * @param {number} index position in the styles array (error context only)
 */
export function normalizeStyle(json, index) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`style #${index}: must be an object`);
  }
  const ctx = `#${index}${typeof json.id === 'string' ? ` (${json.id})` : ''}`;
  const top = STYLE_SCHEMA.top;
  const sectionKeys = STYLE_SCHEMA.sections.map((s) => s.key);
  for (const k of Object.keys(json)) {
    if (!(k in top) && !sectionKeys.includes(k)) fail(ctx, `unknown key "${k}"`);
  }

  if (typeof json.id !== 'string') fail(ctx, 'id is required (string)');
  if (typeof json.name !== 'string') fail(ctx, 'name is required (string)');
  if (json.tier === undefined) fail(ctx, 'tier is required');
  if (json.seed === undefined) fail(ctx, 'seed is required');
  const tier = convert(top.tier, json.tier, ctx, 'tier');
  const seed = convert(top.seed, json.seed, ctx, 'seed');
  const weight = json.weight === undefined ? f32(tier === 0 ? 1 : 0.5) : convert(top.weight, json.weight, ctx, 'weight');

  const s = { id: json.id, name: json.name, tier, weight, seed };
  let geom = null;   // outline geometry in double precision (set before lids/fill)

  for (const sec of STYLE_SCHEMA.sections) {
    const raw = sectionOf(json, sec.key, ctx);
    for (const k of Object.keys(raw)) {
      if (!(k in sec.fields)) fail(ctx, `unknown key "${sec.key}.${k}"`);
    }
    const out = {};
    if (sec.key === 'outline') {
      geom = normalizeOutline(raw, out, sec.fields, ctx);
    } else if (sec.key === 'events') {
      const w = new Array(EV_COUNT).fill(0);
      EVENT_NAMES.forEach((n, i) => { if (raw[n] !== undefined) w[i] = convert(sec.fields[n], raw[n], ctx, `events.${n}`); });
      out.w = w;
    } else {
      for (const [k, spec] of Object.entries(sec.fields)) {
        const name = spec.out ?? k;
        const path = `${sec.key}.${k}`;
        if (raw[k] !== undefined) {
          out[name] = convert(spec, raw[k], ctx, path);
        } else if (spec.computed !== undefined) {
          out[name] = computedDefault(path, geom, ctx);
        } else if (spec.required) {
          fail(ctx, `${path} is required`);
        } else {
          out[name] = convert(spec, spec.def, ctx, path);
        }
      }
    }
    s[sec.out] = out;
  }
  return s;
}

/**
 * Normalizes `outline` into `out` (float32, C++ field order). Returns the same geometry
 * in double precision; derived defaults (cluster w/h, lid defaults, irisR) are computed
 * from it and rounded once, so an omitted field equals writing the obvious value.
 */
function normalizeOutline(raw, out, fields, ctx) {
  if (raw.type === undefined) fail(ctx, 'outline.type is required');
  const type = convert(fields.type, raw.type, ctx, 'outline.type');
  const num64 = (v, path) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) fail(ctx, `${path} must be a finite number`);
    return v;
  };

  let beads = [];
  if (raw.beads !== undefined) {
    if (!Array.isArray(raw.beads)) fail(ctx, 'outline.beads must be an array');
    beads = raw.beads.map((b, i) => {
      const p = `outline.beads[${i}]`;
      if (b === null || typeof b !== 'object' || Array.isArray(b)) fail(ctx, `${p} must be an object`);
      for (const k of Object.keys(b)) if (!['x', 'y', 'r'].includes(k)) fail(ctx, `unknown key "${p}.${k}"`);
      for (const k of ['x', 'y', 'r']) if (b[k] === undefined) fail(ctx, `${p}.${k} is required`);
      return { x: num64(b.x, `${p}.x`), y: num64(b.y, `${p}.y`), r: num64(b.r, `${p}.r`) };
    });
  }

  const g = { type, beads };
  if (type === OutlineType.Cluster) {
    if (beads.length === 0) fail(ctx, 'outline.beads is required for a cluster');
    g.w = g.h = beadsRb(beads);                        // cluster: w = h = Rb
  } else {
    if (raw.w === undefined) fail(ctx, 'outline.w is required');
    g.w = num64(raw.w, 'outline.w');
    if (raw.h === undefined && type === OutlineType.Moon) fail(ctx, 'outline.h is required for a moon');
    g.h = raw.h === undefined ? g.w : num64(raw.h, 'outline.h');
  }
  for (const k of ['d', 'corner', 'ring', 'medialOffset', 'centerY']) {
    g[k] = num64(raw[k] ?? fields[k].def, `outline.${k}`);
  }
  g.rot = num64(raw.rot ?? fields.rot.def, 'outline.rot') * Math.PI / 180;   // degrees -> radians

  // Key order = C++ struct order.
  Object.assign(out, {
    type, w: f32(g.w), h: f32(g.h), d: f32(g.d), corner: f32(g.corner), rot: f32(g.rot), ring: f32(g.ring),
    medialOffset: f32(g.medialOffset), centerY: f32(g.centerY),
    beadCount: beads.length, beads: beads.map((b) => ({ x: f32(b.x), y: f32(b.y), r: f32(b.r) })),
  });
  return g;
}

function computedDefault(path, geom, ctx) {
  switch (path) {
    case 'lids.upper': return f32(outlineTopBottom(geom).top + 0.02);
    case 'lids.lower': return f32(outlineTopBottom(geom).bottom - 0.02);
    case 'fill.irisR': return f32(outlineRb(geom, false));
    default: return fail(ctx, `internal: no computed default for ${path}`);
  }
}

/**
 * Normalize a whole styles document `{ schemaVersion: 1, styles: [...] }`.
 * @returns {object[]} normalized styles in file order
 */
export function normalizeStyles(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('styles document must be an object');
  if (doc.schemaVersion !== 1) throw new Error(`unsupported schemaVersion ${JSON.stringify(doc.schemaVersion)} (expected 1)`);
  if (!Array.isArray(doc.styles) || doc.styles.length === 0) throw new Error('styles must be a non-empty array');
  return doc.styles.map((st, i) => normalizeStyle(st, i));
}

/** Index of the style with this id, or -1 (mirrors C++ styleIndexById). */
export function styleIndexById(styles, id) {
  return styles.findIndex((s) => s.id === id);
}

/** Fetch and normalize the styles document (browser; default path relative to web/). */
export async function loadStyles(url = '../shared/styles.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`loadStyles: ${url}: HTTP ${res.status}`);
  return normalizeStyles(await res.json());
}
