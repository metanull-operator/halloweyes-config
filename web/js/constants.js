// Shared constants and enums (DESIGN.md §3.3, §4.9, §7.1).
// DOM-free ES module: importable from the browser and from Node tools.
// Enum integer values MUST match the C++ enums of §5.3 / §6.1 (declaration order).

// Default panel (LCD builds: GC9A01). Every module that renders takes the panel from
// RenderConfig {spacingMm, panelPx, rDispMm, outGamma} (docs/OLED.md §O4); these are its defaults
// (outGamma defaults to 1: no output transfer).
export const PANEL_PX = 240;      // panel width/height in pixels
export const R_DISP_MM = 16.2;    // display radius in mm (1.0 display unit)
export const PX_MM = 0.135;       // pixel pitch in mm (R_DISP_MM / 120)

// Panel profiles (docs/OLED.md §O4, §O5). The single place the OLED geometry is defined:
// px = panel width/height, rDispMm = display radius in mm (1.0 display unit = px/2 pixels),
// pxMm = pixel pitch (rDispMm / (px/2)), bandH = HE_BAND_H, spiHz = HE_SPI_MHZ default,
// round = the panel itself is round (else square, seen through a round aperture),
// outGamma = RenderConfig.outGamma, the output transfer (code = c^outGamma, color.js quantize565).
// OLED rDispMm: half the SSD1351 active-area width, 26.855 mm / 2 (docs/OLED.md §O9).
// OLED outGamma: the colors (and GLOW_TABLE) are encoded for a gamma-2.2 panel, the GC9A01, but
// the SSD1351 runs its reset linear gray-scale LUT (gamma ~1, §O9). Sending c^2.2 gives the OLED
// the LCD's luminance curve. The LCD's 1 means no transfer at all (bit-identical LCD output).
export const PANELS = Object.freeze({
  lcd: Object.freeze({
    id: 'lcd', name: 'LCD (GC9A01, 240 px, round)', px: PANEL_PX, rDispMm: R_DISP_MM, pxMm: PX_MM,
    bandH: 20, spiHz: 40e6, round: true, outGamma: 1,
  }),
  oled: Object.freeze({
    id: 'oled', name: 'OLED (SSD1351, 128 px)', px: 128, rDispMm: 13.43, pxMm: 13.43 / 64,
    bandH: 16, spiHz: 20e6, round: false, outGamma: 2.2,
  }),
});

/** RenderConfig for a panel profile (PANELS key or object) at the given eye spacing. */
export function panelRenderConfig(panel, spacingMm = 76) {
  const P = typeof panel === 'string' ? PANELS[panel] : panel;
  if (!P) throw new Error(`unknown panel ${JSON.stringify(panel)} (expected ${Object.keys(PANELS).join(' or ')})`);
  return { spacingMm, panelPx: P.px, rDispMm: P.rDispMm, outGamma: P.outGamma };
}

export const OutlineType = Object.freeze({ Circle: 0, Ellipse: 1, Vesica: 2, Triangle: 3, Moon: 4, RoundBox: 5, Cluster: 6 });
export const FillMode = Object.freeze({ Iris: 0, Spiral: 1, Hotspot: 2, Beads: 3, Rim: 4, Scanner: 5 });
export const PupilType = Object.freeze({ None: 0, Round: 1, Slit: 2, Bar: 3 });
export const BlinkKind = Object.freeze({ None: 0, Lid: 1, Fade: 2, Membrane: 3, Squash: 4, Crt: 5, Ripple: 6 });
export const GazeKind = Object.freeze({ Pupil: 0, Whole: 1, None: 2 });
export const StartleMode = Object.freeze({ None: 0, Dilate: 1, Constrict: 2 });
export const Phase = Object.freeze({ Dark: 0, Appear: 1, Watch: 2, Transition: 3, Vanish: 4, Startle: 5 });

// EventType index order is fixed (§4.9). Names are the C++ enumerators minus the EV_ prefix.
export const EventType = Object.freeze({
  Squint: 0, Dilate: 1, LookAround: 2, Flurry: 3, Wink: 4, SlowBlink: 5, Sweep: 6,
  Tilt: 7, Swivel: 8, Trance: 9, Giggle: 10, Approach: 11, Gutter: 12,
});
export const EV_COUNT = 13;

// JSON spellings (shared/styles.json), indexed by enum value.
export const OUTLINE_TYPE_NAMES = Object.freeze(['circle', 'ellipse', 'vesica', 'triangle', 'moon', 'roundbox', 'cluster']);
export const FILL_MODE_NAMES = Object.freeze(['iris', 'spiral', 'hotspot', 'beads', 'rim', 'scanner']);
export const PUPIL_TYPE_NAMES = Object.freeze(['none', 'round', 'slit', 'bar']);
export const BLINK_KIND_NAMES = Object.freeze(['none', 'lid', 'fade', 'membrane', 'squash', 'crt', 'ripple']);
export const GAZE_KIND_NAMES = Object.freeze(['pupil', 'whole', 'none']);
export const STARTLE_MODE_NAMES = Object.freeze(['none', 'dilate', 'constrict']);
export const EVENT_NAMES = Object.freeze([
  'squint', 'dilate', 'lookAround', 'flurry', 'wink', 'slowBlink', 'sweep',
  'tilt', 'swivel', 'trance', 'giggle', 'approach', 'gutter',
]);
export const PHASE_NAMES = Object.freeze(['Dark', 'Appear', 'Watch', 'Transition', 'Vanish', 'Startle']);
