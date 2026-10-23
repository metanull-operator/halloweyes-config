// Demo device link (docs/BLE.md §B7): the same interface as BleLink, backed by DemoDevice (the
// firmware's command processor in JS) and a running Director, so status, pins and restarts behave
// like a real unit. DOM-free; usable from Node with injected styles.

import { Director } from '../director.js';
import { DemoDevice, PROFILES, SWARM_MODE_NAMES, SWARM_MODE_LETTERS } from './protocol.js';
import { schemaHash } from './settings_schema.js';

const TICK_MS = 1000 / 24;
const PHASES = ['Dark', 'Appear', 'Watch', 'Transition', 'Vanish', 'Startle'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MockLink {
  /** opts: {schema, styles (normalized), profile, latencyMs, name} */
  constructor(opts) {
    this.kind = 'demo';
    this.opts = opts;
    this.styles = opts.styles;
    this.latency = opts.latencyMs ?? 40;
    this.onDisconnect = null;
    this.connected = false;
    this.timer = null;
    this.device = new DemoDevice({
      schema: opts.schema,
      styleIds: this.styles.map((s) => s.id),
      profile: opts.profile || 'poc',
      name: opts.name || 'HE-DEMO',
      schemaId: schemaHash(opts.schema),
      actions: (a) => this.onAction(a),
    });
    this.bootMs = Date.now();
    this.pending = {};
    this.pinned = -1;
    this.startShow();
  }

  get name() { return this.device.name; }
  get profile() { return PROFILES[this.opts.profile || 'poc']; }

  startShow() {
    const v = this.device.values;
    const mask = v.styles >>> 0;
    const table = this.styles.map((s, i) => {
      if (mask & (1 << i)) return s;
      return { ...s, weight: 0, id: s.id === 'hellfire' ? '' : s.id };   // main.cpp buildShowStyles()
    });
    this.simMs = 0;
    this.director = new Director(table, (Math.random() * 0xffffffff) >>> 0, 0, v.spacing, 16.2);
    this.pinned = v.pin ? this.styles.findIndex((s) => s.id === v.pin) : -1;
    this.fs = null;
  }

  tick() {
    this.device.poll();
    this.simMs += TICK_MS;
    const p = this.pending;
    this.pending = {};
    this.fs = this.director.update(this.simMs, {
      pir: false, nextStyle: !!p.next, forceBlink: !!p.blink, forceStartle: !!p.startle, forceAppear: !!p.appear,
      forceStyle: this.pinned,
    });
  }

  onAction(a) {
    if (a.next) this.pending.next = true;
    if (a.blink) this.pending.blink = true;
    if (a.startle) this.pending.startle = true;
    if (a.appear) this.pending.appear = true;
    if (a.autoStyle) this.pinned = -1;
    if (Number.isInteger(a.style)) this.pinned = a.style;
    // The whole swarm (the demo swarm is this unit and two more that are not drawn): an action runs
    // half a second later, as on a real swarm tick.
    const act = { 1: 'blink', 2: 'startle', 3: 'appear', 4: 'next' }[a.swarmAction];
    if (act) setTimeout(() => { this.pending[act] = true; }, 500);
    if (Number.isInteger(a.swarmPin)) this.pinned = a.swarmPin >= 0 ? a.swarmPin : -1;
    if (a.identify) [0, 700, 1400].forEach((ms) => setTimeout(() => { this.pending.blink = true; }, ms));
    // Following the swarm again takes its value (firmware swarm.cpp applyCfg).
    const d = this.device;
    if (a.setting === 'nightSw' && a.value && d.swarmCfg.night != null) d.values.night = d.swarmCfg.night;
    if (a.setting === 'pinSw' && a.value && d.swarmCfg.blePin != null) d.values.blePin = d.swarmCfg.blePin;
    if (a.apply === 'restart') this.startShow();
    if (a.reboot) setTimeout(() => this.simulateReboot(), 300);
    if (a.disconnect) setTimeout(() => this.dropConnection(), 50);
  }

  simulateReboot() {
    this.device.reboot();
    this.bootMs = Date.now();
    this.startShow();
    this.dropConnection();
  }

  dropConnection() {
    if (!this.connected) return;
    this.connected = false;
    clearInterval(this.timer);
    this.timer = null;
    if (this.onDisconnect) this.onDisconnect();
  }

  async connect() {
    await sleep(this.latency * 3);
    this.connected = true;
    this.device.authed = false;
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  reconnect() { return this.connect(); }

  async op(fn) {
    if (!this.connected) throw new Error('not connected');
    await sleep(this.latency * (0.6 + Math.random() * 0.8));
    if (!this.connected) throw new Error('disconnected');
    return fn();
  }

  readInfo() { return this.op(() => JSON.parse(this.device.infoJson())); }
  readSettings() { return this.op(() => JSON.parse(this.device.settingsJson())); }
  readStatus() { return this.op(() => JSON.parse(this.statusJson())); }
  command(text) { return this.op(() => this.device.command(text)); }

  statusJson() {
    const d = this.device;
    const fs = this.fs;
    const caps = d.caps;
    const st = fs ? this.styles[fs.style]?.id ?? '?' : '?';
    const swarmCfg = d.swarm ? {   // main.cpp publishStatus: brightness x 100 and PIN set, -1 = never set
      sb: d.swarmCfg.night == null ? -1 : Math.round(d.swarmCfg.night * 100),
      sp: d.swarmCfg.blePin == null ? -1 : (d.swarmCfg.blePin ? 1 : 0),
    } : {};
    return JSON.stringify({
      ph: fs ? PHASES[fs.phase] : 'Dark', st, pin: this.pinned >= 0 ? this.styles[this.pinned].id : '',
      mode: d.mode, pwr: 'Show', bri: Number(d.values.night.toFixed(2)), lmv: caps.has('ldr') ? 640 : 0,
      vb: caps.has('vbat') ? 3940 : 0, fps: 24.0, up: Math.floor((Date.now() - this.bootMs) / 1000),
      dirty: d.dirty.size ? 1 : 0, rb: d.rebootNeeded ? 1 : 0,
      sw: d.swarm ? `C3${SWARM_MODE_LETTERS[SWARM_MODE_NAMES.indexOf(d.swarmMode)]}` : '-',   // a demo swarm of 3, this unit leading
      ...swarmCfg,
    });
  }

  async disconnect() { this.dropConnection(); }
}
