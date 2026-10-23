// halloweyes config page (docs/BLE.md §B7): connects over Web Bluetooth (or to a demo unit),
// shows live status, sends show commands, and edits the runtime settings of shared/settings.json.

import { loadSchema, schemaHash, available, parseValue } from './settings_schema.js';
import { parseReply } from './protocol.js';
import { BleLink, bluetoothSupport } from './ble_link.js';
import { MockLink } from './mock_link.js';
import { loadStyles } from '../styles.js';
import { compileRoutine } from '../routine.js';
import { drawThumbnail, LivePreview } from './preview.js';

const $ = (id) => document.getElementById(id);
const STATUS_POLL_MS = 1500;
const SLIDER_THROTTLE_MS = 150;
const CUSTOM_KEYS = new Set(['styles', 'pin']);   // edited in the Styles card

// Swarm modes (docs/SWARM.md §S0): STATUS "sw" is role + unit count + mode letter, e.g. "C3H".
const SWARM_MODES = [
  { id: 'hive', letter: 'H', label: 'Hive',
    help: 'Every unit shows the same eyes at the same moment. Blinks are nearly together, each a little off, like a group trying to blink in time. Next style changes all units.' },
  { id: 'chorus', letter: 'C', label: 'Chorus',
    help: 'All units appear, change style and vanish together. Blinks and glances are each unit\'s own. Next style changes all units.' },
  { id: 'pack', letter: 'P', label: 'Pack',
    help: 'The same eyes on every unit, each on its own timing. The style changes every few minutes and spreads from unit to unit. Next style changes it for all.' },
  { id: 'scatter', letter: 'S', label: 'Scatter',
    help: 'Each unit runs its own show, and no two show the same style at once.' },
  { id: 'solo', letter: 'O', label: 'Solo',
    help: 'Each unit runs its own show, as if alone. The units stay linked, ready for another mode.' },
];

/** Parses STATUS "sw" ("C3H", "F2P", "J1H"; "-" = no swarm firmware). */
function parseSwarm(sw) {
  if (!sw || sw === '-') return null;
  const m = /^([CFJ])(\d+)([A-Z])?$/.exec(sw);
  if (!m) return null;
  return { role: m[1], units: Number(m[2]), mode: SWARM_MODES.find((x) => x.letter === m[3]) || null };
}

function buildSwarmCard() {
  const box = $('swarmModes');
  if (box.childElementCount) return;
  for (const md of SWARM_MODES) {
    box.append(el('button', { type: 'button', 'aria-pressed': 'false', 'data-mode': md.id, text: md.label,
      onclick: () => switchSwarm(md) }));
  }
}

// This unit's show controls that act on the whole swarm in a mode (main.cpp, swarm_driver.cpp):
// they live under Whole swarm there, and are disabled here with the reason.
const UNIT_GATE = {
  hive: { cmds: ['a', 'n'], pin: true,
    why: 'In Hive the units appear, change style and vanish together: Appear now, Next style and Show only are under Whole swarm. Startle here takes this unit out of step until the eyes next appear.' },
  chorus: { cmds: ['a', 'n'], pin: true,
    why: 'In Chorus the units appear, change style and vanish together: Appear now, Next style and Show only are under Whole swarm.' },
  pack: { cmds: ['n'], pin: true,
    why: 'In Pack every unit shows the same style: Next style and Show only are under Whole swarm.' },
};

function updateSwarm(st) {
  const sw = parseSwarm(st.sw);
  if (!S.swarmUi || !sw) return;
  const role = { C: 'this unit leads', F: 'following', J: 'searching for others…' }[sw.role];
  $('swarmMeta').textContent = sw.role === 'J' ? role : `${sw.units} unit${sw.units === 1 ? '' : 's'} · ${role}`;
  $('swarmSearching').hidden = sw.role !== 'J';
  for (const b of $('swarmModes').children) b.setAttribute('aria-pressed', String(!!sw.mode && b.dataset.mode === sw.mode.id));
  $('swarmHelp').textContent = sw.mode ? sw.mode.help : '';
  // Whole swarm: one style for every unit only in the modes that share a style.
  const own = sw.mode && (sw.mode.id === 'scatter' || sw.mode.id === 'solo');
  $('swarmPinSel').disabled = !!own;
  $('swarmPinSel').value = own ? '' : (st.pin || '');
  $('swarmPinHelp').textContent = own
    ? `In ${sw.mode.label} each unit picks its own styles. To show one style on every unit, switch to Hive, Chorus or Pack.`
    : 'Every unit shows this style until the swarm powers down.';
  // This unit: what is unit-only in this mode (a unit still searching runs its own show).
  const gate = (sw.role !== 'J' && sw.mode && UNIT_GATE[sw.mode.id]) || { cmds: [], pin: false, why: '' };
  for (const b of document.querySelectorAll('[data-cmd]')) b.disabled = gate.cmds.includes(b.dataset.cmd);
  $('pinNow').disabled = gate.pin;
  $('unitCtlHelp').textContent = gate.why;
  $('unitCtlHelp').hidden = !gate.why;
  // Swarm settings as this unit knows them (STATUS sb: brightness x 100, sp: PIN set; -1 = never set).
  if (!S.inflight.get('w:night')) {
    S.swarmVals.night = st.sb >= 0 ? (st.sb / 100).toFixed(2) : '';
    S.swarmControls.get('night')?.show(S.swarmVals.night || S.values.night || '0.55');
  }
  S.swarmVals.blePin = st.sp === 1 ? 'set' : st.sp === 0 ? '0' : '';
  S.swarmControls.get('blePin')?.show(S.swarmVals.blePin);
}

function buildSwarmView() {
  buildSwarmCard();
  const host = $('swarmFields');
  host.replaceChildren();
  S.swarmControls.clear();
  const night = defOf('night');
  const c = rangeControl({ ...night, label: 'Brightness', help: 'Night brightness of every unit.' },
    { set: (k, t) => setSetting(k, t, { swarm: true }), current: () => S.swarmVals.night, idPrefix: 'sw' });
  S.swarmControls.set('night', c);
  host.append(c.field);
  const pin = defOf('blePin');
  if (pin && S.caps.has('ble')) {
    const p = pinCodeControl({ ...pin, label: 'Bluetooth PIN',
      help: 'One PIN for every unit (0 = none). It travels between the units over the swarm radio, which is not encrypted.' },
    { set: (k, t) => setSetting(k, t, { swarm: true }), idPrefix: 'sw', states: { set: 'swarm PIN set', 0: 'no swarm PIN', '': 'not set yet' } });
    S.swarmControls.set('blePin', p);
    host.append(p.field);
  }
  const sel = $('swarmPinSel');
  sel.replaceChildren(el('option', { value: '', text: 'Shuffle (all enabled styles)' }),
    ...S.info.styles.map((id) => el('option', { value: id, text: styleName(id) })));
}

function setView(v) {
  S.view = v;
  $('viewSwarm').hidden = v !== 'swarm';
  $('viewUnit').hidden = v !== 'unit';
  $('tabSwarm').setAttribute('aria-selected', String(v === 'swarm'));
  $('tabUnit').setAttribute('aria-selected', String(v === 'unit'));
  $('tabSwarm').tabIndex = v === 'swarm' ? 0 : -1;
  $('tabUnit').tabIndex = v === 'unit' ? 0 : -1;
  try { localStorage.setItem('he.view', v); } catch { /* private mode: the view is not remembered */ }
}

// A unit that follows a swarm setting cannot set its own value: its control is locked, with why.
function updateFollow() {
  for (const [flag, key, what] of [['nightSw', 'night', 'brightness'], ['pinSw', 'blePin', 'PIN']]) {
    const c = S.controls.get(key);
    if (!c?.enable) continue;
    const following = S.swarmUi && S.values[flag] === '1';
    c.enable(!following, following ? `This unit uses the swarm's ${what}. Turn off Follow swarm ${what} to give it its own.` : '');
  }
}

async function switchSwarm(md) {
  try {
    const r = await send(`wm${md.id}`);
    if (r.ok) toast(`Switching the swarm to ${md.label}… every unit follows within a second or two.`);
  } catch (e) {
    toast(String(e.message || e), true);
  }
}

const S = {
  schema: null,
  styles: null,          // local styles (shared/styles.json), for names and previews
  routines: null,        // shared/routines.json (Play demo); null if it did not load
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
  swarmUi: false,          // swarm firmware: the Whole swarm / This unit views
  view: 'unit',
  swarmVals: { night: '', blePin: '' },   // the swarm's settings (STATUS sb, sp)
  swarmControls: new Map(),
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

/**
 * Coalescing setter: one set per key in flight; the latest value wins. swarm: "wset", the value
 * for every unit (this unit takes it too while it follows the swarm).
 */
async function setSetting(key, text, { swarm = false } = {}) {
  const slot = swarm ? `w:${key}` : key;
  const values = swarm ? S.swarmVals : S.values;
  const controls = swarm ? S.swarmControls : S.controls;
  if (S.inflight.get(slot)) { S.pendingSet.set(slot, text); return; }
  S.inflight.set(slot, true);
  try {
    const r = await send(`${swarm ? 'wset' : 'set'} ${key}=${text}`);
    if (r.ok && r.key === key) {
      values[key] = r.value;
      if (r.apply === 'reboot') showRebootBar(true);
      if (r.apply === 'restart') toast('Saved. The show restarts with the change.');
      if (swarm && S.values[key === 'night' ? 'nightSw' : 'pinSw'] === '1') {   // this unit follows: it took it too
        S.values[key] = r.value;
        S.controls.get(key)?.show(r.value);
      }
      if (key === 'nightSw' || key === 'pinSw') {
        const k = key === 'nightSw' ? 'night' : 'blePin';
        if (r.value === '1' && S.swarmVals[k] && k === 'night') {   // following again: the swarm's value
          S.values.night = S.swarmVals.night;
          S.controls.get('night')?.show(S.values.night);
        }
        updateFollow();
      }
    }
    if (!S.pendingSet.has(slot)) controls.get(key)?.show(values[key], !r.ok);
  } catch (e) {
    toast(String(e.message || e), true);
  } finally {
    S.inflight.delete(slot);
    if (S.pendingSet.has(slot)) {
      const next = S.pendingSet.get(slot);
      S.pendingSet.delete(slot);
      if (next !== values[key]) setSetting(key, next, { swarm });
      else controls.get(key)?.show(values[key]);
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

function rangeControl(def, { set = setSetting, current = () => S.values[def.key], idPrefix = 'f' } = {}) {
  const id = `${idPrefix}-${def.key}`;
  const range = el('input', { type: 'range', min: def.min, max: def.max, step: def.step ?? 1, 'aria-label': def.label });
  const num = el('input', { type: 'number', class: 'num', id, min: def.min, max: def.max, step: def.step ?? 1, inputmode: 'decimal' });
  const field = fieldShell(def, el('div', { class: 'range-row' }, range, num));
  let last = 0;
  let timer = 0;
  const text = (v) => (def.type === 'float' ? Number(v).toFixed(def.decimals) : String(Math.round(Number(v))));
  const sendNow = (v) => { clearTimeout(timer); last = performance.now(); set(def.key, text(v)); };
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
    if (!p.ok) { toast(ERR_TEXT[p.err], true); show(current()); return; }
    range.value = num.value;
    sendNow(num.value);
  });
  function show(v, bad) {
    range.value = v;
    num.value = v;
    field.classList.toggle('err', !!bad);
  }
  const note = el('p', { class: 'help lock-note', hidden: true });
  field.append(note);
  function enable(on, why = '') {
    range.disabled = !on;
    num.disabled = !on;
    field.classList.toggle('locked', !on);
    note.textContent = why;
    note.hidden = !why;
  }
  return { field, show, enable };
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

function pinCodeControl(def, { set = setSetting, idPrefix = 'f', states = { set: 'PIN set', 0: 'no PIN' } } = {}) {
  const id = `${idPrefix}-${def.key}`;
  const state = el('span', { class: 'badge' });
  const input = el('input', { type: 'text', id, inputmode: 'numeric', pattern: '[0-9]*', maxlength: 6, autocomplete: 'off', placeholder: 'new PIN (0 = none)' });
  const btn = el('button', { class: 'secondary small', type: 'button', text: 'Set' });
  const field = el('div', { class: 'field' },
    el('label', { for: id }, def.label, state),
    el('div', { class: 'row' }, input, btn),
    el('p', { class: 'help', text: def.help }));
  btn.addEventListener('click', async () => {
    const v = input.value.trim() || '0';
    await set(def.key, v);
    input.value = '';
  });
  const note = el('p', { class: 'help lock-note', hidden: true });
  field.append(note);
  return {
    field,
    show: (v) => { state.textContent = states[v === 'set' ? 'set' : v === '0' || v === 0 ? 0 : ''] ?? states[0]; },
    enable: (on, why = '') => {
      input.disabled = !on;
      btn.disabled = !on;
      field.classList.toggle('locked', !on);
      note.textContent = why;
      note.hidden = !why;
    },
  };
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
  updateFollow();
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
  const sw = parseSwarm(st.sw);   // swarm firmware (docs/SWARM.md): C = leading, F = following, J = searching
  if (sw) {
    tiles.push(['Swarm', sw.role === 'J' ? 'searching' : (sw.units + ' units' + (sw.mode ? ' · ' + sw.mode.label : ''))]);
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
    updateSwarm(st);
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
    if (r.ok && cmd === 'r') toast('Routine stopped: the normal show takes over');
    if (r.ok && /^r[a-z]/.test(cmd)) toast(`Playing ${$('routinePick').selectedOptions[0]?.textContent || cmd.slice(1)}`);
    if (r.ok && cmd === 'a') toast('If the eyes are closed, they open within a second');
    if (r.ok && cmd === 'identify') toast('This unit blinks 3 times (as soon as its eyes are open)');
    const every = { wa: 'Closed eyes open on every unit', wn: 'Every unit moves to the next style',
      wb: 'Every unit blinks', wp: 'Every unit startles' }[cmd];
    if (r.ok && every) toast(`${every}, in about half a second`);
    if (r.ok && cmd.startsWith('ws')) toast(cmd === 'ws' ? 'Every unit goes back to the shuffle' : `Every unit shows ${styleName(cmd.slice(2))}`);
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
  S.swarmUi = S.caps.has('swarm');
  S.swarmVals = { night: '', blePin: '' };
  $('viewSwitch').hidden = !S.swarmUi;
  $('unitScope').hidden = !S.swarmUi;
  $('unitScopeName').textContent = $('devName').textContent;
  $('identifyBtn').hidden = !S.swarmUi;
  $('pinNowHelp').textContent = S.swarmUi
    ? 'Pins a style on this unit until the next power cycle. To keep it after a reboot, use Pinned at boot under Styles.'
    : 'Pins a style until the next power cycle. To keep it after a reboot, use Pinned at boot under Styles.';
  buildGroups();
  buildStyles();
  if (S.swarmUi) {
    buildSwarmView();
    let v = 'swarm';
    try { v = localStorage.getItem('he.view') || 'swarm'; } catch { /* the default view */ }
    setView(v === 'unit' ? 'unit' : 'swarm');
  } else {
    $('viewSwarm').hidden = true;
    $('viewUnit').hidden = false;
  }
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
  const link = kind === 'ble' ? new BleLink() : new MockLink({ schema: S.schema, styles: S.styles, routines: S.routines, profile, name: 'HE-DEMO' });
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
  for (const b of document.querySelectorAll('[data-wcmd]')) b.addEventListener('click', () => runCmd(b.dataset.wcmd));
  $('swarmPinSel').addEventListener('change', (e) => runCmd(e.target.value ? `ws${e.target.value}` : 'ws'));
  $('tabSwarm').addEventListener('click', () => setView('swarm'));
  $('tabUnit').addEventListener('click', () => setView('unit'));
  $('viewSwitch').addEventListener('keydown', (e) => {   // tabs: arrow keys move between them
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setView(S.view === 'swarm' ? 'unit' : 'swarm');
    $(S.view === 'swarm' ? 'tabSwarm' : 'tabUnit').focus();
  });
  $('pinNow').addEventListener('change', (e) => runCmd(e.target.value ? `s${e.target.value}` : 's'));
  $('routinePlayBtn').addEventListener('click', () => { if ($('routinePick').value) runCmd(`r${$('routinePick').value}`); });
  $('routineStopBtn').addEventListener('click', () => runCmd('r'));
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

/** shared/routines.json for Play demo (docs/ROUTINES.md §R8); the page works without it. */
async function loadRoutines() {
  try {
    const r = await fetch('../shared/routines.json');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const doc = await r.json();
    return Array.isArray(doc.routines) && doc.routines.length ? doc : null;
  } catch (e) {
    log(`routines.json: ${e.message || e}`, true);
    return null;
  }
}

function buildRoutines() {
  $('routineField').hidden = !S.routines;
  if (!S.routines) return;
  $('routinePick').replaceChildren(...S.routines.routines.map((r) => {
    const prog = compileRoutine(S.routines, r.id, S.styles);
    const len = prog.errors.length ? '' : ` (${Math.round(prog.lengthMs / 1000)} s)`;
    return el('option', { value: r.id, text: `${prog.name}${len}` });
  }));
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
  S.routines = await loadRoutines();
  buildRoutines();
  showScreen('welcome');
  if (new URLSearchParams(location.search).has('demo')) {
    const p = new URLSearchParams(location.search).get('demo');
    if (p && $('demoProfile').querySelector(`option[value="${p}"]`)) $('demoProfile').value = p;
    connect('demo');
  }
}

main();
