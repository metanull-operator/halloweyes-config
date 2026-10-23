// Routines (docs/ROUTINES.md): a scripted show, a timed list of cues that drives the Director
// through its scripted inputs (Appear/Vanish cues, forceStyle, forceBlink, forceWink, forceStartle
// and the directed gaze). DOM-free ES module (the simulator and tools/test_routines.mjs import it).
// Written port-friendly, like director.js: the firmware player is a later statement-for-statement port.
//
// Two steps:
//   compileRoutine(doc, routineId, styles) -> a flat, validated program: cue times in ms from the
//     routine start (beats resolved through the music's tempo map), style ids as indices, look
//     targets as numbers, Appear seeds filled in.
//   new RoutinePlayer(program) -> start(nowMs), then inputs(nowMs, out) once per director tick.

import { CUE_NONE, CUE_APPEAR, CUE_VANISH, CUE_RESET, HE_VIEW_Y, MASK_L, MASK_R } from './director.js';

export const ROUTINE_ACTIONS = Object.freeze(['appear', 'vanish', 'style', 'blink', 'wink', 'look', 'free', 'startle']);

/**
 * Named look targets (screen sense, as the viewer sees the eyes: "left" is the viewer's left). Gaze
 * units: 1 = the style's full gaze range. "viewer" is the director's view point (HE_VIEW_Y, the
 * simulator's "Viewer gaze Y" for the director itself); every other name is a fixed point.
 */
export const LOOK_TARGETS = Object.freeze({
  center: [0, 0],
  viewer: [0, HE_VIEW_Y],
  left: [-0.9, 0],
  right: [0.9, 0],
  up: [0, 0.9],
  down: [0, -0.9],
  'up-left': [-0.64, 0.64],
  'up-right': [0.64, 0.64],
  'down-left': [-0.64, -0.64],
  'down-right': [0.64, -0.64],
});

const MAX_ROUTINE_MS = 10 * 60 * 1000;
const MAX_LOOK_MS = 10000;
const MAX_OPEN_MS = 10000;

/** FNV-1a 32-bit of a string (default Appear seeds; no Math.random anywhere). */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xFF;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * A tempo map: [{beat, bpm}, ...], beat strictly increasing from 0; bpm is linear in the beat between
 * two points and constant after the last. Returns ms from beat 0 to `beat` (>= 0).
 */
export function beatToMs(tempo, beat) {
  let ms = 0;
  for (let i = 0; i < tempo.length; i++) {
    const b0 = tempo[i].beat;
    const bpm0 = tempo[i].bpm;
    const last = i === tempo.length - 1;
    const b1 = last ? Infinity : tempo[i + 1].beat;
    const bpm1 = last ? bpm0 : tempo[i + 1].bpm;
    const b = Math.min(beat, b1);
    if (b > b0) {
      if (bpm1 === bpm0 || last) {
        ms += (b - b0) * 60000 / bpm0;
      } else {
        const k = (bpm1 - bpm0) / (b1 - b0);
        ms += 60000 / k * Math.log((bpm0 + k * (b - b0)) / bpm0);
      }
    }
    if (beat <= b1) break;
  }
  return ms;
}

/** Find a music entry by id (or null). */
export function findMusic(doc, id) {
  if (!id || !doc || !Array.isArray(doc.music)) return null;
  return doc.music.find((m) => m && m.id === id) || null;
}

/** ms from the routine start of a beat of this music (its offsetMs + the tempo map). */
export function musicBeatMs(music, beat) {
  return (music.offsetMs || 0) + beatToMs(music.tempo, beat);
}

function checkTempo(music, errs, where) {
  if (!Array.isArray(music.tempo) || music.tempo.length === 0) {
    errs.push(`${where}: tempo must be a non-empty array of {beat, bpm}`);
    return false;
  }
  let prev = -1;
  for (const [i, p] of music.tempo.entries()) {
    if (!p || typeof p.beat !== 'number' || typeof p.bpm !== 'number' || !(p.bpm >= 20 && p.bpm <= 400)) {
      errs.push(`${where}: tempo[${i}] needs a numeric beat and a bpm in [20, 400]`);
      return false;
    }
    if (i === 0 && p.beat !== 0) errs.push(`${where}: tempo[0].beat must be 0`);
    if (p.beat <= prev) errs.push(`${where}: tempo beats must increase (tempo[${i}])`);
    prev = p.beat;
  }
  return true;
}

/**
 * Validate the whole routines document (shared/routines.json). Returns a list of error strings
 * (empty = valid). Style ids are checked against `styles` (normalized styles; their .id).
 */
export function validateRoutines(doc, styles) {
  const errs = [];
  if (!doc || typeof doc !== 'object') return ['document must be an object'];
  if (doc.version !== 1) errs.push('version must be 1');
  const musicIds = new Set();
  for (const [i, m] of (Array.isArray(doc.music) ? doc.music : []).entries()) {
    const where = `music[${i}]${m && m.id ? ` (${m.id})` : ''}`;
    if (!m || typeof m.id !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(m.id)) { errs.push(`${where}: bad id`); continue; }
    if (musicIds.has(m.id)) errs.push(`${where}: duplicate id`);
    musicIds.add(m.id);
    if (typeof m.title !== 'string' || !m.title) errs.push(`${where}: title required`);
    if (m.offsetMs !== undefined && !(Number.isFinite(m.offsetMs) && m.offsetMs >= 0)) errs.push(`${where}: offsetMs must be >= 0`);
    if (m.beatsPerBar !== undefined && !(Number.isInteger(m.beatsPerBar) && m.beatsPerBar >= 1)) errs.push(`${where}: beatsPerBar must be an integer >= 1`);
    checkTempo(m, errs, where);
  }
  if (!Array.isArray(doc.routines) || doc.routines.length === 0) {
    errs.push('routines must be a non-empty array');
    return errs;
  }
  const ids = new Set();
  for (const r of doc.routines) {
    if (!r || typeof r.id !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(r.id)) { errs.push(`routine: bad id ${r && r.id}`); continue; }
    if (ids.has(r.id)) errs.push(`${r.id}: duplicate id`);
    ids.add(r.id);
    const c = compileRoutine(doc, r.id, styles);
    for (const e of c.errors) errs.push(`${r.id}: ${e}`);
  }
  return errs;
}

function styleIndex(styles, id) {
  for (let i = 0; i < styles.length; i++) if (styles[i].id === id) return i;
  return -1;
}

/**
 * Compile one routine to a flat program:
 *   { id, name, description, music, lengthMs, cues: [{atMs, kind, style, seed, openMs, mask, x, y, ms,
 *     src}], errors: [] }
 * kind is one of ROUTINE_ACTIONS. cues are sorted by atMs (stable: same-time cues keep file order).
 */
export function compileRoutine(doc, routineId, styles) {
  const errors = [];
  const r = doc && Array.isArray(doc.routines) ? doc.routines.find((x) => x && x.id === routineId) : null;
  const out = { id: routineId, name: '', description: '', music: null, lengthMs: 0, resetSeed: 0, cues: [], errors };
  if (!r) {
    errors.push(`no routine "${routineId}"`);
    return out;
  }
  out.name = typeof r.name === 'string' && r.name ? r.name : r.id;
  if (typeof r.name !== 'string' || !r.name) errors.push('name required');
  out.description = typeof r.description === 'string' ? r.description : '';
  let music = null;
  if (r.music !== undefined && r.music !== null) {
    music = findMusic(doc, r.music);
    if (!music) errors.push(`unknown music "${r.music}"`);
    else if (!checkTempo(music, [], '')) music = null;
  }
  out.music = music;

  // Time of a cue or of the routine end: "at" (ms) or "beat" (needs music).
  const timeOf = (o, where) => {
    const hasAt = o.at !== undefined;
    const hasBeat = o.beat !== undefined;
    if (hasAt === hasBeat) { errors.push(`${where}: give exactly one of "at" (ms) or "beat"`); return NaN; }
    if (hasAt) {
      if (!(Number.isFinite(o.at) && o.at >= 0)) { errors.push(`${where}: "at" must be a number >= 0`); return NaN; }
      return o.at;
    }
    if (!music) { errors.push(`${where}: "beat" needs the routine's music`); return NaN; }
    if (!(Number.isFinite(o.beat) && o.beat >= 0)) { errors.push(`${where}: "beat" must be a number >= 0`); return NaN; }
    return musicBeatMs(music, o.beat);
  };

  if (!r.end || typeof r.end !== 'object') errors.push('end ({"at": ms} or {"beat": n}) required');
  else out.lengthMs = timeOf(r.end, 'end');
  if (Number.isFinite(out.lengthMs) && (out.lengthMs <= 0 || out.lengthMs > MAX_ROUTINE_MS)) {
    errors.push(`end must be in (0, ${MAX_ROUTINE_MS}] ms`);
  }

  if (!Array.isArray(r.cues) || r.cues.length === 0) {
    errors.push('cues must be a non-empty array');
    return out;
  }
  const baseSeed = fnv1a(r.id);
  out.resetSeed = baseSeed;
  const list = [];
  r.cues.forEach((c, i) => {
    const where = `cue ${i}`;
    if (!c || typeof c !== 'object') { errors.push(`${where}: must be an object`); return; }
    if (!ROUTINE_ACTIONS.includes(c.do)) { errors.push(`${where}: unknown "do": ${JSON.stringify(c.do)}`); return; }
    const atMs = timeOf(c, `${where} (${c.do})`);
    const cue = { atMs, kind: c.do, style: -1, seed: 0, openMs: 0, mask: 0, x: 0, y: 0, ms: 0, order: i, src: c };
    const needStyle = c.do === 'appear' || c.do === 'style';
    if (needStyle || c.style !== undefined) {
      const s = typeof c.style === 'string' ? styleIndex(styles, c.style) : -1;
      if (s < 0) errors.push(`${where} (${c.do}): unknown style ${JSON.stringify(c.style)}`);
      if (!needStyle && c.do !== 'startle') errors.push(`${where} (${c.do}): "style" is not used here`);
      cue.style = s;
    }
    if (c.do === 'appear') {
      if (c.seed !== undefined && !(Number.isInteger(c.seed) && c.seed >= 0 && c.seed <= 0xFFFFFFFF)) {
        errors.push(`${where}: seed must be a uint32`);
      }
      cue.seed = c.seed !== undefined ? c.seed >>> 0 : (baseSeed ^ Math.imul(i + 1, 0x9E3779B1)) >>> 0;
      if (c.openMs !== undefined && !(Number.isFinite(c.openMs) && c.openMs > 0 && c.openMs <= MAX_OPEN_MS)) {
        errors.push(`${where}: openMs must be in (0, ${MAX_OPEN_MS}]`);
      }
      cue.openMs = c.openMs !== undefined ? c.openMs : 0;
    }
    if (c.do === 'wink') {
      if (c.eye === 'left') cue.mask = MASK_L;
      else if (c.eye === 'right') cue.mask = MASK_R;
      else errors.push(`${where}: wink needs "eye": "left" or "right"`);
    }
    if (c.do === 'look') {
      if (typeof c.to === 'string') {
        const t = LOOK_TARGETS[c.to];
        if (!t) errors.push(`${where}: unknown look target "${c.to}" (${Object.keys(LOOK_TARGETS).join(', ')})`);
        else { cue.x = t[0]; cue.y = t[1]; }
        if (c.x !== undefined || c.y !== undefined) errors.push(`${where}: give "to" or "x"/"y", not both`);
      } else if (Number.isFinite(c.x) && Number.isFinite(c.y)) {
        if (Math.abs(c.x) > 1 || Math.abs(c.y) > 1) errors.push(`${where}: x and y must be in [-1, 1]`);
        cue.x = c.x;
        cue.y = c.y;
      } else {
        errors.push(`${where}: look needs "to" (a named target) or numeric "x" and "y"`);
      }
      if (c.ms !== undefined && !(Number.isFinite(c.ms) && c.ms >= 0 && c.ms <= MAX_LOOK_MS)) {
        errors.push(`${where}: ms must be in [0, ${MAX_LOOK_MS}]`);
      }
      cue.ms = c.ms !== undefined ? c.ms : 0;
    }
    if (Number.isFinite(atMs) && Number.isFinite(out.lengthMs) && atMs > out.lengthMs) {
      errors.push(`${where} (${c.do}): at ${Math.round(atMs)} ms is after the end (${Math.round(out.lengthMs)} ms)`);
    }
    list.push(cue);
  });
  list.sort((a, b) => (a.atMs - b.atMs) || (a.order - b.order));
  out.cues = list;
  return out;
}

/** One-line label of a compiled cue (UI, logs). */
export function cueLabel(cue, styles) {
  const sn = (i) => (i >= 0 && styles && styles[i] ? styles[i].name : '?');
  switch (cue.kind) {
    case 'appear': return `appear: ${sn(cue.style)}`;
    case 'style': return `style: ${sn(cue.style)}`;
    case 'wink': return `wink ${cue.mask === MASK_L ? 'left' : 'right'}`;
    case 'look': {
      const name = cue.src && typeof cue.src.to === 'string' ? cue.src.to : `${cue.x}, ${cue.y}`;
      return `look ${name}${cue.ms > 0 ? ` (${cue.ms} ms glide)` : ''}`;
    }
    case 'free': return 'look free';
    case 'startle': return cue.style >= 0 ? `startle: ${sn(cue.style)}` : 'startle';
    default: return cue.kind;
  }
}

/**
 * Plays a compiled routine. Call inputs(nowMs, out) once per director update: it fills the
 * Director inputs for that update (always scripted while playing) and returns true while the
 * routine runs. The first update restarts the director, dark (CUE_RESET with the routine's seed), so
 * a routine plays the same whatever the show before it. Cues fire on the first update at or after
 * their time, in order. Reset, Appear and Vanish share the director's one cue slot: a second one due
 * on the same update waits for the next.
 */
export class RoutinePlayer {
  constructor(program) {
    this.program = program;
    this.playing = false;
    this.t0 = 0;
    this.next = 0;            // index of the next cue to fire
    this.forced = -1;         // the forceStyle level (the last appear/style/startle style)
    this.lookOn = false;
    this.lookX = 0;
    this.lookY = 0;
    this.lookMs = 0;
    this.lastFired = -1;      // index of the last cue fired (UI)
    this.needReset = false;
  }

  start(nowMs) {
    this.playing = true;
    this.t0 = nowMs;
    this.next = 0;
    this.forced = -1;
    this.lookOn = false;
    this.lookX = 0;
    this.lookY = 0;
    this.lookMs = 0;
    this.lastFired = -1;
    this.needReset = true;
  }

  stop() {
    this.playing = false;
    this.lookOn = false;
  }

  /** ms since start (0 when not playing). */
  elapsed(nowMs) { return this.playing ? nowMs - this.t0 : 0; }

  /**
   * Fill `out` (a Director inputs object; only routine-owned fields are written) for an update at
   * nowMs. Returns false (and writes nothing) once the routine has ended or when not playing.
   */
  inputs(nowMs, out) {
    if (!this.playing) return false;
    const t = nowMs - this.t0;
    if (t >= this.program.lengthMs) {
      this.stop();
      return false;
    }
    out.scripted = true;
    out.cue = CUE_NONE;
    if (this.needReset) {
      this.needReset = false;
      out.cue = CUE_RESET;
      out.cueSeed = this.program.resetSeed;
    }
    const cues = this.program.cues;
    while (this.next < cues.length && cues[this.next].atMs <= t) {
      const c = cues[this.next];
      if ((c.kind === 'appear' || c.kind === 'vanish') && out.cue !== CUE_NONE) break;   // one cue slot
      // A startle with a style: the style goes first, one update ahead, so a dark director has made
      // it the next style before the startle opens the eyes.
      if (c.kind === 'startle' && c.style >= 0 && this.forced !== c.style) {
        this.forced = c.style;
        break;
      }
      this.next++;
      this.lastFired = this.next - 1;
      switch (c.kind) {
        case 'appear':
          out.cue = CUE_APPEAR;
          out.cueStyle = c.style;
          out.cueSeed = c.seed;
          out.cueOpenMs = c.openMs;
          this.forced = c.style;
          break;
        case 'vanish':
          out.cue = CUE_VANISH;
          break;
        case 'style':
          this.forced = c.style;
          break;
        case 'blink':
          out.forceBlink = true;
          break;
        case 'wink':
          out.forceWink = c.mask;
          break;
        case 'look':
          this.lookOn = true;
          this.lookX = c.x;
          this.lookY = c.y;
          this.lookMs = c.ms;
          break;
        case 'free':
          this.lookOn = false;
          break;
        case 'startle':
          out.forceStartle = true;
          break;
        default:
          break;
      }
    }
    out.forceStyle = this.forced;
    out.lookOn = this.lookOn;
    out.lookX = this.lookX;
    out.lookY = this.lookY;
    out.lookMs = this.lookMs;
    return true;
  }
}
