// Style previews for the config page (docs/BLE.md §B7): the simulator's Director and renderer,
// drawn small. A thumbnail is one settled Watch frame; the live preview animates one style.
// Browser-only (canvas), but the frame logic (settledFrame) is DOM-free.

import { Director } from '../director.js?v=372e0e069c';
import { prepareEye, renderRect, createEyeUniforms } from '../renderer.js?v=372e0e069c';
import { rgb565To888 } from '../color.js?v=372e0e069c';
import { PANELS } from '../constants.js?v=372e0e069c';

const TICK_MS = 1000 / 24;
const WATCH = 2;

/** RenderConfig for a preview of n px per eye on the device's panel type. */
export function previewConfig(panelId, n, spacingMm = 76) {
  const P = panelId === 'ssd1351' ? PANELS.oled : PANELS.lcd;
  return { spacingMm, panelPx: n, rDispMm: P.rDispMm, outGamma: P.outGamma };
}

function rDispOf(panelId) { return (panelId === 'ssd1351' ? PANELS.oled : PANELS.lcd).rDispMm; }

/** Steps a Director pinned to styleIdx until its eyes are open in Watch; returns that FrameState. */
export function settledFrame(styles, styleIdx, spacingMm = 76, seed = 7, panelId = 'gc9a01') {
  const d = new Director(styles, seed, 0, spacingMm, rDispOf(panelId));
  let fs = null;
  let t = 0;
  let watchTicks = 0;
  for (let k = 0; k < 24 * 20; k++) {
    t += TICK_MS;
    fs = d.update(t, { forceStyle: styleIdx });
    if (fs.phase === WATCH && fs.style === styleIdx) {
      if (++watchTicks > 30) break;   // 1.25 s into Watch: open, settled
    }
  }
  return fs;
}

// 565 -> 888 lookup tables, scaled by a brightness factor.
function luts(gain) {
  const r = new Uint8Array(32), g = new Uint8Array(64), b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const [R, , B] = rgb565To888((i << 11) | i);
    r[i] = Math.min(255, Math.round(R * gain));
    b[i] = Math.min(255, Math.round(B * gain));
  }
  for (let i = 0; i < 64; i++) g[i] = Math.min(255, Math.round(rgb565To888(i << 5)[1] * gain));
  return { r, g, b };
}

/** Draws both eyes of a FrameState into ctx (two discs of n px, gap px apart). */
export class PairPainter {
  constructor(ctx, n, gap) {
    this.ctx = ctx;
    this.n = n;
    this.gap = gap;
    this.u = [createEyeUniforms(), createEyeUniforms()];
    this.buf = new Uint16Array(n * n);
    this.img = ctx.createImageData(n, n);
    this.px = new Uint32Array(this.img.data.buffer);
    this.disc = new Uint8Array(n * n);
    const c = (n - 1) / 2;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) this.disc[y * n + x] = (x - c) ** 2 + (y - c) ** 2 <= (n / 2) ** 2 ? 1 : 0;
    }
  }

  paint(style, fs, rc, gain = 1) {
    const { n, buf, px, disc } = this;
    const L = luts(Math.max(0, Math.min(1, fs.backlight)) * gain);
    for (let side = 0; side < 2; side++) {
      prepareEye(style, fs.eye[side], side, rc, this.u[side]);
      renderRect(this.u[side], 0, 0, n, n, buf);
      for (let i = 0; i < n * n; i++) {
        if (!disc[i]) { px[i] = 0; continue; }
        const c = buf[i];
        px[i] = 0xff000000 | (L.b[c & 31] << 16) | (L.g[(c >>> 5) & 63] << 8) | L.r[c >>> 11];
      }
      this.ctx.putImageData(this.img, side * (n + this.gap), 0);
    }
  }
}

/** Static thumbnail of one style into a canvas sized 2n + gap by n. */
export function drawThumbnail(canvas, styles, idx, panelId, n = 56) {
  const gap = Math.round(n * 0.35);
  canvas.width = 2 * n + gap;
  canvas.height = n;
  const ctx = canvas.getContext('2d');
  const fs = settledFrame(styles, idx, 76, 7, panelId);
  new PairPainter(ctx, n, gap).paint(styles[fs.style], fs, previewConfig(panelId, n));
}

/** Animated preview of one pinned style (24 fps while running). */
export class LivePreview {
  constructor(canvas, styles, panelId, n = 112) {
    this.canvas = canvas;
    this.styles = styles;
    this.panelId = panelId;
    this.n = n;
    this.gap = Math.round(n * 0.35);
    canvas.width = 2 * n + this.gap;
    canvas.height = n;
    this.painter = new PairPainter(canvas.getContext('2d'), n, this.gap);
    this.styleIdx = 0;
    this.spacing = 76;
    this.gain = 1;
    this.timer = 0;
    this.restart();
  }

  restart() {
    this.director = new Director(this.styles, 11, 0, this.spacing, rDispOf(this.panelId));
    this.t = 0;
  }

  setStyle(i) {
    if (i === this.styleIdx) return;
    this.styleIdx = i;
    this.restart();
  }

  // A 24 fps timer (not requestAnimationFrame, which some embedded browsers never fire); the page
  // stops it while hidden. Animation is time-based, so a late tick never slows the eyes.
  start() {
    if (this.timer) return;
    this.last = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      this.t += Math.min(250, now - this.last);
      this.last = now;
      const fs = this.director.update(this.t, { forceStyle: this.styleIdx });
      this.painter.paint(this.styles[fs.style], fs, previewConfig(this.panelId, this.n, this.spacing), this.gain);
    }, TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
  }
}
