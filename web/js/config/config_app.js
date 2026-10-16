// halloweyes config page (docs/BLE.md §B7): connects over Web Bluetooth (or to a demo unit),
// shows live status, sends show commands, and edits the runtime settings of shared/settings.json.

import { loadSchema, schemaHash, available, parseValue } from './settings_schema.js';
import { parseReply } from './protocol.js';
import { BleLink, bluetoothSupport } from './ble_link.js';
import { MockLink } from './mock_link.js';
import { loadStyles } from '../styles.js';
import { drawThumbnail, LivePreview } from './preview.js';

const $ = (id) => document.getElementById(id);
const STATUS_POLL_MS = 1500;
const SLIDER_THROTTLE_MS = 150;
const CUSTOM_KEYS = new Set(['styles', 'pin']);   // edited in the Styles card

const S = {
  schema: null,
  styles: null,          // local styles (shared/styles.json), for names and previews
  link: null,
  info: null,
  caps: new Set(),
  values: {},            // key -> wire text, as last confirmed by the unit
  controls: new Map(),   // key -> {show(text), field}
  status: null,
  pollTimer: 0,
  preview: null,
  selected: 0,           // index into info.styles
  rebootWanted: false,
  inflight: new Map(),   // key -> true while a set is on the way
  pendingSet: new Map(), // key -> latest text to send after the in-flight one
  lostReason: '',
  authPromise: null,
};

// ------------------------------------------------------------------ helpers

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
}

let toastTimer = 0;
function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${bad ? ' bad' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

function log(line, bad = false) {
  const ol = $('log');
  const li = el('li', { class: bad ? 'bad' : '', text: `${new Date().toLocaleTimeString()}  ${line}` });
  ol.prepend(li);
  while (ol.children.length > 60) ol.lastChild.remove();
}

function setPill(text, cls) {
  const p = $('connPill');
  p.textContent = text;
  p.className = `pill ${cls}`;
}

function styleName(id) {
  const s = S.styles.find((x) => x.id === id);
  return s ? s.name : id;
}

function localIndex(id) { return S.styles.findIndex((s) => s.id === id); }

function defOf(key) { return S.schema.byKey.get(key); }

const ERR_TEXT = {
  range: 'That value is out of range',
  type: 'That value has the wrong format',
  key: 'This unit does not have that setting',
  auth: 'PIN required',
  cmd: 'The unit did not understand that',
};

// ------------------------------------------------------------------ commands

/** Shows the PIN dialog; resolves with the entered PIN, or null when cancelled. */
function pinFromDialog() {
  return new Promise((resolve) => {
    const dlg = $('pinDialog');
    const input = $('pinInput');
    const ok = $('pinOk');
    const cancel = dlg.querySelector('button[value=cancel]');
    input.value = '';
    const done = (v) => {
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
      if (dlg.open) dlg.close();
      resolve(v);
    };
    const onOk = (e) => { e.preventDefault(); done(input.value.trim()); };
    const onCancel = (e) => { e.preventDefault(); done(null); };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancel);   // Esc
    dlg.showModal();
    setTimeout(() => input.focus(), 50);
  });
}

async function askPin() {
  if (!S.authPromise) {
    S.authPromise = (async () => {
      const pin = await pinFromDialog();
      if (pin === null) return false;
      const r = parseReply(await S.link.command(`auth ${pin}`));
      log(`auth -> ${r.text}`, !r.ok);
      if (!r.ok) toast(r.words.includes('locked') ? 'Too many wrong PINs. Wait a minute.' : 'Wrong PIN', true);
      return r.ok;
    })().finally(() => { S.authPromise = null; });
  }
  return S.authPromise;
}

/** Sends one command; asks for the PIN once if the unit wants it. Returns the parsed reply. */
async function send(text, { quiet = false } = {}) {
  if (!S.link) throw new Error('not connected');
  let r = parseReply(await S.link.command(text));
  let pinHandled = false;   // askPin() already told the user what went wrong
  if (!r.ok && r.err === 'auth' && !r.words.includes('locked')) {
    if (await askPin()) r = parseReply(await S.link.command(text));
    else pinHandled = true;
  }
  log(`${text} -> ${r.text}`, !r.ok);
  if (!r.ok && !quiet && !pinHandled) toast(ERR_TEXT[r.err] || r.text, true);
  return r;
}

/** Coalescing setter: one set per key in flight; the latest value wins. */
async function setSetting(key, text) {
  if (S.inflight.get(key)) { S.pendingSet.set(key, text); return; }
  S.inflight.set(key, true);
  try {
    const r = await send(`set ${key}=${text}`);
    if (r.ok && r.key === key) {
      S.values[key] = r.value;
      if (r.apply === 'reboot') showRebootBar(true);
      if (r.apply === 'restart') toast('Saved. The show restarts with the change.');
    }
    if (!S.pendingSet.has(key)) S.controls.get(key)?.show(S.values[key], !r.ok);
  } catch (e) {
    toast(String(e.message || e), true);
  } finally {
    S.inflight.delete(key);
    if (S.pendingSet.has(key)) {
      const next = S.pendingSet.get(key);
      S.pendingSet.delete(key);
      if (next !== S.values[key]) setSetting(key, next);
      else S.controls.get(key)?.show(S.values[key]);
    }
  }
}

function showRebootBar(on) {
  S.rebootWanted = S.rebootWanted || on;
  $('rebootBar').hidden = !S.rebootWanted;
}

// ------------------------------------------------------------------ setting controls

function badge(def) {
  if (def.apply === 'reboot') return el('span', { class: 'badge reboot', text: 'after reboot' });
  if (def.apply === 'restart') return el('span', { class: 'badge', text: 'restarts show' });
  return null;
}

function fieldShell(def, control, { inline = false } = {}) {
  const id = `f-${def.key}`;
  const head = inline
    ? null
    : el('label', { for: id }, def.label, def.unit ? el('span', { class: 'unit', text: `(${def.unit})` }) : null, badge(def));
  const f = el('div', { class: 'field' }, head, control, def.help ? el('p', { class: 'help', text: def.help }) : null);
  return f;
}

function rangeControl(def) {
  const id = `f-${def.key}`;
  const range = el('input', { type: 'range', min: def.min, max: def.max, step: def.step ?? 1, 'aria-label': def.label });
  const num = el('input', { type: 'number', class: 'num', id, min: def.min, max: def.max, step: def.step ?? 1, inputmode: 'decimal' });
  const field = fieldShell(def, el('div', { class: 'range-row' }, range, num));
  let last = 0;
  let timer = 0;
  const text = (v) => (def.type === 'float' ? Number(v).toFixed(def.decimals) : String(Math.round(Number(v))));
  const sendNow = (v) => { clearTimeout(timer); last = performance.now(); setSetting(def.key, text(v)); };
  range.addEventListener('input', () => {
    num.value = text(range.value);
    const wait = SLIDER_THROTTLE_MS - (performance.now() - last);
    clearTimeout(timer);
    if (wait <= 0) sendNow(range.value);
    else timer = setTimeout(() => sendNow(range.value), wait);
  });
  range.addEventListener('change', () => sendNow(range.value));
  num.addEventListener('change', () => {
    const p = parseValue(def, num.value);
    if (!p.ok) { toast(ERR_TEXT[p.err], true); show(S.values[def.key]); return; }
    range.value = num.value;
    sendNow(num.value);
  });
  function show(v, bad) {
    range.value = v;
    num.value = v;
    field.classList.toggle('err', !!bad);
  }
  return { field, show };
}

function boolControl(def) {
  const id = `f-${def.key}`;
  const input = el('input', { type: 'checkbox', id, role: 'switch' });
  const sw = el('label', { class: 'switch', for: id }, input, el('span'), el('span', { class: 'sr', text: '' }));
  sw.querySelector('.sr').remove();
  const head = el('div', { class: 'switch-row' },
    el('span', { class: 'label' }, def.label, badge(def)), sw);
  const field = el('div', { class: 'field' }, head, def.help ? el('p', { class: 'help', text: def.help }) : null);
  input.addEventListener('change', () => setSetting(def.key, input.checked ? '1' : '0'));
  return { field, show: (v) => { input.checked = v === '1'; } };
}

function rotationControl(def) {
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': def.label });
  const btns = [0, 1, 2, 3].map((q) => el('button', {
    type: 'button', 'aria-pressed': 'false', text: `${q * 90}°`, onclick: () => setSetting(def.key, String(q)),
  }));
  seg.append(...btns);
  const field = fieldShell(def, seg);
  return { field, show: (v) => btns.forEach((b, i) => b.setAttribute('aria-pressed', String(String(i) === v))) };
}

function textControl(def) {
  const id = `f-${def.key}`;
  const input = el('input', { type: 'text', id, maxlength: def.maxLen, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'default' });
  const btn = el('button', { class: 'secondary small', type: 'button', text: 'Set' });
  const field = fieldShell(def, el('div', { class: 'row' }, input, btn));
  const go = () => setSetting(def.key, input.value.trim());
  btn.addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  return { field, show: (v, bad) => { input.value = v; field.classList.toggle('err', !!bad); } };
}

function pinCodeControl(def) {
  const id = `f-${def.key}`;
  const state = el('span', { class: 'badge' });
  const input = el('input', { type: 'text', id, inputmode: 'numeric', pattern: '[0-9]*', maxlength: 6, autocomplete: 'off', placeholder: 'new PIN (0 = none)' });
  const btn = el('button', { class: 'secondary small', type: 'button', text: 'Set' });
  const field = el('div', { class: 'field' },
    el('label', { for: id }, def.label, state),
    el('div', { class: 'row' }, input, btn),
    el('p', { class: 'help', text: def.help }));
  btn.addEventListener('click', async () => {
    const v = input.value.trim() || '0';
    await setSetting(def.key, v);
    input.value = '';
  });
  return { field, show: (v) => { state.textContent = v === 'set' ? 'PIN set' : 'no PIN'; } };
}

function makeControl(def) {
  if (def.secret) return pinCodeControl(def);
  if (def.type === 'bool') return boolControl(def);
  if (def.type === 'int' && /^rot[LR]$/.test(def.key)) return rotationControl(def);
  if (def.type === 'float' || def.type === 'int') return rangeControl(def);
  return textControl(def);
}

function buildGroups() {
  const host = $('groups');
  host.replaceChildren();
  S.controls.clear();
  for (const g of S.schema.groups) {
    if (g.id === 'styles') continue;
    const defs = S.schema.settings.filter((d) => d.group === g.id && !CUSTOM_KEYS.has(d.key) && available(d, S.caps));
    if (!defs.length) continue;
    const card = el('section', { class: 'card' }, el('h2', { text: g.label }));
    if (g.id === 'orient') {
      card.append(el('p', { class: 'help', text: 'Show the test card, then fix each eye until its arrow points up, the dot is on the right and red is red. These apply after a reboot.' }),
        el('div', { class: 'btn-grid', style: 'margin:10px 0 4px' },
          el('button', { class: 'secondary', type: 'button', text: 'Show test card (30 s)', onclick: () => runCmd('c') })));
    }
    for (const d of defs) {
      const c = makeControl(d);
      S.controls.set(d.key, c);
      card.append(c.field);
      c.show(S.values[d.key] ?? '');
    }
    host.append(card);
  }
}

// ------------------------------------------------------------------ status

function buildTiles(st) {
  const tiles = [
    ['Phase', st.ph],
    ['Style', styleName(st.st)],
    ['Showing', st.pin ? `only ${styleName(st.pin)}` : 'shuffle'],
  ];
  if (S.caps.has('ldr')) tiles.push(['Mode', st.mode], ['Power', st.pwr], ['Light', `${st.lmv} mV`]);
  tiles.push(['Brightness', `${Math.round((st.bri ?? 0) * 100)} %`]);
  if (S.caps.has('vbat')) tiles.push(['Battery', st.vb ? `${(st.vb / 1000).toFixed(2)} V` : '—']);
  tiles.push(['Frame rate', `${Number(st.fps ?? 0).toFixed(1)} fps`]);
  const up = st.up ?? 0;
  tiles.push(['Up', up >= 3600 ? `${Math.floor(up / 3600)} h ${Math.floor((up % 3600) / 60)} min` : `${Math.floor(up / 60)} min ${up % 60} s`]);
  tiles.push(['Settings', st.dirty ? 'saving…' : 'saved']);
  if (st.sw && st.sw !== '-') {   // swarm firmware (docs/SWARM.md): C = leading, F = following, J = searching
    const n = Number(st.sw.slice(1)) || 1;
    const role = { C: 'leading', F: 'following', J: 'searching' }[st.sw[0]] || st.sw;
    tiles.push(['Swarm', st.sw[0] === 'J' ? 'searching…' : `${role}, ${n} unit${n === 1 ? '' : 's'}`]);
  }
  $('tiles').replaceChildren(...tiles.map(([k, v]) => el('div', { class: 'tile' }, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: String(v) }))));
}

async function pollStatus(force = false) {
  if (!S.link || (document.hidden && !force)) return;
  try {
    const st = await S.link.readStatus();
    S.status = st;
    buildTiles(st);
    $('pinNow').value = st.pin || '';
    if (st.rb) showRebootBar(true);
  } catch { /* the next poll retries; a real disconnect arrives as an event */ }
}

// ------------------------------------------------------------------ styles card

function styleMask() { return parseInt(S.values.styles || '0', 16) >>> 0; }

function selectStyle(i) {
  S.selected = i;
  const id = S.info.styles[i];
  $('previewName').textContent = styleName(id);
  $('bootPin').checked = S.values.pin === id;
  const li = localIndex(id);
  if (S.preview && li >= 0) S.preview.setStyle(li);
  for (const t of $('styleGrid').children) t.setAttribute('aria-current', String(Number(t.dataset.i) === i));
}

function buildStyles() {
  const grid = $('styleGrid');
  grid.replaceChildren();
  const mask = styleMask();
  const thumbs = [];
  S.info.styles.forEach((id, i) => {
    const canvas = el('canvas', { 'aria-hidden': 'true' });
    const cb = el('input', { type: 'checkbox', 'aria-label': `${styleName(id)} in the shuffle` });
    cb.checked = (mask & (1 << i)) !== 0;
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => toggleInShuffle(i, cb));
    const tile = el('div', { class: `style-tile${cb.checked ? '' : ' off'}`, role: 'button', tabindex: '0', 'data-i': String(i) },
      canvas, el('div', { class: 'nm' }, el('span', { text: styleName(id) }), cb));
    tile.addEventListener('click', () => selectStyle(i));
    tile.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectStyle(i); } });
    grid.append(tile);
    const li = localIndex(id);
    if (li >= 0) thumbs.push([canvas, li]);
  });
  // Thumbnails one per task, so the page stays responsive while they render.
  const step = () => {
    const t = thumbs.shift();
    if (!t) return;
    drawThumbnail(t[0], S.styles, t[1], S.info.panel);
    setTimeout(step, 0);
  };
  setTimeout(step, 30);

  const pick = $('pinNow');
  pick.replaceChildren(el('option', { value: '', text: 'Shuffle (all enabled styles)' }),
    ...S.info.styles.map((id) => el('option', { value: id, text: styleName(id) })));

  if (!S.preview) S.preview = new LivePreview($('livePreview'), S.styles, S.info.panel);
  S.preview.panelId = S.info.panel;
  S.preview.spacing = Number(S.values.spacing) || 76;
  S.preview.restart();
  S.preview.start();
  const startIdx = S.values.pin ? Math.max(0, S.info.styles.indexOf(S.values.pin)) : 0;
  selectStyle(startIdx);
}

async function toggleInShuffle(i, cb) {
  let mask = styleMask();
  mask = cb.checked ? (mask | (1 << i)) >>> 0 : (mask & ~(1 << i)) >>> 0;
  if (mask === 0) {
    cb.checked = true;
    toast('Keep at least one style in the shuffle', true);
    return;
  }
  cb.closest('.style-tile').classList.toggle('off', !cb.checked);
  await setSetting('styles', mask.toString(16));
  const now = styleMask();
  for (const t of $('styleGrid').children) {
    const on = (now & (1 << Number(t.dataset.i))) !== 0;
    t.classList.toggle('off', !on);
    t.querySelector('input').checked = on;
  }
}

// ------------------------------------------------------------------ connection

async function runCmd(cmd) {
  try {
    const r = await send(cmd);
    if (r.ok && cmd === 'c') toast('Test card on the unit for 30 seconds');
  } catch (e) {
    toast(String(e.message || e), true);
  }
}

function showScreen(which) {
  $('welcome').hidden = which !== 'welcome';
  $('connected').hidden = which !== 'connected';
  $('lost').hidden = which !== 'lost';
  $('disconnectBtn').hidden = which !== 'connected';
}

async function afterConnect() {
  setPill('Reading…', 'busy');
  S.info = await S.link.readInfo();
  S.caps = new Set(S.info.caps || []);
  S.values = await S.link.readSettings();
  S.rebootWanted = false;
  $('rebootBar').hidden = true;
  $('devName').textContent = S.info.name || S.link.name || 'halloweyes';
  const build = { poc: 'PoC', oled: 'OLED', 'full-battery': 'Full build (battery)', 'full-usb': 'Full build (USB)' }[S.info.build] || S.info.build;
  $('devMeta').textContent = `${build} · firmware ${S.info.fw}${S.link.kind === 'demo' ? ' · demo' : ''}`;
  const mine = schemaHash(S.schema);
  const warn = $('schemaWarn');
  const missing = S.info.styles.filter((id) => localIndex(id) < 0);
  if (S.info.schema && S.info.schema !== mine) {
    warn.textContent = `This page (settings ${mine}) and the unit's firmware (settings ${S.info.schema}) come from different versions. Some settings may not work. Update the firmware or the page.`;
    warn.hidden = false;
  } else if (missing.length) {
    warn.textContent = `The unit has styles this page does not know (${missing.join(', ')}); they have no preview.`;
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
  $('cardBtn').hidden = !S.caps.has('card');
  buildGroups();
  buildStyles();
  showScreen('connected');
  setPill(S.link.kind === 'demo' ? 'Demo unit' : S.link.name, 'on');
  await pollStatus(true);
  clearInterval(S.pollTimer);
  S.pollTimer = setInterval(pollStatus, STATUS_POLL_MS);
}

function onLost() {
  clearInterval(S.pollTimer);
  S.pollTimer = 0;
  if (S.preview) S.preview.stop();
  setPill('Not connected', 'off');
  $('rebootBar').hidden = true;
  const rebooting = S.lostReason === 'reboot';
  $('lostTitle').textContent = rebooting ? 'Rebooting' : 'Disconnected';
  $('lostText').textContent = rebooting
    ? 'The unit is restarting. It is connectable again in a few seconds, for the length of its Bluetooth window.'
    : 'The connection dropped. The unit may be out of range, or its Bluetooth window has closed (press RESET on the unit to reopen it).';
  S.lostReason = '';
  showScreen('lost');
}

async function connect(kind) {
  const profile = $('demoProfile').value;
  const link = kind === 'ble' ? new BleLink() : new MockLink({ schema: S.schema, styles: S.styles, profile, name: 'HE-DEMO' });
  link.onDisconnect = onLost;
  setPill('Connecting…', 'busy');
  try {
    await link.connect();
    S.link = link;
    await afterConnect();
  } catch (e) {
    setPill('Not connected', 'off');
    if (e && e.name === 'NotFoundError') return;   // the user closed the device picker
    toast(`Could not connect: ${e.message || e}`, true);
    log(`connect failed: ${e.message || e}`, true);
  }
}

async function reconnect() {
  if (!S.link) { showScreen('welcome'); return; }
  setPill('Connecting…', 'busy');
  try {
    await S.link.reconnect();
    await afterConnect();
  } catch (e) {
    setPill('Not connected', 'off');
    toast(`Could not reconnect: ${e.message || e}`, true);
  }
}

async function reboot() {
  S.lostReason = 'reboot';
  const r = await send('reboot');
  if (!r.ok) S.lostReason = '';
}

// ------------------------------------------------------------------ wiring

function wire() {
  $('connectBtn').addEventListener('click', () => connect('ble'));
  $('demoBtn').addEventListener('click', () => connect('demo'));
  $('disconnectBtn').addEventListener('click', async () => { await S.link?.disconnect(); });
  $('reconnectBtn').addEventListener('click', reconnect);
  $('homeBtn').addEventListener('click', () => { S.link = null; showScreen('welcome'); });
  for (const b of document.querySelectorAll('[data-cmd]')) b.addEventListener('click', () => runCmd(b.dataset.cmd));
  $('pinNow').addEventListener('change', (e) => runCmd(e.target.value ? `s${e.target.value}` : 's'));
  $('showNowBtn').addEventListener('click', () => runCmd(`s${S.info.styles[S.selected]}`));
  $('bootPin').addEventListener('change', async (e) => {
    const id = S.info.styles[S.selected];
    await setSetting('pin', e.target.checked ? id : '');
    $('bootPin').checked = S.values.pin === id;
  });
  $('saveBtn').addEventListener('click', async () => {
    const r = await send('save');
    if (r.ok) toast(r.words[1] === '0' ? 'Nothing to save' : 'Saved');
  });
  $('rebootBtn').addEventListener('click', reboot);
  $('rebootNowBtn').addEventListener('click', reboot);
  $('defaultsBtn').addEventListener('click', async () => {
    if (!confirm('Erase all settings on this unit? It goes back to its build defaults after a reboot.')) return;
    const r = await send('defaults');
    if (r.ok) { showRebootBar(true); toast('Settings erased. Reboot to apply the defaults.'); }
  });
  document.addEventListener('visibilitychange', () => {
    if (!S.preview || $('connected').hidden) return;
    if (document.hidden) S.preview.stop();
    else { S.preview.start(); pollStatus(); }
  });
}

function showSupport() {
  const sup = bluetoothSupport();
  const box = $('btSupport');
  if (sup.ok) { box.hidden = true; return; }
  const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  box.innerHTML = sup.why === 'insecure'
    ? 'Bluetooth needs a secure page. Open this page over <b>https://</b> (or from <b>localhost</b> on a computer).'
    : iOS
      ? 'Safari cannot talk to Bluetooth devices. Open this page in <b>Bluefy</b> (free on the App Store) to connect. The demo works here.'
      : 'This browser has no Web Bluetooth. Use <b>Chrome</b> or <b>Edge</b> (desktop or Android) to connect. The demo works here.';
  box.hidden = false;
  $('connectBtn').disabled = true;
}

async function main() {
  wire();
  showSupport();
  try {
    [S.schema, S.styles] = await Promise.all([loadSchema(), loadStyles('../shared/styles.json')]);
  } catch (e) {
    $('btSupport').innerHTML = `Could not load the page data (${e.message || e}). Serve the repository root (<code>node tools/serve.mjs</code>) or the built folder (<code>build/config/</code>).`;
    $('btSupport').hidden = false;
    $('connectBtn').disabled = true;
    $('demoBtn').disabled = true;
    throw e;
  }
  showScreen('welcome');
  if (new URLSearchParams(location.search).has('demo')) {
    const p = new URLSearchParams(location.search).get('demo');
    if (p && $('demoProfile').querySelector(`option[value="${p}"]`)) $('demoProfile').value = p;
    connect('demo');
  }
}

main();
