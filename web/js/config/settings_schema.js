// Runtime settings schema (docs/BLE.md §B3, §B4). DOM-free ES module: used by the config page,
// the demo device (mock_link.js), tools/gen_settings.mjs and tools/test_config.mjs.
//
// The value text formats here are the wire format of `get`/`set` and of the SETTINGS JSON, and
// MUST match firmware/src/settings.cpp: float with `decimals` places, int decimal, bool 0/1,
// mask lower-case hex without 0x, style id (empty = none), string as is.

export const TYPES = Object.freeze(['float', 'int', 'bool', 'mask', 'style', 'string']);
export const APPLY = Object.freeze(['live', 'restart', 'reboot']);
export const NEEDS = Object.freeze(['ldr', 'pir', 'vbat', 'ble', 'lcd', 'swarm']);   // lcd: GC9A01 panels; swarm: HE_SWARM
export const NAME_RE = /^[A-Za-z0-9_-]*$/;      // the only string pattern the firmware implements
export const KEY_MAX = 15;                      // NVS key length limit
export const STYLE_ID_MAX = 15;                 // char[16] in Settings

/** Validates and freezes the parsed settings.json; throws with a list of problems. */
export function normalizeSchema(doc) {
  const errs = [];
  if (!doc || doc.version !== 1 || !Array.isArray(doc.settings) || !Array.isArray(doc.groups)) {
    throw new Error('settings.json: expected {version: 1, groups: [], settings: []}');
  }
  const groupIds = new Set(doc.groups.map((g) => g.id));
  const seen = new Set();
  const settings = doc.settings.map((s, i) => {
    const where = `settings[${i}] (${s && s.key})`;
    if (!s || typeof s.key !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(s.key)) errs.push(`${where}: bad key`);
    else if (s.key.length > KEY_MAX) errs.push(`${where}: key longer than ${KEY_MAX}`);
    if (seen.has(s.key)) errs.push(`${where}: duplicate key`);
    seen.add(s.key);
    if (!TYPES.includes(s.type)) errs.push(`${where}: bad type ${s.type}`);
    if (!APPLY.includes(s.apply)) errs.push(`${where}: bad apply ${s.apply}`);
    if (!Array.isArray(s.needs) || s.needs.some((n) => !NEEDS.includes(n))) errs.push(`${where}: bad needs`);
    if (!groupIds.has(s.group)) errs.push(`${where}: unknown group ${s.group}`);
    if (typeof s.label !== 'string' || !s.label) errs.push(`${where}: missing label`);
    if (!s.default || typeof s.default !== 'object') errs.push(`${where}: missing default`);
    if (s.type === 'float' || s.type === 'int') {
      if (!(Number.isFinite(s.min) && Number.isFinite(s.max) && s.min < s.max)) errs.push(`${where}: bad min/max`);
      if (s.type === 'int' && !(Number.isInteger(s.min) && Number.isInteger(s.max))) errs.push(`${where}: int min/max`);
      if (s.type === 'float' && !(Number.isInteger(s.decimals) && s.decimals >= 0 && s.decimals <= 4)) {
        errs.push(`${where}: float needs decimals 0..4`);
      }
      const v = s.default && s.default.value;
      if (!(Number.isFinite(v) && v >= s.min && v <= s.max)) errs.push(`${where}: default.value out of range`);
    }
    if (s.type === 'string') {
      if (!(Number.isInteger(s.maxLen) && s.maxLen >= 1 && s.maxLen <= 31)) errs.push(`${where}: string maxLen 1..31`);
      if (s.pattern !== NAME_RE.source) errs.push(`${where}: string pattern must be ${NAME_RE.source}`);
    }
    if (s.type === 'mask' && !(s.default && s.default.special === 'allStyles')) errs.push(`${where}: mask default must be allStyles`);
    if (s.storage !== undefined && s.storage !== 'power') errs.push(`${where}: storage must be "power" or absent`);
    if (s.storage === 'power' && s.key !== 'always') errs.push(`${where}: only "always" lives in power`);
    return Object.freeze({ ...s, needs: Object.freeze([...(s.needs || [])]) });
  });
  if (errs.length) throw new Error(`settings.json:\n  ${errs.join('\n  ')}`);
  const byKey = new Map(settings.map((s) => [s.key, s]));
  return Object.freeze({ version: doc.version, groups: Object.freeze(doc.groups.map((g) => Object.freeze({ ...g }))),
    settings: Object.freeze(settings), byKey });
}

export async function loadSchema(url = new URL('../../../shared/settings.json?v=372e0e069c', import.meta.url)) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`settings.json: HTTP ${r.status}`);
  return normalizeSchema(await r.json());
}

/** FNV-1a 32 over the canonical definition string; the firmware embeds the same value (INFO "schema"). */
export function schemaHash(schema) {
  const parts = schema.settings.map((s) =>
    [s.key, s.type, s.apply, s.min ?? '', s.max ?? '', s.decimals ?? '', s.maxLen ?? '', s.needs.join('+'), s.storage ?? ''].join(':'));
  const str = parts.join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** True when a setting exists in a build with these capabilities (Set or array of NEEDS names). */
export function available(def, caps) {
  const c = caps instanceof Set ? caps : new Set(caps);
  return def.needs.every((n) => c.has(n));
}

export function allStylesMask(styleCount) {
  return styleCount >= 32 ? 0xffffffff : ((1 << styleCount) >>> 0) - 1;
}

/** Default value of one setting for a build (styleCount: number of styles, for the mask). */
export function defaultValue(def, styleCount) {
  if (def.type === 'mask') return allStylesMask(styleCount);
  if (def.type === 'bool') return Boolean(def.default.value);
  return def.default.value;
}

/** Wire text of a value (firmware settings.cpp format()). */
export function formatValue(def, v) {
  switch (def.type) {
    case 'float': return Number(v).toFixed(def.decimals);
    case 'int': return String(Math.trunc(v));
    case 'bool': return v ? '1' : '0';
    case 'mask': return (v >>> 0).toString(16);
    default: return String(v ?? '');
  }
}

const BOOL_TEXT = new Map([['1', true], ['0', false], ['true', true], ['false', false], ['on', true], ['off', false]]);

/**
 * Parses wire text for one setting. ctx: {styleIds: string[]}.
 * Returns {ok: true, value} or {ok: false, err: 'type' | 'range'}. Mirrors firmware settings.cpp parse().
 */
export const VALUE_MAX = 39;                    // longest value text (settings.cpp char t[40])

export function parseValue(def, text, ctx = {}) {
  const t = String(text).trim();
  if (t.length > VALUE_MAX) return { ok: false, err: 'range' };
  switch (def.type) {
    case 'float': {
      if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return { ok: false, err: 'type' };
      const v = Number(t);
      if (!(v >= def.min && v <= def.max)) return { ok: false, err: 'range' };
      // Rounded to its decimals (half away from zero; every range here is >= 0), then float32,
      // exactly as settings.cpp: round(v * p) / p.
      const p = 10 ** def.decimals;
      return { ok: true, value: Math.fround(Math.sign(v) * Math.round(Math.abs(v) * p) / p) };
    }
    case 'int': {
      if (!/^[-+]?\d+$/.test(t)) return { ok: false, err: 'type' };
      const v = Number(t);
      if (!(v >= def.min && v <= def.max)) return { ok: false, err: 'range' };
      return { ok: true, value: v };
    }
    case 'bool': {
      const v = BOOL_TEXT.get(t.toLowerCase());
      return v === undefined ? { ok: false, err: 'type' } : { ok: true, value: v };
    }
    case 'mask': {
      if (!/^[0-9a-fA-F]{1,8}$/.test(t)) return { ok: false, err: 'type' };
      const n = (ctx.styleIds || []).length;
      const v = (parseInt(t, 16) & allStylesMask(n)) >>> 0;
      return v === 0 ? { ok: false, err: 'range' } : { ok: true, value: v };
    }
    case 'style': {
      if (t === '') return { ok: true, value: '' };
      if (t.length > STYLE_ID_MAX || !(ctx.styleIds || []).includes(t)) return { ok: false, err: 'range' };
      return { ok: true, value: t };
    }
    case 'string': {
      if (!NAME_RE.test(t)) return { ok: false, err: 'type' };
      if (t.length > def.maxLen) return { ok: false, err: 'range' };
      return { ok: true, value: t };
    }
    default:
      return { ok: false, err: 'type' };
  }
}

/** Cross-field rules (§B3). values: {key: value}. Returns null or the key that breaks a rule. */
export function crossCheck(values) {
  const { duskMv, dayMv, ambientMv } = values;
  if (duskMv !== undefined && ambientMv !== undefined && !(ambientMv < duskMv)) return 'ambientMv';
  if (duskMv !== undefined && dayMv !== undefined && !(dayMv >= duskMv + 250)) return 'dayMv';
  return null;
}
