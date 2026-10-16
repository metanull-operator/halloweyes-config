// Behavior director (DESIGN.md §6). Reference implementation: firmware/src/director.cpp
// is a line-for-line port of this file, so it is written port-friendly:
//   - every piece of state is an explicit field initialized in begin();
//   - every random draw is its own statement, in exactly the §6 order (§6.2 draw-order rule);
//   - no closures over state, no Date / Math.random; time is the caller's nowMs.
// DOM-free ES module (Node tools import it).
//
// Interpretations of points §6 leaves open (all deterministic; see the notes at each site):
//   - forceStyle is a LEVEL input (hold it every frame while pinned; -1 = Auto).
//   - nextStyle is a PULSE, latched until the next Watch (-> Transition) or Dark (-> shorten Dark);
//     a Transition that has not swapped yet absorbs it.
//   - Random fixation saccades are generated in Watch only; queued saccades, saccade motion
//     and microsaccades run in every non-Dark phase.
//   - Events start and update in Watch only (frozen elsewhere until cancelled). The Watch timer
//     does not end Watch while an event is active (no swivel/approach pop), and no new event
//     starts once the timer has run out.
//   - Vanish lasts 200 ms longer than its visual close (VANISH_TAIL_MS) so the backlight ramp of
//     §6.3 ("close + 200 ms") completes and the final Vanish frame has intensity 0.
//   - Sweep starts with a draw-free saccade to its start point instead of a jump.
//   - Bag: a sole remaining item equal to lastPlayed is discarded (else a jump-scare could repeat
//     hellfire); a bag pick replaced by a jump-scare or a pin in Dark is returned to the front.
//   - Jump-scare from Dark also requires lastPlayed != hellfire (no consecutive repeat).

import { Phase, BlinkKind, GazeKind, StartleMode, EventType, EV_COUNT, R_DISP_MM } from './constants.js';
import { clamp, lerp, smoothstep, len } from './mathutil.js';
import { vnoiseP } from './noise.js';
import { Rng } from './rng.js';

export const HE_VIEW_Y = 0.35;              // normalized gaze Y meaning "looking at the viewer"
export const MASK_L = 1;
export const MASK_R = 2;
export const MASK_BOTH = 3;
export const BLINK_SLOTS = 8;               // concurrent blink records (bursts, gaze blinks, events)
export const SACQ_CAP = 6;                  // queued saccades (LookAround: 4 + VIEW)
export const STARTLE_REFRACTORY_MS = 20000;
export const VANISH_TAIL_MS = 200;
export const TRANS_CLOSE_MS = 300;
export const TRANS_OPEN_MS = 500;
export const DARK_FIRST_MS = 1500;
export const DARK_SHORT_MS = 500;           // nextStyle / pin change in Dark
export const PIR_RECENT_MS = 120000;
const DBL_TC = 90, DBL_TH = 40, DBL_TO = 160;  // Vanish DOUBLE blinks (no jitter)
const TWO_PI = 2 * Math.PI;

/** Appear/vanish kind (§6.3), derived from the style. */
export const AppearKind = Object.freeze({ Lid: 0, Fade: 1, Squash: 2, Crt: 3 });

export function appearKindOf(style) {
  if (style.lids.enabled) return AppearKind.Lid;
  if (style.blink.kind === BlinkKind.Crt) return AppearKind.Crt;
  if (style.blink.kind === BlinkKind.Squash) return AppearKind.Squash;
  return AppearKind.Fade;
}

/** Fraction open; fast start, slow finish (§6.4). */
export function openCurve(u) {
  const v = 1 - u;
  return 1 - v * v * v;
}

/** Blink envelope (§6.4); tau = ms since blink start. */
export function blinkEnv(tau, tc, th, to, depth) {
  if (tau < 0) return 0;
  if (tau < tc) { const x = tau / tc; return depth * x * x; }
  if (tau < tc + th) return depth;
  if (tau < tc + th + to) return depth * (1 - openCurve((tau - tc - th) / to));
  return 0;
}

/** Trapezoid envelope (§6.5); never evaluates smoothstep(0, 0, ·). */
export function trap(tau, a, h, r) {
  if (tau < 0) return 0;
  if (tau < a) return smoothstep(0, a, tau);          // tau >= 0 and tau < a imply a > 0
  if (tau < a + h) return 1;
  if (r > 0 && tau < a + h + r) return 1 - smoothstep(0, r, tau - a - h);
  return 0;
}

/** fract that never returns 1.0 (x - floor(x) rounds up for tiny negative x). */
function wrap01(x) {
  const f = x - Math.floor(x);
  return f >= 1 ? 0 : f;
}

export function makeEyeState() {
  return {
    gazeX: 0, gazeY: 0, vergence: 0, openness: 0, blink: 0, pupil: 0, intensity: 0, glowGain: 1,
    scale: 1, headTilt: 0, headDx: 0, headDy: 0, medialAdj: 0, texPhase: 0, spinPhase: 0,
    scanXmm: 0, scanDir: 1,
  };
}

export function makeFrameState() {
  return {
    tMs: 0, style: 0, phase: Phase.Dark, panelsOn: true, fullClear: false, backlight: 0,
    eye: [makeEyeState(), makeEyeState()],
  };
}

function makeBlinkSlot() {
  return { active: false, start: 0, tc: 0, th: 0, to: 0, depth: 0, mask: 0, serial: 0 };
}

function makeSacEntry() {
  return { x: 0, y: 0, hold: 0 };
}

// Swarm cues (docs/SWARM.md §S8; C++ kCue*): inputs.cue, with cueStyle and cueSeed for Appear.
export const CUE_NONE = 0;
export const CUE_APPEAR = 1;   // restart from cueSeed and appear with cueStyle, in any phase
export const CUE_VANISH = 2;   // vanish now (Appear, Watch, Transition; ignored otherwise)

export class Director {
  /**
   * @param {object[]} styles normalized styles (styles.js)
   * @param {number} seed uint32 RNG seed
   * @param {number} nowMs simulated time (ms)
   * @param {number} spacingMm eye center distance (scanner bounds)
   * @param {number} rDispMm display radius in mm (scanner bounds; RenderConfig.rDispMm)
   */
  constructor(styles, seed, nowMs, spacingMm = 76, rDispMm = R_DISP_MM) {
    this.begin(styles, seed, nowMs, spacingMm, rDispMm);
  }

  // ---------------------------------------------------------------------------
  // Public API (C++: begin / update / phase() / currentStyle() / msUntilWake)

  begin(styles, seed, nowMs, spacingMm, rDispMm = R_DISP_MM) {
    this.styles = styles;
    this.count = styles.length;
    this.rng = new Rng(seed >>> 0);
    this.spacingMm = spacingMm;
    this.rDispMm = rDispMm;
    this.viewY = HE_VIEW_Y;                 // sim: "viewY" setting
    this.hellfire = -1;
    for (let i = 0; i < this.count; i++) {
      if (styles[i].id === 'hellfire') { this.hellfire = i; break; }
    }

    // Time and phase
    this.lastNow = nowMs;
    this.ph = Phase.Dark;
    this.phaseStart = nowMs;
    this.firstDark = true;                  // the first Dark after begin lasts DARK_FIRST_MS (no draw)
    this.darkEnd = nowMs;
    this.darkFirstFrame = true;
    this.frameFullClear = false;
    this.transitionsInRow = 0;

    // Styles and bag (§6.8)
    this.style = 0;
    this.nextStyle = 0;
    this.nextFromBag = false;               // nextStyle came from bagNext() (may be returned)
    this.lastPlayed = -1;
    this.forced = -1;
    this.bag = new Int16Array(Math.max(1, this.count));
    this.bagLen = 0;
    this.bagGen = -1;
    this.pickSerial = 0;                    // instrumentation: number of bag picks
    this.lastPick = -1;
    this.lastPickGen = -1;

    // Appear
    this.appearStartAt = nowMs;
    this.ramp = 0;
    this.openStart = 0;
    this.openDur = 1;

    // Watch
    this.watchEnd = nowMs;
    this.postStartleWatch = false;          // viewerBias 0.8 for this Watch

    // Transition
    this.transHold = 0;
    this.transSwapped = false;
    this.pendingNext = false;               // nextStyle pulse latched until the next Watch / Dark (§6.3)

    // Vanish
    this.vanRetreat = false;
    this.vanDouble = false;
    this.vanCloseStart = 0;                 // ms after Vanish start
    this.vanCloseDur = 1;
    this.vanEnd = 0;                        // ms after Vanish start

    // Startle and PIR
    this.hasStartled = false;
    this.lastStartleAt = 0;
    this.startleHold = 0;
    this.startleBl0 = 0;
    this.startleOpen0 = 0;
    this.startleExited = false;
    this.startleExitAt = 0;
    this.squintHold = false;
    this.squintHoldStart = 0;
    this.hasPir = false;
    this.lastPirAt = 0;

    // Appear/vanish curve outputs (evaluated per frame by evalAppear)
    this.appearOpen = 0;
    this.appearInten = 0;
    this.appearBlink = 0;
    this.retreatScale = 1;
    this.retreatMedial = 0;
    this.backlight = 0;

    // Blink generator (§6.4)
    this.blinks = [];
    for (let i = 0; i < BLINK_SLOTS; i++) this.blinks.push(makeBlinkSlot());
    this.blinkSerial = 0;
    this.nextBlinkAt = nowMs;
    this.burstPending = false;
    this.burstEnd = 0;
    this.blinkL = 0;
    this.blinkR = 0;

    // Gaze (§6.5)
    this.curX = 0; this.curY = 0;
    this.fromX = 0; this.fromY = 0;
    this.toX = 0; this.toY = 0;
    this.sacStart = 0;
    this.sacDur = 60;
    this.saccading = false;
    this.fixUntil = nowMs;
    this.microX = 0; this.microY = 0;
    this.nextMicroAt = nowMs;
    this.gazeRX = 0; this.gazeRY = 0;
    this.sacQ = [];
    for (let i = 0; i < SACQ_CAP; i++) this.sacQ.push(makeSacEntry());
    this.sacQHead = 0;
    this.sacQLen = 0;
    this.sacQNextAt = nowMs;

    // Events (§6.7)
    this.evType = -1;
    this.evStart = 0;
    this.evDur = 0;
    this.evH = 0;
    this.evDir = 1;
    this.nextEventAt = nowMs;
    this.sweepLeadEnd = 0;
    this.sweepEnd = 0;
    this.squintEv = 0;
    this.dilateEnv = 0;
    this.tiltEnv = 0;
    this.tiltSign = 1;
    this.swivel = 0;
    this.swivelHide = 1;
    this.tranceMul = 1;
    this.giggle = 0;
    this.approachScale = 1;
    this.approachMedial = 0;
    this.gutter = 1;

    // Dropouts (§6.5)
    this.nextDropAt = nowMs;
    this.dropUntil = 0;
    this.drop2Pending = false;
    this.drop2At = 0;

    // Pupil and phase accumulators
    this.pupilP = 0.5;
    this.texPhase = 0;
    this.spinPhase = 0;
    this.scanXmm = 0;
    this.scanDir = 1;

    this.fs = makeFrameState();

    // The first Dark: style choice from the bag, 1.5 s, no duration draw.
    this.enterDark(nowMs);
    this.style = this.nextStyle;            // a valid index before the first Appear (lastPlayed unchanged)
    this.resetStyleState();
  }

  /**
   * Swarm Appear cue (C++ hiveAppear): a full restart from the shared seed at nowMs, then the
   * RNG again from that seed, so every unit that gets the cue on the same tick runs the same show.
   */
  hiveAppear(nowMs, style, seed) {
    this.begin(this.styles, seed >>> 0, nowMs, this.spacingMm, this.rDispMm);
    this.rng.seed(seed >>> 0);
    this.nextStyle = (Number.isInteger(style) && style >= 0 && style < this.count) ? style : 0;
    this.nextFromBag = false;
    this.enterAppear(this.lastNow);
  }

  get phase() { return this.ph; }
  get currentStyle() { return this.style; }

  /** In Dark: ms until Appear; otherwise 0. */
  msUntilWake(nowMs) {
    if (this.ph !== Phase.Dark) return 0;
    const w = this.darkEnd - nowMs;
    return w > 0 ? w : 0;
  }

  /**
   * Advance to nowMs and return the FrameState. The returned object is owned by the
   * Director and reused every call (copy it to keep it).
   * @param {number} nowMs
   * @param {{pir?:boolean,nextStyle?:boolean,forceBlink?:boolean,forceStartle?:boolean,forceStyle?:number}} inputs
   */
  update(nowMs, inputs) {
    // Swarm (docs/SWARM.md §S8): slaved is a level; an Appear cue restarts the director from the
    // swarm's seed at this exact tick, so every unit of a Chorus-Hive swarm runs the same show.
    this.slaved = !!(inputs && inputs.slaved);
    if (inputs && inputs.cue === CUE_APPEAR && this.count > 0) this.hiveAppear(nowMs, inputs.cueStyle, inputs.cueSeed);
    const now = nowMs;
    let dt = now - this.lastNow;
    if (dt < 0) dt = 0;
    if (dt > 100) dt = 100;
    this.lastNow = now;
    const dts = dt / 1000;
    this.frameFullClear = false;

    const inPir = !!(inputs && inputs.pir);
    const inNext = !!(inputs && inputs.nextStyle);
    const inBlink = !!(inputs && inputs.forceBlink);
    const inStartle = !!(inputs && inputs.forceStartle);
    let forced = -1;
    if (inputs && Number.isInteger(inputs.forceStyle)) forced = inputs.forceStyle;
    if (forced >= this.count) forced = -1;
    this.forced = forced;

    if (inPir) {
      this.hasPir = true;
      this.lastPirAt = now;
    }
    // The nextStyle pulse is latched (also through a same-frame startle) and applied at the first
    // Watch or Dark update: a press in Appear, Vanish, Startle or after a Transition's swap is deferred,
    // a press during a Transition before its swap is absorbed by that swap (§6.3).
    if (inNext) this.pendingNext = true;

    if (inputs && inputs.cue === CUE_VANISH &&
        (this.ph === Phase.Appear || this.ph === Phase.Watch || this.ph === Phase.Transition)) {
      this.enterVanish(now, false);
    }

    // 1. Inputs
    if ((inPir || inStartle) && this.startleAllowed(now)) {
      this.enterStartle(now);
    } else {
      if (this.pendingNext) {
        if (this.ph === Phase.Watch) {
          this.pendingNext = false;
          this.enterTransition(now);                                  // does not count toward the limit
        } else if (this.ph === Phase.Dark) {
          this.pendingNext = false;
          this.shortenDark(now);
        } else if (this.ph === Phase.Transition && !this.transSwapped) {
          this.pendingNext = false;                                   // the pending swap already delivers a new style
        }
      }
      if (this.forced >= 0) {
        if (this.ph === Phase.Watch && this.style !== this.forced) {
          this.enterTransition(now);
        } else if (this.ph === Phase.Dark && this.nextStyle !== this.forced) {
          this.returnNextToBag();
          this.nextStyle = this.forced;
          this.shortenDark(now);
        }
      }
      if (inBlink && this.ph === Phase.Watch) this.forceBlink(now);
    }

    // 2. Phase timers (at most one change per step; loop covers chained zero-length cases)
    for (let guard = 0; guard < 8; guard++) {
      if (!this.stepPhase(now)) break;
    }

    // 3. Watch-only generators: events, spontaneous blinks, dropouts
    if (this.ph === Phase.Watch) this.updateWatchGenerators(now);

    // 4.-7. Per-frame state
    this.evalBlinks(now);
    if (this.ph !== Phase.Dark) this.updateGaze(now, dt);
    this.updatePupil(now, dts);
    this.updateAccumulators(dts);
    this.evalAppear(now);

    // 8. Output
    this.compose(now);
    return this.fs;
  }

  // ---------------------------------------------------------------------------
  // Phase machine (§6.3)

  startleAllowed(now) {
    if (!this.hasStartled) return true;
    return now - this.lastStartleAt >= STARTLE_REFRACTORY_MS;
  }

  shortenDark(now) {
    const t = now + DARK_SHORT_MS;
    if (this.darkEnd > t) this.darkEnd = t;
  }

  /** Checks the current phase's exit; returns true if the phase changed. */
  stepPhase(now) {
    const tau = now - this.phaseStart;
    switch (this.ph) {
      case Phase.Dark:
        if (now >= this.darkEnd && !this.slaved) { this.enterAppear(now); return true; }
        return false;
      case Phase.Appear:
        if (tau >= this.openStart + this.openDur) { this.enterWatch(now); return true; }
        return false;
      case Phase.Watch:
        if (now >= this.watchEnd && this.evType < 0 && !this.slaved) {
          if (this.transitionsInRow < 2) {
            const toTrans = this.rng.chance(0.3);
            if (toTrans) {
              this.transitionsInRow++;
              this.enterTransition(now);
              return true;
            }
          }
          this.enterVanish(now, false);
          return true;
        }
        return false;
      case Phase.Transition:
        if (!this.transSwapped && tau >= TRANS_CLOSE_MS) this.transitionSwap(now);
        if (tau >= TRANS_CLOSE_MS + this.transHold + TRANS_OPEN_MS) { this.enterWatch(now); return true; }
        return false;
      case Phase.Vanish:
        if (tau >= this.vanEnd) { this.enterDark(now); return true; }
        return false;
      case Phase.Startle:
        if (tau >= this.startleHold) { this.exitStartle(now); return true; }
        return false;
      default:
        return false;
    }
  }

  enterDark(now) {
    this.ph = Phase.Dark;
    this.phaseStart = now;
    this.darkFirstFrame = true;
    this.postStartleWatch = false;
    this.transitionsInRow = 0;
    // Quiet reset (no draws): nothing carries over into the next show.
    this.clearBlinks();
    this.cancelEvent();
    this.cancelDropouts();
    this.saccading = false;
    this.squintHold = false;
    this.startleExited = false;
    this.nextFromBag = false;
    if (this.forced >= 0) {
      this.nextStyle = this.forced;
    } else {
      this.nextStyle = this.bagNext();
      this.nextFromBag = true;
    }
    if (this.firstDark) {
      this.firstDark = false;
      this.darkEnd = now + DARK_FIRST_MS;
    } else {
      let dur = 1000 * this.rng.logUniform(5, 60);
      if (this.hasPir && now - this.lastPirAt < PIR_RECENT_MS) dur *= 0.3;
      this.darkEnd = now + dur;
    }
  }

  enterAppear(now) {
    this.ph = Phase.Appear;
    this.phaseStart = now;
    this.appearStartAt = now;
    this.frameFullClear = true;
    this.setStyle(this.nextStyle);
    this.nextFromBag = false;
    this.resetStyleState();
    const S = this.styles[this.style];
    this.ramp = this.rng.uniform(300, 900);                          // (1)
    this.openStart = 0.6 * this.ramp;
    const fast = this.rng.chance(0.15);                               // (2)
    this.openDur = 150;
    if (!fast) this.openDur = this.rng.uniform(500, 1500);            // (3)
    const pos = this.rng.chance(0.5);                                 // (4)
    const sgn = pos ? 1 : -1;
    const mag = this.rng.uniform(0.3, 0.6);                           // (5)
    this.curX = sgn * mag;
    this.curY = -0.6;
    this.fromX = this.curX; this.fromY = this.curY;
    this.toX = this.curX; this.toY = this.curY;
    this.saccading = false;
    this.microX = 0; this.microY = 0;
    this.gazeRX = this.curX; this.gazeRY = this.curY;
    this.fixUntil = now;
    const vd = this.rng.uniform(300, 700);                            // (6)
    this.clearSacQ();
    if (S.gaze.kind !== GazeKind.None) {
      this.pushSac(0, this.viewY, 0);                                 // exactly VIEW: the first Watch fixation
      this.sacQNextAt = now + this.openStart + this.openDur + vd;
    }
  }

  enterWatch(now) {
    const S = this.styles[this.style];
    this.ph = Phase.Watch;
    this.phaseStart = now;
    const d = this.rng.logNormal(S.behavior.watchMedian, 0.5);       // (1)
    this.watchEnd = now + 1000 * clamp(d, 8, 45);
    this.nextBlinkAt = now + this.ibiDelayMs();                       // (2)
    const ev = this.rng.uniform(3, 8);                                // (3)
    this.nextEventAt = now + 1000 * ev;
    if (S.fx.dropoutRate > 0) this.scheduleDropout(now);             // (4)
  }

  enterTransition(now) {
    this.ph = Phase.Transition;
    this.phaseStart = now;
    this.postStartleWatch = false;
    this.transHold = this.rng.uniform(200, 500);                      // (1)
    this.transSwapped = false;
  }

  /** At hold start: swap style, fullClear, reset generators. */
  transitionSwap(now) {
    this.transSwapped = true;
    let ns = this.forced;
    if (ns < 0) ns = this.bagNext();
    this.setStyle(ns);
    this.frameFullClear = true;
    this.generatorReset(now);
  }

  /** @param {boolean} approachEnd CLOSE variant, 150 ms, no draws (Approach event end). */
  enterVanish(now, approachEnd) {
    const S = this.styles[this.style];
    this.ph = Phase.Vanish;
    this.phaseStart = now;
    this.postStartleWatch = false;
    this.vanRetreat = false;
    this.vanDouble = false;
    this.vanCloseDur = 150;
    this.vanCloseStart = 0;
    if (!approachEnd) {
      this.vanRetreat = this.rng.chance(0.25);                                     // (1)
      if (!this.vanRetreat && appearKindOf(S) === AppearKind.Lid) {
        this.vanDouble = this.rng.chance(0.15);                                    // (2)
      }
      if (!this.vanRetreat) this.vanCloseDur = this.rng.uniform(250, 500);         // (3)
    }
    if (this.vanDouble) {
      const gap = DBL_TC + DBL_TH + 0.45 * DBL_TO;                                 // 202 ms
      this.addBlink(now, DBL_TC, DBL_TH, DBL_TO, 1, MASK_BOTH);
      this.addBlink(now + gap, DBL_TC, DBL_TH, DBL_TO, 1, MASK_BOTH);
      this.vanCloseStart = gap + DBL_TC + DBL_TH + DBL_TO;                         // CLOSE when the second ends
    }
    if (this.vanRetreat) this.vanEnd = 1200 + VANISH_TAIL_MS;
    else this.vanEnd = this.vanCloseStart + this.vanCloseDur + VANISH_TAIL_MS;
  }

  // ---------------------------------------------------------------------------
  // Startle (§6.6)

  enterStartle(now) {
    const prev = this.ph;
    this.hasStartled = true;
    this.lastStartleAt = now;
    let target = this.style;
    if (prev === Phase.Dark) target = this.nextStyle;
    // In Dark, lastPlayed (the style shown before) must not be hellfire either: no repeat via a jump.
    let jump = false;
    if (this.hellfire >= 0 && target !== this.hellfire && this.lastPlayed !== this.hellfire) {
      jump = this.rng.chance(0.1);                                                    // (1)
    }
    const holdS = this.rng.uniform(1.5, 4);                                           // (2)
    this.startleHold = 1000 * holdS;
    this.startleBl0 = this.backlight;
    this.startleOpen0 = this.appearOpen;
    if (jump) {
      if (prev === Phase.Dark) this.returnNextToBag();
      this.setStyle(this.hellfire);
      this.frameFullClear = true;
      this.generatorReset(now);
    } else if (prev === Phase.Dark) {
      this.setStyle(this.nextStyle);
      this.nextFromBag = false;
      this.frameFullClear = true;
      this.resetStyleState();
    }
    this.ph = Phase.Startle;
    this.phaseStart = now;
    this.postStartleWatch = false;
    this.startleExited = false;
    this.squintHold = false;
    const S = this.styles[this.style];
    if (S.gaze.kind !== GazeKind.None) this.startSaccade(0, this.viewY, 60, now);    // draws per §6.5 (a)/(b)
    // Blinks, events and dropouts are suppressed; active ones are cancelled.
    this.clearBlinks();
    this.cancelEvent();
    this.cancelDropouts();
  }

  exitStartle(now) {
    const toVanish = this.rng.chance(0.6);                                            // (3)
    this.startleExited = true;
    this.startleExitAt = now;
    if (toVanish) {
      this.squintHold = true;
      this.squintHoldStart = now;
      this.enterVanish(now, false);
    } else {
      this.enterWatch(now);
      this.postStartleWatch = true;
    }
  }

  /** Transition swap and jump-scare (§6.6 order). Uses the (new) current style. */
  generatorReset(now) {
    this.clearBlinks();
    this.nextBlinkAt = now + this.ibiDelayMs();                                       // (1)
    this.fixUntil = now;                                                              // cur kept
    this.saccading = false;
    this.cancelEvent();                                                               // drops queued saccades
    const ev = this.rng.uniform(3, 8);                                                // (2)
    this.nextEventAt = now + 1000 * ev;
    this.cancelDropouts();
    if (this.styles[this.style].fx.dropoutRate > 0) this.scheduleDropout(now);       // (3)
    this.resetStyleState();
  }

  setStyle(i) {
    this.style = i;
    this.lastPlayed = i;
  }

  /** Style-dependent state a fresh style starts from (no draws). */
  resetStyleState() {
    const S = this.styles[this.style];
    this.pupilP = S.pupilDyn.rest;
    this.texPhase = 0;
    this.spinPhase = 0;
    this.scanXmm = -(this.spacingMm / 2 + this.rDispMm);
    this.scanDir = 1;
    this.tranceMul = 1;
  }

  // ---------------------------------------------------------------------------
  // Style bag (§6.8)

  buildBag() {
    this.bagLen = 0;
    for (let attempt = 0; attempt < 2 && this.bagLen === 0; attempt++) {
      this.bagGen++;
      const odd = (this.bagGen & 1) === 1;
      for (let i = 0; i < this.count; i++) {
        const w = this.styles[i].weight;
        if (w >= 1 || (odd && w > 0)) {
          this.bag[this.bagLen] = i;
          this.bagLen++;
        }
      }
    }
    const n = this.bagLen;
    for (let i = n - 1; i >= 1; i--) {
      const r = this.rng.next();
      const j = Math.floor(r * (i + 1));
      const t = this.bag[i]; this.bag[i] = this.bag[j]; this.bag[j] = t;
    }
    if (n > 1 && this.bag[0] === this.lastPlayed) {
      const r = this.rng.next();
      const k = 1 + Math.floor(r * (n - 1));
      const t = this.bag[0]; this.bag[0] = this.bag[k]; this.bag[k] = t;
    }
  }

  bagNext() {
    // A sole remaining item equal to lastPlayed was just shown (jump-scare / pin): consume it.
    if (this.bagLen === 1 && this.bag[0] === this.lastPlayed) this.bagLen = 0;
    if (this.bagLen === 0) this.buildBag();
    if (this.bagLen === 0) return this.style;            // every weight is 0: keep the current style
    if (this.bagLen > 1 && this.bag[0] === this.lastPlayed) {
      const f = this.bag[0];                             // front to back (no draw)
      for (let i = 0; i < this.bagLen - 1; i++) this.bag[i] = this.bag[i + 1];
      this.bag[this.bagLen - 1] = f;
    }
    const v = this.bag[0];
    for (let i = 0; i < this.bagLen - 1; i++) this.bag[i] = this.bag[i + 1];
    this.bagLen--;
    this.pickSerial++;
    this.lastPick = v;
    this.lastPickGen = this.bagGen;
    return v;
  }

  /** Put an unshown bag pick (nextStyle) back at the front of the bag (no draw). */
  returnNextToBag() {
    if (!this.nextFromBag) return;
    this.nextFromBag = false;
    if (this.bagLen >= this.bag.length) return;
    for (let i = this.bagLen; i > 0; i--) this.bag[i] = this.bag[i - 1];
    this.bag[0] = this.nextStyle;
    this.bagLen++;
  }

  // ---------------------------------------------------------------------------
  // Blink generator (§6.4)

  /** ms from now to the next spontaneous blink (draws: logNormal). */
  ibiDelayMs() {
    const B = this.styles[this.style].blink;
    const ibi = this.rng.logNormal(B.ibiMedian, B.ibiSigma);
    return 1000 * clamp(ibi, 0.8, 30);
  }

  clearBlinks() {
    for (let i = 0; i < BLINK_SLOTS; i++) this.blinks[i].active = false;
    this.burstPending = false;
    this.burstEnd = 0;
    this.blinkL = 0;
    this.blinkR = 0;
  }

  /** Record one blink (no draws). Replaces the earliest-ending record when all slots are busy. */
  addBlink(start, tc, th, to, depth, mask) {
    if (this.styles[this.style].blink.kind === BlinkKind.None) return;
    let slot = -1;
    for (let i = 0; i < BLINK_SLOTS; i++) {
      if (!this.blinks[i].active) { slot = i; break; }
    }
    if (slot < 0) {
      let best = Infinity;
      for (let i = 0; i < BLINK_SLOTS; i++) {
        const b = this.blinks[i];
        const end = b.start + b.tc + b.th + b.to;
        if (end < best) { best = end; slot = i; }
      }
    }
    const b = this.blinks[slot];
    this.blinkSerial++;
    b.active = true;
    b.start = start;
    b.tc = tc;
    b.th = th;
    b.to = to;
    b.depth = depth;
    b.mask = mask;
    b.serial = this.blinkSerial;
  }

  /**
   * fire(now [, maskOverride] [, countOverride]) with -1 = not given. Returns the end time
   * of the burst's last blink, or -1 when the style never blinks.
   */
  fire(now, maskOverride, countOverride) {
    const B = this.styles[this.style].blink;
    if (B.kind === BlinkKind.None) return -1;
    const partial = this.rng.chance(B.pPartial);                     // (1)
    let depth = 1;
    if (partial) depth = this.rng.uniform(0.5, 0.7);                 // (2)
    let tc = B.tc * this.rng.uniform(0.85, 1.15);                    // (3)
    const th = B.th * this.rng.uniform(0.85, 1.15);                  // (4)
    let to = B.to * this.rng.uniform(0.85, 1.15);                    // (5)
    if (tc < 70) tc = 70;                                            // cold-LC floor (R16)
    if (to < 160) to = 160;
    let mask = maskOverride;
    if (mask < 0) {
      const wink = this.rng.chance(B.pWink);                         // (6)
      mask = MASK_BOTH;
      if (wink) {
        const left = this.rng.chance(0.5);                           // (7)
        mask = left ? MASK_L : MASK_R;
      }
    }
    let count = countOverride;
    if (count < 0) {
      const triple = this.rng.chance(B.pTriple);                     // (8)
      let dbl = false;
      if (!triple) dbl = this.rng.chance(B.pDouble);                 // (9)
      count = triple ? 3 : (dbl ? 2 : 1);
    }
    const gap = tc + th + 0.45 * to;
    let start = now;
    for (let k = 0; k < count; k++) {
      this.addBlink(start, tc, th, to, k === 0 ? depth : 1, mask);
      if (k < count - 1) start += gap;
    }
    const end = start + tc + th + to;
    if (!this.burstPending || end > this.burstEnd) this.burstEnd = end;
    this.burstPending = true;
    return end;
  }

  /** forceBlink input: style tc/th/to clamped, no jitter, no draws, BOTH, depth 1, single. */
  forceBlink(now) {
    const B = this.styles[this.style].blink;
    if (B.kind === BlinkKind.None) return;
    let tc = B.tc;
    let to = B.to;
    if (tc < 70) tc = 70;
    if (to < 160) to = 160;
    this.addBlink(now, tc, B.th, to, 1, MASK_BOTH);
  }

  /** Per-eye blink values (max over overlapping blinks); frees finished records. */
  evalBlinks(now) {
    const lag = this.styles[this.style].behavior.lagMs;
    let bL = 0;
    let bR = 0;
    for (let i = 0; i < BLINK_SLOTS; i++) {
      const b = this.blinks[i];
      if (!b.active) continue;
      const tau = now - b.start;
      if (tau >= b.tc + b.th + b.to + lag) { b.active = false; continue; }
      if (b.mask & MASK_L) {
        const v = blinkEnv(tau, b.tc, b.th, b.to, b.depth);
        if (v > bL) bL = v;
      }
      if (b.mask & MASK_R) {
        const v = blinkEnv(tau - lag, b.tc, b.th, b.to, b.depth);
        if (v > bR) bR = v;
      }
    }
    this.blinkL = bL;
    this.blinkR = bR;
  }

  // ---------------------------------------------------------------------------
  // Watch generators

  updateWatchGenerators(now) {
    const S = this.styles[this.style];

    // Events (§6.7). updateEvent may end Watch (Approach -> Vanish).
    if (this.evType >= 0) this.updateEvent(now);
    if (this.ph !== Phase.Watch) return;
    if (now >= this.nextEventAt && now < this.watchEnd) {
      if (this.evType < 0) {
        const i = this.rng.pickWeighted(S.events.w, EV_COUNT);       // (1)
        if (i >= 0) this.startEvent(i, now);
        const ev = this.rng.uniform(3, 8);                            // (last)
        this.nextEventAt = now + 1000 * ev;
      } else {
        this.nextEventAt = now + 1000;
      }
    }
    if (this.ph !== Phase.Watch) return;

    // Spontaneous blinks (§6.4)
    if (this.burstPending && now >= this.burstEnd) {
      this.burstPending = false;
      const sched = now + this.ibiDelayMs();
      this.nextBlinkAt = Math.max(sched, this.burstEnd + 250);
    }
    if (S.blink.kind !== BlinkKind.None && !this.burstPending && now >= this.nextBlinkAt) {
      this.fire(now, -1, -1);
    }

    // Dropouts (§6.5)
    if (S.fx.dropoutRate > 0) {
      if (this.drop2Pending && now >= this.drop2At) {
        this.drop2Pending = false;
        const d2 = this.rng.uniform(40, 90);
        if (this.drop2At + d2 > this.dropUntil) this.dropUntil = this.drop2At + d2;
      }
      if (now >= this.nextDropAt) {
        const d = this.rng.uniform(40, 90);                           // (1)
        if (now + d > this.dropUntil) this.dropUntil = now + d;
        const second = this.rng.chance(0.2);                          // (2)
        if (second) {
          this.drop2Pending = true;
          this.drop2At = now + 120;
        }
        this.scheduleDropout(now);                                    // (3)
      }
    }
  }

  scheduleDropout(now) {
    const e = this.rng.next();
    const rate = this.styles[this.style].fx.dropoutRate;
    this.nextDropAt = now + 1000 * (-Math.log(Math.max(e, 1e-6)) / rate);
  }

  cancelDropouts() {
    this.dropUntil = 0;
    this.drop2Pending = false;
  }

  // ---------------------------------------------------------------------------
  // Idle events (§6.7)

  startEvent(i, now) {
    const S = this.styles[this.style];
    const G = S.gaze;
    this.evType = i;
    this.evStart = now;
    this.evDur = 0;
    switch (i) {
      case EventType.Squint: {
        this.evH = this.rng.uniform(1000, 2000);                      // (1)
        this.evDur = 300 + this.evH + 400;
        break;
      }
      case EventType.Dilate:
        this.evDur = 600 + 1500 + 600;
        break;
      case EventType.LookAround: {
        const four = this.rng.chance(0.5);                            // (1)
        const n = four ? 4 : 3;
        const pos = this.rng.chance(0.5);                             // (2)
        const side = pos ? 1 : -1;
        this.clearSacQ();
        for (let k = 0; k < n; k++) {
          const y = this.rng.uniform(-0.2, 0.2);                      // (3+2k)
          const f = this.rng.uniform(250, 400);                       // (4+2k)
          const x = (k % 2 === 0) ? 0.8 * side : -0.8 * side;
          if (G.kind !== GazeKind.None) this.pushSac(x, y, f);
        }
        if (G.kind !== GazeKind.None) this.pushSac(0, this.viewY, 0);
        this.sacQNextAt = now;
        break;                                                        // ends when the queue is empty
      }
      case EventType.Flurry: {
        const end = this.fire(now, -1, 3);
        this.evDur = end >= 0 ? end - now : 0;
        break;
      }
      case EventType.Wink: {
        const left = this.rng.chance(0.5);                            // (1)
        const end = this.fire(now, left ? MASK_L : MASK_R, -1);
        this.evDur = end >= 0 ? end - now : 0;
        break;
      }
      case EventType.SlowBlink:
        this.addBlink(now, 400, 600, 500, 0.6, MASK_BOTH);
        this.evDur = 1500;
        break;
      case EventType.Sweep: {
        const pos = this.rng.chance(0.5);                             // (1)
        this.evDir = pos ? 1 : -1;
        if (G.kind !== GazeKind.None) {
          // Lead-in: draw-free saccade to the sweep start, then linear pursuit at 0.25/rangeX per s.
          const sx = -0.9 * this.evDir;
          const lead = this.saccadeDurMs(sx, 0);
          this.beginSaccadeMotion(sx, 0, lead, now);
          this.sweepLeadEnd = now + lead;
          this.sweepEnd = this.sweepLeadEnd + 1000 * 1.8 * G.rangeX / 0.25;
          this.evDur = this.sweepEnd - now;
        }
        break;
      }
      case EventType.Tilt: {
        this.evH = this.rng.uniform(1000, 2000);                      // (1)
        const pos = this.rng.chance(0.5);                             // (2)
        this.tiltSign = pos ? 1 : -1;
        this.evDur = 600 + this.evH + 600;
        break;
      }
      case EventType.Swivel: {
        const pos = this.rng.chance(0.5);                             // (1)
        this.evDir = pos ? 1 : -1;
        this.evH = this.rng.uniform(1000, 3000);                      // (2)
        this.evDur = 700 + this.evH + 700;
        break;
      }
      case EventType.Trance:
        this.evDur = 3000 + 2000 + 2000;
        break;
      case EventType.Giggle:
        this.evDur = 800;
        break;
      case EventType.Approach:
        this.evDur = 10000;
        break;
      case EventType.Gutter:
        this.evH = this.rng.uniform(120, 250);                        // (1)
        this.evDur = this.evH;
        break;
      default:
        this.evType = -1;
        return;
    }
    this.updateEvent(now);
  }

  /** Evaluate the active event's envelopes at now; ends it when done. */
  updateEvent(now) {
    const tau = now - this.evStart;
    const S = this.styles[this.style];
    switch (this.evType) {
      case EventType.Squint:
        this.squintEv = trap(tau, 300, this.evH, 400);
        break;
      case EventType.Dilate:
        this.dilateEnv = trap(tau, 600, 1500, 600);
        break;
      case EventType.LookAround:
        if (this.sacQLen === 0) this.endEvent();
        return;
      case EventType.Sweep: {
        if (S.gaze.kind === GazeKind.None) { this.endEvent(); return; }
        if (now < this.sweepLeadEnd) return;                          // lead-in saccade in flight
        if (now < this.sweepEnd) {
          this.saccading = false;
          this.curX = -0.9 * this.evDir + this.evDir * (0.25 / S.gaze.rangeX) * (now - this.sweepLeadEnd) / 1000;
          this.curY = 0;
          return;
        }
        this.curX = 0.9 * this.evDir;
        this.curY = 0;
        this.endEvent();
        this.startSaccade(0, this.viewY, -1, now);
        return;
      }
      case EventType.Tilt:
        this.tiltEnv = trap(tau, 600, this.evH, 600);
        break;
      case EventType.Swivel:
        if (tau < 700) {
          this.swivel = 2.6 * this.evDir * smoothstep(0, 700, tau);
          this.swivelHide = 1;
        } else if (tau < 700 + this.evH) {
          this.swivel = 2.6 * this.evDir;
          this.swivelHide = 0;
        } else {
          const t2 = tau - 700 - this.evH;
          this.swivel = -2.6 * this.evDir * (1 - smoothstep(0, 700, t2));
          this.swivelHide = 1;
        }
        break;
      case EventType.Trance:
        this.tranceMul = 1 + trap(tau, 3000, 2000, 2000);
        break;
      case EventType.Giggle: {
        const ts = tau / 1000;
        this.giggle = 0.05 * Math.abs(Math.sin(TWO_PI * 6 * ts)) * Math.exp(-3 * ts);
        break;
      }
      case EventType.Approach: {
        const s = smoothstep(0, 10000, tau);
        this.approachScale = 1 + 1.2 * s;
        this.approachMedial = -0.3 * s;
        if (tau >= this.evDur) {
          // Keep the approached pose; the forced CLOSE hides it (reset at Dark).
          this.evType = -1;
          this.enterVanish(now, true);
        }
        return;
      }
      case EventType.Gutter:
        this.gutter = tau < this.evH ? 0.35 : 1;
        break;
      default:
        break;                                                        // Flurry, Wink, SlowBlink: timed only
    }
    if (tau >= this.evDur) this.endEvent();
  }

  /** Natural end: envelopes back to rest (queued saccades untouched). */
  endEvent() {
    this.evType = -1;
    this.resetEnvelopes();
  }

  /** Cancel (Startle, generator reset, Dark): envelopes to rest and queued saccades dropped. */
  cancelEvent() {
    this.evType = -1;
    this.resetEnvelopes();
    this.approachScale = 1;
    this.approachMedial = 0;
    this.clearSacQ();
  }

  resetEnvelopes() {
    this.squintEv = 0;
    this.dilateEnv = 0;
    this.tiltEnv = 0;
    this.swivel = 0;
    this.swivelHide = 1;
    this.tranceMul = 1;
    this.giggle = 0;
    this.gutter = 1;
  }

  // ---------------------------------------------------------------------------
  // Gaze (§6.5)

  clearSacQ() {
    this.sacQHead = 0;
    this.sacQLen = 0;
  }

  pushSac(x, y, hold) {
    if (this.sacQLen >= SACQ_CAP) return;
    const e = this.sacQ[(this.sacQHead + this.sacQLen) % SACQ_CAP];
    e.x = x;
    e.y = y;
    e.hold = hold;
    this.sacQLen++;
  }

  /** Saccade duration to target (tx, ty) from cur (target already normalized). */
  saccadeDurMs(tx, ty) {
    const G = this.styles[this.style].gaze;
    const A = len((tx - this.curX) * G.rangeX, (ty - this.curY) * G.rangeY);   // eye-local units
    return Math.max(60, G.sacScale * (21 + 2.2 * 89 * A));                   // 89 deg per unit
  }

  beginSaccadeMotion(tx, ty, dur, now) {
    this.fromX = this.curX; this.fromY = this.curY;
    this.toX = tx; this.toY = ty;
    this.sacStart = now;
    this.sacDur = dur;
    this.saccading = true;
    this.microX = 0; this.microY = 0;
  }

  /** startSaccade(T [, durOverride]); durOverride <= 0 = not given. */
  startSaccade(tx, ty, durOverride, now) {
    const G = this.styles[this.style].gaze;
    const l = len(tx, ty);
    if (l > 1) { tx /= l; ty /= l; }
    let dur = durOverride;
    if (!(dur > 0)) dur = this.saccadeDurMs(tx, ty);
    const jump = len(tx - this.curX, ty - this.curY);
    this.beginSaccadeMotion(tx, ty, dur, now);
    if (jump > 0.6) {
      const gb = this.rng.chance(G.pGazeBlink);                                 // (a)
      if (gb) this.fire(now, -1, -1);
    }
    const fix = this.rng.logNormal(G.fixMedian, 0.6);                           // (b)
    this.fixUntil = now + dur + 1000 * clamp(fix, 0.15, 8);
  }

  updateGaze(now, dt) {
    const S = this.styles[this.style];
    const G = S.gaze;
    if (G.kind === GazeKind.None) return;

    // Queued saccades (Appear viewer saccade, LookAround)
    if (this.sacQLen > 0 && now >= this.sacQNextAt) {
      const e = this.sacQ[this.sacQHead];
      const ex = e.x, ey = e.y, hold = e.hold;
      this.sacQHead = (this.sacQHead + 1) % SACQ_CAP;
      this.sacQLen--;
      this.startSaccade(ex, ey, -1, now);
      this.sacQNextAt = now + this.sacDur + hold;
    }

    // Random fixations (Watch only; paused by queued saccades and Sweep)
    const maxBlink = this.blinkL > this.blinkR ? this.blinkL : this.blinkR;
    if (this.ph === Phase.Watch && !this.saccading && now >= this.fixUntil && maxBlink < 0.5 &&
        this.sacQLen === 0 && this.evType !== EventType.Sweep) {
      const vb = this.postStartleWatch ? 0.8 : G.viewerBias;
      const r = this.rng.next();                                                // (1)
      let tx, ty;
      if (r < vb) {
        const jx = this.rng.uniform(-0.05, 0.05);                               // (2)
        const jy = this.rng.uniform(-0.05, 0.05);                               // (3)
        tx = jx;
        ty = this.viewY + jy;
      } else if (r < vb + 0.10) {
        const s = this.rng.chance(0.5);                                         // (2)
        const y = this.rng.uniform(-0.3, 0.3);                                  // (3)
        tx = s ? 0.9 : -0.9;
        ty = y;
      } else {
        const ang = this.rng.uniform(0, TWO_PI);                                // (2)
        const e = this.rng.next();                                              // (3)
        const rad = Math.min(1, -0.35 * Math.log(Math.max(e, 1e-6)));
        tx = rad * Math.cos(ang);
        ty = rad * Math.sin(ang);
      }
      this.startSaccade(tx, ty, -1, now);
    }

    // Saccade motion
    if (this.saccading) {
      const u = clamp((now - this.sacStart) / this.sacDur, 0, 1);
      const o = G.overshoot;
      const v = u - 1;
      let s;
      if (o > 0) s = 1 + (o + 1) * v * v * v + o * v * v;
      else s = 1 + v * v * v;                                                   // 1 - (1-u)^3
      this.curX = this.fromX + (this.toX - this.fromX) * s;
      this.curY = this.fromY + (this.toY - this.fromY) * s;
      if (u >= 1) this.saccading = false;
    }

    // Microsaccades
    if (G.microHz > 0 && now >= this.nextMicroAt) {
      const mx = this.rng.uniform(-1, 1);                                       // (1)
      const my = this.rng.uniform(-1, 1);                                       // (2)
      this.microX = mx * G.microAmp / G.rangeX;
      this.microY = my * G.microAmp / G.rangeY;
      const e = this.rng.next();                                                // (3)
      this.nextMicroAt = now + 1000 * (-Math.log(Math.max(e, 1e-6)) / G.microHz);
    }

    // Right eye: low-pass behind the left (lazy eye)
    const gLx = this.curX + this.microX;
    const gLy = this.curY + this.microY;
    const lag = S.behavior.lagMs;
    if (lag > 0) {
      const k = 1 - Math.exp(-dt / lag);
      this.gazeRX += (gLx - this.gazeRX) * k;
      this.gazeRY += (gLy - this.gazeRY) * k;
    } else {
      this.gazeRX = gLx;
      this.gazeRY = gLy;
    }
  }

  // ---------------------------------------------------------------------------
  // Pupil, accumulators, appear curves

  updatePupil(now, dts) {
    const S = this.styles[this.style];
    const PD = S.pupilDyn;
    let target;
    let tau;
    if (this.ph === Phase.Startle && PD.startle !== StartleMode.None) {
      target = PD.startle === StartleMode.Dilate ? 1 : 0;
      tau = 0.12;
    } else {
      const xh = Math.fround((now / 1000 * 0.25) % 65536);
      target = PD.rest + PD.hippus * (2 * vnoiseP(xh, 65536, S.seed) - 1) + 0.4 * this.dilateEnv;
      tau = target < this.pupilP ? PD.tauC : PD.tauD;
    }
    this.pupilP += (target - this.pupilP) * (1 - Math.exp(-dts / tau));
    this.pupilP = clamp(this.pupilP, 0, 1);
  }

  updateAccumulators(dts) {
    const F = this.styles[this.style].fill;
    this.texPhase = wrap01(this.texPhase + F.texScrollHz * dts);
    this.spinPhase = wrap01(this.spinPhase + F.spinHz * this.tranceMul * dts);
    const lim = this.spacingMm / 2 + this.rDispMm;
    this.scanXmm += this.scanDir * F.scanSpeedMm * dts;
    if (this.scanXmm > lim) {
      this.scanXmm = 2 * lim - this.scanXmm;
      this.scanDir = -1;
    } else if (this.scanXmm < -lim) {
      this.scanXmm = -2 * lim - this.scanXmm;
      this.scanDir = 1;
    }
    this.scanXmm = clamp(this.scanXmm, -lim, lim);
  }

  /** appearOpen / appearInten / appearBlink, retreat pose and relative backlight for this frame. */
  evalAppear(now) {
    const kind = appearKindOf(this.styles[this.style]);
    const tau = now - this.phaseStart;
    let f = 1;                 // fraction open of the phase curve
    let bl = 1;
    let fadeAll = false;       // intensity forced to 0 (Vanish tail)
    this.retreatScale = 1;
    this.retreatMedial = 0;
    switch (this.ph) {
      case Phase.Dark:
        this.appearOpen = 0;
        this.appearInten = 0;
        this.appearBlink = 0;
        this.backlight = 0;
        return;
      case Phase.Appear: {
        const u = clamp((tau - this.openStart) / this.openDur, 0, 1);
        f = openCurve(u);
        bl = smoothstep(0, this.ramp, tau);
        break;
      }
      case Phase.Watch: {
        const ta = now - this.appearStartAt;          // finish an Appear ramp longer than the Appear
        bl = ta < this.ramp ? smoothstep(0, this.ramp, ta) : 1;
        break;
      }
      case Phase.Transition: {
        let dip;
        if (tau < TRANS_CLOSE_MS) {
          const c = tau / TRANS_CLOSE_MS;
          f = 1 - c * c;
          dip = 0;
        } else if (tau < TRANS_CLOSE_MS + this.transHold) {
          f = 0;
          dip = smoothstep(0, 100, tau - TRANS_CLOSE_MS);
        } else {
          const to = tau - TRANS_CLOSE_MS - this.transHold;
          f = openCurve(clamp(to / TRANS_OPEN_MS, 0, 1));
          dip = 1 - smoothstep(0, 100, to);
        }
        bl = 1 - 0.3 * dip;
        break;
      }
      case Phase.Vanish: {
        if (this.vanRetreat) {
          const s = smoothstep(0, 1200, tau);
          this.retreatScale = 1 - 0.4 * s;
          this.retreatMedial = 0.1 * s;
          this.appearOpen = 1;
          this.appearInten = 1 - s;
          this.appearBlink = 0;
          this.backlight = 1 - s;
          if (tau >= 1200) this.appearInten = 0;
          return;
        }
        const u = clamp((tau - this.vanCloseStart) / this.vanCloseDur, 0, 1);
        f = 1 - u * u;
        bl = 1 - smoothstep(0, this.vanCloseDur + 200, tau - this.vanCloseStart);
        fadeAll = tau >= this.vanCloseStart + this.vanCloseDur;
        break;
      }
      case Phase.Startle: {
        this.appearOpen = lerp(this.startleOpen0, 1, openCurve(clamp(tau / 80, 0, 1)));
        this.appearInten = 1;
        this.appearBlink = 0;
        if (tau < 50) this.backlight = lerp(this.startleBl0, 1.3, smoothstep(0, 50, tau));
        else this.backlight = 1.3 - 0.3 * smoothstep(0, 300, tau - 50);
        return;
      }
      default:
        break;
    }
    if (kind === AppearKind.Lid) {
      this.appearOpen = f; this.appearInten = 1; this.appearBlink = 0;
    } else if (kind === AppearKind.Fade) {
      this.appearOpen = 1; this.appearInten = f; this.appearBlink = 0;
    } else {                                          // Crt, Squash: blink 1 -> 0 to appear
      this.appearOpen = 1; this.appearInten = 1; this.appearBlink = 1 - f;
    }
    if (fadeAll) this.appearInten = 0;
    this.backlight = bl;
  }

  // ---------------------------------------------------------------------------
  // Output (§6.1, §6.5)

  compose(now) {
    const S = this.styles[this.style];
    const fs = this.fs;
    fs.tMs = now;
    fs.style = this.style;
    fs.phase = this.ph;
    fs.panelsOn = !(this.ph === Phase.Dark && !this.darkFirstFrame);
    if (this.ph === Phase.Dark) this.darkFirstFrame = false;
    fs.fullClear = this.frameFullClear;
    fs.backlight = this.backlight;

    const ts = now / 1000;
    let squintEnv = this.squintEv;
    if (this.squintHold) {
      const sh = smoothstep(0, 200, now - this.squintHoldStart);
      if (sh > squintEnv) squintEnv = sh;
    }
    let widen = 0;
    let verg = 0;
    if (this.ph === Phase.Startle) {
      widen = 0.2;
      verg = 0.08;
    } else if (this.startleExited) {
      const r = Math.max(0, 1 - (now - this.startleExitAt) / 300);
      widen = 0.2 * r;
      verg = 0.08 * r;
    }
    let startleGlow = 0;
    if (this.hasStartled) startleGlow = 0.3 * Math.max(0, 1 - (now - this.lastStartleAt) / 1000);

    let flicker = 1;
    if (S.fx.flickerAmp > 0) {
      const xf1 = Math.fround((ts * S.fx.flickerHz) % 65536);
      const xf2 = Math.fround((ts * S.fx.flickerHz * 1.9) % 65536);
      const n1 = vnoiseP(xf1, 65536, (S.seed + 5) >>> 0);
      const n2 = vnoiseP(xf2, 65536, (S.seed + 6) >>> 0);
      flicker = 1 + S.fx.flickerAmp * (1.2 * (n1 - 0.5) + 0.8 * (n2 - 0.5));
    }
    const dropout = now < this.dropUntil ? 0.3 : 1;
    const intensity = this.appearInten * flicker * dropout * this.gutter * this.swivelHide;
    const glowGain = 1 + S.glow.pulseAmp * Math.sin(TWO_PI * S.glow.pulseHz * ts) + startleGlow;
    const scale = (1 + S.fx.breatheAmp * Math.sin(TWO_PI * S.fx.breatheHz * ts)) * this.approachScale * this.retreatScale;
    const headDy = S.fx.bobAmp * Math.sin(TWO_PI * S.fx.bobHz * ts) + this.giggle;
    const headDx = this.swivel;
    const headTilt = this.tiltEnv * this.tiltSign * 0.105;
    const medialAdj = this.approachMedial + this.retreatMedial;

    let gLx = 0, gLy = 0, gRx = 0, gRy = 0;
    if (S.gaze.kind !== GazeKind.None) {
      gLx = clamp(this.curX + this.microX, -1.3, 1.3);
      gLy = clamp(this.curY + this.microY, -1.3, 1.3);
      gRx = clamp(this.gazeRX, -1.3, 1.3);
      gRy = clamp(this.gazeRY, -1.3, 1.3);
    }

    for (let e = 0; e < 2; e++) {
      const es = fs.eye[e];
      const isR = e === 1;
      es.gazeX = isR ? gRx : gLx;
      es.gazeY = isR ? gRy : gLy;
      es.vergence = S.gaze.vergence + verg - (isR ? S.behavior.lagOffset : 0);
      const droop = isR ? S.behavior.droopR : S.behavior.droopL;
      es.openness = this.appearOpen * (1 - 0.3 * squintEnv) * (1 - droop) + widen;
      const bg = isR ? this.blinkR : this.blinkL;
      es.blink = bg > this.appearBlink ? bg : this.appearBlink;
      es.pupil = this.pupilP;
      es.intensity = intensity;
      es.glowGain = glowGain;
      es.scale = scale;
      es.headTilt = headTilt;
      es.headDx = headDx;
      es.headDy = headDy;
      es.medialAdj = medialAdj;
      es.texPhase = this.texPhase;
      es.spinPhase = this.spinPhase;
      es.scanXmm = this.scanXmm;
      es.scanDir = this.scanDir;
    }
  }
}
