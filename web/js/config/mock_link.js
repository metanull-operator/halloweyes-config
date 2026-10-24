// Demo device link (docs/BLE.md §B7): the same interface as BleLink, backed by DemoDevice (the
// firmware's command processor in JS) and a running Director, so status, pins and restarts behave
// like a real unit. DOM-free; usable from Node with injected styles.

import { Director, CUE_NONE, CUE_VANISH } from '../director.js?v=f2f2c73996';
import { compileRoutine, RoutinePlayer } from '../routine.js?v=f2f2c73996';
import { DemoDevice, PROFILES, SWARM_MODE_NAMES, SWARM_MODE_LETTERS } from './protocol.js?v=f2f2c73996';
import { schemaHash } from './settings_schema.js?v=f2f2c73996';

const TICK_MS = 1000 / 24;
const PHASES = ['Dark', 'Appear', 'Watch', 'Transition', 'Vanish', 'Startle'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MockLink {
  /** opts: {schema, styles (normalized), routines (shared/routines.json, optional), profile, latencyMs, name} */
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
      routineIds: opts.routines ? opts.routines.routines.map((r) => r.id) : [],
      profile: opts.profile || 'poc',
      name: opts.name || 'HE-DEMO',
      schemaId: schemaHash(opts.schema),
      actions: (a) => this.onAction(a),
    });
    this.bootMs = Date.now();
    this.pending = {};
    this.pinned = -1;
    this.player = null;     // RoutinePlayer while a routine plays (r<id>, docs/ROUTINES.md §R8)
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
    this.player = null;     // main.cpp startShow(): a restart stops the routine
    this.director = new Director(table, (Math.random() * 0xffffffff) >>> 0, 0, v.spacing, 16.2);
    this.pinned = v.pin ? this.styles.findIndex((s) => s.id === v.pin) : -1;
    this.fs = null;
  }

  tick() {
    this.device.poll();
    if (this.device.swarm) this.updateDemoActivity();
    this.simMs += TICK_MS;
    const p = this.pending;
    this.pending = {};
    const inputs = {
      pir: false, nextStyle: !!p.next, forceBlink: !!p.blink, forceStartle: !!p.startle, forceAppear: !!p.appear,
      cue: p.disappear ? CUE_VANISH : CUE_NONE,
      forceStyle: this.pinned, forceWink: p.wink || 0,
      lookOn: !!this.look, lookX: this.look ? this.look.x : 0, lookY: this.look ? this.look.y : 0,
      lookMs: this.look ? this.look.ms : 0,
    };
    if (this.player && !this.player.inputs(this.simMs, inputs)) this.player = null;   // routine-owned inputs
    this.fs = this.director.update(this.simMs, inputs);
  }

  /** The demo's `wact` read-out after a motion: the first gets the big scare, the next ones less. */
  demoMotion() {
    const now = Date.now();
    const recent = this.demoLastMotion && now - this.demoLastMotion < 45000;
    this.demoTokens = Math.max(0, (this.demoTokens ?? 3) - (recent ? 0 : 1));
    this.demoOutcome = recent ? 'cooldown' : (this.demoTokens > 0 ? 'big' : 'look');
    if (!recent) this.demoLastMotion = now;
    this.demoLastSeen = now;
    this.updateDemoActivity();
  }

  updateDemoActivity() {
    const ago = this.demoLastSeen ? Math.round((Date.now() - this.demoLastSeen) / 1000) : '-';
    const v = Number.isInteger(this.demoVisitors) ? this.demoVisitors : 0;
    this.device.activity = `fresh ${this.demoTokens ?? 3} 0 - ${this.demoOutcome || 'none'} ${ago} ${this.demoOutcome ? 2 : '-'} ` +
      `${v} ${this.demoOrder ? 2 : '-'} ${this.demoLineup || 0} 3`;
  }

  onAction(a) {
    if (a.next) this.pending.next = true;
    if (a.blink) this.pending.blink = true;
    if (a.startle) this.pending.startle = true;
    if (a.appear) this.pending.appear = true;
    if (a.disappear) this.pending.disappear = true;
    // The demo swarm (this unit and two that are not drawn): motion, visitors and line-up, roughly.
    if (a.motion) { this.pending.pir = true; this.demoMotion('big'); }
    if (a.visitor) setTimeout(() => { this.pending.startle = true; this.demoMotion('big'); }, 1500);
    if (Number.isInteger(a.visitorsAuto)) this.demoVisitors = a.visitorsAuto;
    if (Number.isInteger(a.lineup)) this.demoLineup = a.lineup;
    if (a.lineupOrder) this.demoOrder = a.lineupOrder.length ? 1 : null;
    if (a.wink) this.pending.wink = a.wink;
    if (a.look !== undefined) this.look = a.look;   // null = free
    if (a.routine === null) this.player = null;
    if (typeof a.routine === 'string') {
      this.player = new RoutinePlayer(compileRoutine(this.opts.routines, a.routine, this.styles));
      this.player.start(this.simMs);
    }
    if (a.autoStyle) this.pinned = -1;
    if (Number.isInteger(a.style)) this.pinned = a.style;
    // The whole swarm (the demo swarm is this unit and two more that are not drawn): an action runs
    // half a second later, as on a real swarm tick.
    // Fade out / Fade in: this unit's place among the three is the middle one (1.5 s into the 3 s spread).
    const act = { 1: 'blink', 2: 'startle', 3: 'appear', 4: 'next', 5: 'disappear', 6: 'disappear', 7: 'appear' }[a.swarmAction];
    if (act) setTimeout(() => { this.pending[act] = true; }, a.swarmAction >= 6 ? 2000 : 500);
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
