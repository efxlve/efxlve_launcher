/**
 * Directional input and auto-repeat state machine for controllers.
 *
 * Keeps D-pad presses and left-stick deflections crisp and immune to double
 * triggers by combining:
 * - an initial hold delay (`firstDelayMs`) before auto-repeat begins,
 * - Schmitt-trigger hysteresis (`stickEngage` / `stickRelease`) on the stick,
 * - dominant-axis stick selection so diagonal drift never chatters between axes,
 * - a short opposite-axis snapback guard after releasing a firm stick flick,
 * - D-pad direction latching so grazing an adjacent direction never double-fires.
 */

export type PadDir = "up" | "down" | "left" | "right";

export interface PadRepeatOptions {
  /** Hold time in ms before the first auto-repeat step fires. */
  firstDelayMs?: number;
  /** Interval in ms between repeat steps before acceleration kicks in. */
  repeatMs?: number;
  /** Hold time in ms after which repeat accelerates (tier 1). */
  accel1AfterMs?: number;
  /** Repeat interval in ms for tier 1 acceleration. */
  accel1Ms?: number;
  /** Hold time in ms after which repeat accelerates further (tier 2). */
  accel2AfterMs?: number;
  /** Repeat interval in ms for tier 2 acceleration. */
  accel2Ms?: number;
  /** Stick axis threshold required to engage from neutral. */
  stickEngage?: number;
  /** Stick axis threshold below which an engaged axis releases. */
  stickRelease?: number;
  /** Window in ms to ignore opposite-stick snapback after releasing a strong flick. */
  snapbackGuardMs?: number;
}

export interface PadDirectionSample {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  lx: number;
  ly: number;
}

export interface PadDirectionResult {
  /** Non-null when a navigation step should happen on this tick. */
  step: PadDir | null;
  /** Currently held direction (D-pad or stick), if any. */
  activeDir: PadDir | null;
  /** True only on the initial press edge of a direction. */
  isInitial: boolean;
}

const DEFAULTS: Required<PadRepeatOptions> = {
  firstDelayMs: 320,
  repeatMs: 105,
  accel1AfterMs: 900,
  accel1Ms: 72,
  accel2AfterMs: 1650,
  accel2Ms: 48,
  stickEngage: 0.50,
  stickRelease: 0.30,
  snapbackGuardMs: 110,
};

/** Peak stick deflection required before the opposite-axis snapback guard arms. */
const SNAPBACK_PEAK_THRESHOLD = 0.72;
/** Multiplier required for a perpendicular stick axis to steal focus mid-hold. */
const CROSS_AXIS_STEAL_RATIO = 1.25;

function oppositeDir(dir: PadDir): PadDir {
  switch (dir) {
    case "up": return "down";
    case "down": return "up";
    case "left": return "right";
    case "right": return "left";
  }
}

function stickValueFor(dir: PadDir, lx: number, ly: number): number {
  switch (dir) {
    case "left": return -lx;
    case "right": return lx;
    case "up": return -ly;
    case "down": return ly;
  }
}

function isHorizontal(dir: PadDir): boolean {
  return dir === "left" || dir === "right";
}

/**
 * Stateful directional input processor for one controller stream.
 */
export class PadDirectionInput {
  private readonly opts: Required<PadRepeatOptions>;
  private dpadDir: PadDir | null = null;
  private stickDir: PadDir | null = null;
  private stickPeak = 0;
  private snapbackDir: PadDir | null = null;
  private snapbackUntil = 0;
  private repeatDir: PadDir | null = null;
  private holdStartMs = 0;
  private lastStepMs = 0;
  private hasRepeated = false;

  constructor(options: PadRepeatOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  reset(): void {
    this.dpadDir = null;
    this.stickDir = null;
    this.stickPeak = 0;
    this.snapbackDir = null;
    this.snapbackUntil = 0;
    this.repeatDir = null;
    this.holdStartMs = 0;
    this.lastStepMs = 0;
    this.hasRepeated = false;
  }

  /**
   * Synchronizes held state without emitting a step (used when re-arming or
   * regaining window focus so an already-held direction does not fire a tap).
   */
  syncHeld(sample: PadDirectionSample, now: number): void {
    const activeDir = this.resolveDirection(sample, now);
    this.repeatDir = activeDir;
    this.holdStartMs = now;
    this.lastStepMs = now;
    this.hasRepeated = false;
  }

  /** Advances the state machine by one frame and reports any emitted step. */
  update(sample: PadDirectionSample, now: number): PadDirectionResult {
    const activeDir = this.resolveDirection(sample, now);
    if (!activeDir) {
      this.repeatDir = null;
      this.hasRepeated = false;
      return { step: null, activeDir: null, isInitial: false };
    }

    if (activeDir !== this.repeatDir) {
      this.repeatDir = activeDir;
      this.holdStartMs = now;
      this.lastStepMs = now;
      this.hasRepeated = false;
      return { step: activeDir, activeDir, isInitial: true };
    }

    const totalHeld = now - this.holdStartMs;
    if (!this.hasRepeated) {
      if (totalHeld >= this.opts.firstDelayMs) {
        this.hasRepeated = true;
        this.lastStepMs = now;
        return { step: activeDir, activeDir, isInitial: false };
      }
      return { step: null, activeDir, isInitial: false };
    }

    const interval = totalHeld > this.opts.accel2AfterMs
      ? this.opts.accel2Ms
      : totalHeld > this.opts.accel1AfterMs
        ? this.opts.accel1Ms
        : this.opts.repeatMs;
    if (now - this.lastStepMs >= interval) {
      this.lastStepMs = now;
      return { step: activeDir, activeDir, isInitial: false };
    }
    return { step: null, activeDir, isInitial: false };
  }

  private resolveDirection(sample: PadDirectionSample, now: number): PadDir | null {
    const dpad = this.resolveDpad(sample);
    const stick = this.resolveStick(sample.lx, sample.ly, now);
    return dpad ?? stick;
  }

  private resolveDpad(sample: PadDirectionSample): PadDir | null {
    const clean: Record<PadDir, boolean> = {
      up: sample.up && !sample.down,
      down: sample.down && !sample.up,
      left: sample.left && !sample.right,
      right: sample.right && !sample.left,
    };
    if (this.dpadDir && clean[this.dpadDir]) {
      return this.dpadDir;
    }
    if (clean.up) this.dpadDir = "up";
    else if (clean.down) this.dpadDir = "down";
    else if (clean.left) this.dpadDir = "left";
    else if (clean.right) this.dpadDir = "right";
    else this.dpadDir = null;
    return this.dpadDir;
  }

  private resolveStick(lx: number, ly: number, now: number): PadDir | null {
    const ax = Math.abs(lx);
    const ay = Math.abs(ly);
    const { stickEngage, stickRelease, snapbackGuardMs } = this.opts;

    if (this.stickDir !== null) {
      const curVal = stickValueFor(this.stickDir, lx, ly);
      if (curVal > this.stickPeak) this.stickPeak = curVal;

      const horiz = isHorizontal(this.stickDir);
      const otherMag = horiz ? ay : ax;
      const curMag = horiz ? ax : ay;
      if (otherMag >= stickEngage && otherMag > curMag * CROSS_AXIS_STEAL_RATIO) {
        this.stickDir = horiz ? (ly < 0 ? "up" : "down") : (lx < 0 ? "left" : "right");
        this.stickPeak = otherMag;
        return this.stickDir;
      }

      if (curVal >= stickRelease) {
        return this.stickDir;
      }

      if (this.stickPeak >= SNAPBACK_PEAK_THRESHOLD) {
        this.snapbackDir = oppositeDir(this.stickDir);
        this.snapbackUntil = now + snapbackGuardMs;
      }
      this.stickDir = null;
      this.stickPeak = 0;
    }

    if (Math.max(ax, ay) < stickEngage) {
      return null;
    }

    const cand: PadDir = ax >= ay
      ? (lx < 0 ? "left" : "right")
      : (ly < 0 ? "up" : "down");

    if (cand === this.snapbackDir && now < this.snapbackUntil) {
      return null;
    }

    this.stickDir = cand;
    this.stickPeak = Math.max(ax, ay);
    this.snapbackDir = null;
    this.snapbackUntil = 0;
    return this.stickDir;
  }
}
