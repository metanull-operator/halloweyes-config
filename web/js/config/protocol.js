// BLE configuration protocol (docs/BLE.md §B4, §B5). DOM-free ES module.
//
// - UUIDs of the GATT service.
// - parseReply(): one REPLY line -> {ok, words, key, value, apply, err}.
// - DemoDevice: the firmware's command processor and settings store in JS (firmware/src/console.cpp,
//   settings.cpp, the BLE PIN gate of ble_config.cpp). The page's demo mode and tools/test_config.mjs
//   run it. Show actions (next, blink, pin, ...) are handed to an `actions` callback.

import {
  available, crossCheck, defaultValue, formatValue, parseValue,
} from './settings_schema.js?v=fdf99b96fa';

const BASE = '68616c6c-6f77-6579-6573-0000000000';
export const UUID = Object.freeze({
  service: `${BASE}a0`,
  info: `${BASE}a1`,
  settings: `${BASE}a2`,
  status: `${BASE}a3`,
  command: `${BASE}a4`,
  reply: `${BASE}a5`,
});

export const MAX_LINE = 120;     // console::kMaxLine
// console.cpp kLookNames (DESIGN.md §6.5.1; web/js/routine.js LOOK_TARGETS): name -> [x, y], screen sense.
export const LOOK_NAMES = Object.freeze({
  center: [0, 0], viewer: [0, Math.fround(0.35)], left: [-0.9, 0], right: [0.9, 0], up: [0, 0.9], down: [0, -0.9],
  'up-left': [-0.64, 0.64], 'up-right': [0.64, 0.64], 'down-left': [-0.64, -0.64], 'down-right': [0.64, -0.64],
});
export const SWARM_MODE_NAMES = Object.freeze(['solo', 'hive', 'chorus', 'pack', 'scatter']);   // swarm::Mode order
export const SWARM_MODE_LETTERS = 'OHCPS';                                                     // STATUS "sw" letter
export const MAX_REPLY = 120;    // console::kMaxReply
export const INFO_MAX = 512;     // §B5 budgets
export const SETTINGS_MAX = 512;
export const STATUS_MAX = 180;

/** Parses one reply line ("ok key=value live", "err range dayMv", "ok pong", ...). */
export function parseReply(line) {
  const text = String(line).trim();
  const words = text.split(/\s+/);
  const ok = words[0] === 'ok';
  const r = { ok, text, words: words.slice(1), key: null, value: null, apply: null, err: null };
  if (!ok) {
    r.err = words[1] || 'unknown';
    r.key = words[2] || null;
    return r;
  }
  const kv = (words[1] === 'wset' ? words[2] : words[1]) || '';   // "ok wset night=0.40": a swarm setting
  const eq = kv.indexOf('=');
  if (eq > 0) {
    r.key = kv.slice(0, eq);
    r.value = kv.slice(eq + 1);
    r.apply = words[2] || null;
  }
  return r;
}

/** Build profiles: capabilities as the firmware reports them in INFO (ble_config.cpp buildInfo). */
export const PROFILES = Object.freeze({
  poc: { build: 'poc', panel: 'gc9a01', caps: ['ble', 'lcd', 'boot', 'card'] },
  'poc-swarm': { build: 'poc', panel: 'gc9a01', caps: ['ble', 'lcd', 'swarm', 'boot', 'card'], swarm: true,
    defaults: { bleWin: 0 } },   // poc_swarm env (config.h: swarm builds are always connectable)
  oled: { build: 'oled', panel: 'ssd1351', caps: ['ble', 'boot', 'card'] },
  'full-battery': { build: 'full-battery', panel: 'gc9a01', caps: ['ldr', 'pir', 'vbat', 'ble', 'lcd', 'reed', 'card'] },
  'full-usb': { build: 'full-usb', panel: 'gc9a01', caps: ['ldr', 'pir', 'ble', 'lcd', 'reed', 'card'] },
});

/**
 * The firmware's settings + command processor in JS.
 * opts: {schema, styleIds, routineIds (shared/routines.json ids, firmware routines_gen.h order), profile
 * (PROFILES key), name, actions(req), fw, schemaId}
 */
export class DemoDevice {
  constructor(opts) {
    this.schema = opts.schema;
    this.styleIds = opts.styleIds;
    this.routineIds = opts.routineIds || [];
    this.profile = PROFILES[opts.profile || 'poc'];
    this.caps = new Set(this.profile.caps);
    this.name = opts.name || 'HE-DEMO';
    this.fw = opts.fw || '1.3.0';
    this.schemaId = opts.schemaId || '';
    this.actions = opts.actions || (() => {});
    this.defs = this.schema.settings.filter((d) => available(d, this.caps));
    this.defaults = {};
    for (const d of this.defs) this.defaults[d.key] = defaultValue(d, this.styleIds.length);
    Object.assign(this.defaults, this.profile.defaults || {});   // build-specific defaults (config.h)
    this.values = { ...this.defaults };
    this.mode = 'Auto';                 // "always" lives in the power module
    this.swarm = !!this.profile.swarm;  // swarm firmware (HE_SWARM): wm<mode>
    this.swarmMode = 'hive';
    this.swarmCfg = { night: null, blePin: null };   // the swarm's settings as this unit knows them
    this.stored = {};                   // NVS image (keys that differ from the default)
    this.dirty = new Set();
    this.lastSetMs = 0;
    this.rebootNeeded = false;
    this.restartPending = false;
    // BLE PIN gate (ble_config.cpp)
    this.authed = false;
    this.pinFails = 0;
    this.lockUntil = 0;
  }

  def(key) { return this.defs.find((d) => d.key === key) || null; }

  format(d) {
    if (d.key === 'always') return this.mode === 'Always' ? '1' : '0';
    if (d.secret) return this.values[d.key] ? 'set' : '0';
    return formatValue(d, this.values[d.key]);
  }

  infoJson() {
    return JSON.stringify({
      fw: this.fw, proto: 1, build: this.profile.build, panel: this.profile.panel, name: this.name,
      schema: this.schemaId, caps: [...this.profile.caps], styles: this.styleIds,
    });
  }

  settingsJson() {
    const o = {};
    for (const d of this.defs) o[d.key] = this.format(d);
    return JSON.stringify(o);
  }

  /** settings.cpp set(): returns {err} or {apply}. */
  set(key, text) {
    const d = this.def(key);
    if (!d) return { err: 'key' };
    const p = parseValue(d, text, { styleIds: this.styleIds });
    if (!p.ok) return { err: p.err };
    if (d.key === 'always') {
      const want = p.value ? 'Always' : 'Auto';
      if (this.mode !== want) this.actions({ toggle: true });
      this.mode = want;
      return { apply: d.apply };
    }
    const next = { ...this.values, [key]: p.value };
    if (this.caps.has('ldr') && crossCheck(next)) return { err: 'range' };
    if (next[key] === this.values[key] && !this.erased) return { apply: d.apply };   // settings.cpp erased_
    this.values = next;
    this.dirty.add(key);
    this.lastSetMs = Date.now();
    if (d.apply === 'restart') this.restartPending = true;
    if (d.apply === 'reboot') this.rebootNeeded = true;
    if (d.apply === 'live' || d.apply === 'restart') this.actions({ setting: key, value: p.value, apply: d.apply });
    return { apply: d.apply };
  }

  save() {
    let n = 0;
    for (const k of this.dirty) {
      const d = this.def(k);
      if (this.values[k] === this.defaults[k]) delete this.stored[k];
      else this.stored[k] = formatValue(d, this.values[k]);
      n++;
    }
    this.dirty.clear();
    return n;
  }

  /** ble_config.cpp gate() + console.cpp execute() for a BLE command. Returns the reply line. */
  command(line, nowMs = Date.now()) {
    const l = String(line).replace(/[\r\n]+$/, '').slice(0, MAX_LINE);
    const pin = this.values.blePin || 0;
    if (l.startsWith('auth ')) {
      if (pin === 0) { this.authed = true; return 'ok auth'; }
      if (this.lockUntil > nowMs) return 'err auth locked';
      if (Number.parseInt(l.slice(5), 10) === pin) { this.authed = true; this.pinFails = 0; return 'ok auth'; }
      this.authed = false;
      if (++this.pinFails >= 5) {
        this.pinFails = 0;
        this.lockUntil = nowMs + 60000;
        this.actions({ disconnect: true });
        return 'err auth locked';
      }
      return 'err auth';
    }
    if (pin !== 0 && !this.authed && l !== 'ping') return 'err auth';
    return this.execute(l);
  }

  /** console.cpp execute() (BLE source). */
  execute(l) {
    if (l === 'ping') return 'ok pong';
    if (l.startsWith('get ')) {
      const d = this.def(l.slice(4));
      return d ? `ok ${d.key}=${this.format(d)}` : `err key ${l.slice(4)}`;
    }
    if (l.startsWith('set ')) {
      const eq = l.indexOf('=', 4);
      const key = eq > 4 ? l.slice(4, eq) : '';
      if (!key || key.length >= 24) return 'err cmd';
      const r = this.set(key, l.slice(eq + 1));
      if (r.err) return `err ${r.err} ${key}`;
      return `ok ${key}=${this.format(this.def(key))} ${r.apply}`;
    }
    if (l === 'save') return `ok save ${this.save()}`;
    if (l === 'defaults') {
      this.stored = {};
      this.erased = true;
      this.dirty.clear();
      this.rebootNeeded = true;
      return 'ok defaults reboot';
    }
    if (l === 'reboot') { this.actions({ reboot: true }); return 'ok reboot'; }
    const single = { n: 'next', b: 'blink', p: 'startle', a: 'appear', d: 'disappear', t: 'toggle', v: 'selftest', c: 'testCard' };
    if (l.length === 1 && single[l] && (l !== 'c' || this.caps.has('card'))) {
      if (l === 't') this.mode = this.mode === 'Always' ? 'Auto' : 'Always';
      this.actions({ [single[l]]: true });
      return `ok ${l}`;
    }
    if (l === 'identify') { this.actions({ identify: true }); return 'ok identify'; }
    if (l[0] === 'w') {   // console.cpp: swarm builds only (w alone is serial)
      if (!this.swarm) return 'err cmd';
      if (l.startsWith('wset ')) return this.swarmSet(l.slice(5));
      const act = { b: 1, p: 2, a: 3, n: 4, d: 5 }[l[1]];   // swarm::Action (wd: disappear now)
      if (l.length === 2 && act) {
        this.actions({ swarmAction: act });
        return `ok ${l}`;
      }
      if (l === 'wfo' || l === 'wfi') {   // fade out / fade in, unit by unit (swarm::Action 6, 7)
        this.actions({ swarmAction: l === 'wfo' ? 6 : 7 });
        return `ok ${l}`;
      }
      if (l[1] === 's' && l[2] !== '?') {   // ws<idx>, ws<id>: pin every unit; ws: unpin
        if (l.length === 2) { this.actions({ swarmPin: -2 }); return 'ok ws'; }
        const rest = l.slice(2);
        const idx = /^[0-9]/.test(rest) ? Number.parseInt(rest, 10) : this.styleIds.indexOf(rest);
        if (idx >= 0 && idx < this.styleIds.length) {
          this.actions({ swarmPin: idx });
          return `ok ws ${this.styleIds[idx]}`;
        }
        return 'err range ws';
      }
      if (l[1] === 'm' && l.length > 2) {
        const name = l.slice(2);
        if (!SWARM_MODE_NAMES.includes(name)) return 'err range wm';
        this.swarmMode = name;
        this.actions({ swarmMode: name });
        return `ok wm ${name}`;
      }
      return 'err cmd';
    }
    if (l[0] === 'k') {   // console.cpp: kl / kr wink (DESIGN.md §6.5.1)
      if ((l === 'kl' || l === 'kr')) {
        this.actions({ wink: l === 'kl' ? 1 : 2 });
        return `ok ${l}`;
      }
      return 'err cmd';
    }
    if (l[0] === 'g') {   // console.cpp: g = free, g<name>, g<x>,<y>[,<ms>] (DESIGN.md §6.5.1)
      if (l === 'g') { this.actions({ look: null }); return 'ok g'; }
      if (/^[a-z]/.test(l[1])) {
        const t = LOOK_NAMES[l.slice(1)];
        if (!Object.hasOwn(LOOK_NAMES, l.slice(1))) return 'err cmd';
        this.actions({ look: { x: t[0], y: t[1], ms: 0 } });
        return `ok g ${l.slice(1)}`;
      }
      const m = /^(-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)),(-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+))(?:,([0-9]{1,6}))?$/.exec(l.slice(1));
      if (!m) return 'err range g';
      const x = Number(m[1]);
      const y = Number(m[2]);
      const ms = m[3] === undefined ? 0 : Number(m[3]);
      if (!(x >= -1 && x <= 1 && y >= -1 && y <= 1 && ms <= 10000)) return 'err range g';
      this.actions({ look: { x, y, ms } });
      return `ok g ${l.slice(1)}`;
    }
    if (l[0] === 'r') {   // console.cpp: r<id> = play a routine, r = stop, r? = list (serial only) (ROUTINES.md §R8)
      if (l === 'r') { this.actions({ routine: null }); return 'ok r'; }
      if (l === 'r?') return 'err cmd';
      const id = l.slice(1);
      if (!this.routineIds.includes(id)) return 'err range r';
      this.actions({ routine: id });
      return `ok r ${id}`;
    }
    if (l === 's') { this.actions({ autoStyle: true }); return 'ok s'; }
    if (l[0] === 's' && l[1] !== '?') {
      const rest = l.slice(1);
      const idx = /^[0-9]/.test(rest) ? Number.parseInt(rest, 10) : this.styleIds.indexOf(rest);
      if (idx >= 0 && idx < this.styleIds.length) {
        this.actions({ style: idx });
        return `ok s ${this.styleIds[idx]}`;
      }
      return 'err range s';
    }
    return 'err cmd';
  }

  /**
   * console.cpp swarmSet(): "wset <key>=<value>", a swarm setting (night, blePin) for every unit.
   * Checked as by set; applied here too while this unit follows the swarm's value.
   */
  swarmSet(arg) {
    const eq = arg.indexOf('=');
    const key = eq > 0 ? arg.slice(0, eq) : '';
    if (!key || key.length >= 24) return 'err cmd';
    const d = this.def(key);
    if ((key !== 'night' && key !== 'blePin') || !d) return `err key ${key}`;
    const text = arg.slice(eq + 1);
    const p = parseValue(d, text, { styleIds: this.styleIds });
    if (!p.ok) return `err ${p.err} ${key}`;
    if (this.caps.has('ldr') && crossCheck({ ...this.values, [key]: p.value })) return `err range ${key}`;
    this.swarmCfg[key] = p.value;
    this.actions({ swarmCfg: key, value: p.value });
    if (key === 'night' ? this.values.nightSw : this.values.pinSw) this.set(key, text);
    const shown = d.secret ? (p.value ? 'set' : '0') : formatValue(d, p.value);
    return `ok wset ${key}=${shown}`;
  }

  /** settings.cpp poll(): the debounced save, 3 s after the last change. */
  poll(nowMs = Date.now()) {
    if (this.dirty.size && nowMs - this.lastSetMs >= 3000) this.save();
  }

  /** A fresh boot: stored values become current (what the firmware does in settings::begin). */
  reboot() {
    this.save();
    const vals = { ...this.defaults };
    for (const [k, t] of Object.entries(this.stored)) {
      const p = parseValue(this.def(k), t, { styleIds: this.styleIds });
      if (p.ok) vals[k] = p.value;
    }
    this.values = vals;
    this.rebootNeeded = false;
    this.restartPending = false;
    this.authed = false;
    this.erased = false;
  }
}
