// Web Bluetooth link to a halloweyes unit (docs/BLE.md §B5, §B7). Browser-only.
//
// Web Bluetooth allows one GATT operation at a time per device, so every read and write goes
// through one promise queue. A command resolves with the next REPLY notification (the firmware
// answers every BLE command with exactly one reply, in order).

import { UUID } from './protocol.js?v=372e0e069c';

const REPLY_TIMEOUT_MS = 4000;

export function bluetoothSupport() {
  if (typeof navigator === 'undefined' || !navigator.bluetooth) return { ok: false, why: 'missing' };
  if (typeof window !== 'undefined' && !window.isSecureContext) return { ok: false, why: 'insecure' };
  return { ok: true };
}

export class BleLink {
  constructor() {
    this.kind = 'ble';
    this.device = null;
    this.chars = {};
    this.queue = Promise.resolve();
    this.waiters = [];          // pending command resolvers, in send order
    this.listening = new WeakSet();
    this.onDisconnect = null;
    this.decoder = new TextDecoder();
    this.encoder = new TextEncoder();
  }

  get name() { return this.device ? (this.device.name || 'halloweyes') : ''; }

  /** Shows the browser's device picker (must run from a user gesture), then connects. */
  async connect() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [UUID.service] }],
      optionalServices: [UUID.service],
    });
    this.device.addEventListener('gattserverdisconnected', () => this.handleDisconnect());
    await this.attach();
  }

  /** Connects again to the device picked before (after a reboot or a dropped link): no picker. */
  async reconnect() {
    if (!this.device) throw new Error('no device');
    await this.attach();
  }

  async attach() {
    this.queue = Promise.resolve();
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(UUID.service);
    for (const k of ['info', 'settings', 'status', 'command', 'reply']) {
      this.chars[k] = await svc.getCharacteristic(UUID[k]);
    }
    if (!this.listening.has(this.chars.reply)) {   // the same object may come back on a reconnect
      this.listening.add(this.chars.reply);
      this.chars.reply.addEventListener('characteristicvaluechanged', (ev) => {
        const text = this.decoder.decode(ev.target.value);
        const w = this.waiters.shift();
        if (w) w.resolve(text);
      });
    }
    await this.chars.reply.startNotifications();
  }

  handleDisconnect() {
    for (const w of this.waiters.splice(0)) w.reject(new Error('disconnected'));
    this.chars = {};
    if (this.onDisconnect) this.onDisconnect();
  }

  /** Runs fn after every queued GATT operation has finished. */
  enqueue(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  async readJson(which) {
    return this.enqueue(async () => {
      const ch = this.chars[which];
      if (!ch) throw new Error('not connected');
      const v = await ch.readValue();
      return JSON.parse(this.decoder.decode(v));
    });
  }

  readInfo() { return this.readJson('info'); }
  readSettings() { return this.readJson('settings'); }
  readStatus() { return this.readJson('status'); }

  /** Sends one §B4 command and resolves with its reply line. */
  command(text) {
    return this.enqueue(async () => {
      const ch = this.chars.command;
      if (!ch) throw new Error('not connected');
      const reply = new Promise((resolve, reject) => {
        const w = { resolve, reject };
        this.waiters.push(w);
        setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) { this.waiters.splice(i, 1); reject(new Error('no reply')); }
        }, REPLY_TIMEOUT_MS);
      });
      const bytes = this.encoder.encode(text);
      if (ch.writeValueWithResponse) await ch.writeValueWithResponse(bytes);
      else await ch.writeValue(bytes);
      return reply;
    });
  }

  async disconnect() {
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
  }
}
