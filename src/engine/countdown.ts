// Standing start (§4.4): staging checks, countdown arithmetic, jump-start and launch detection.

import { dist, median, type Vec2 } from './geo';

export const COUNTDOWN_MIN_S = 3;
export const COUNTDOWN_MAX_S = 10;
export const DEFAULT_COUNTDOWN_S = 5;

export function clampCountdown(seconds: number): number {
  return Math.min(COUNTDOWN_MAX_S, Math.max(COUNTDOWN_MIN_S, Math.round(seconds)));
}

export interface StagingConfig {
  maxAccuracyM: number;
  /** Allowed distance behind the start line. */
  behindM: number;
  /** Allowed distance past the start line (tolerates GPS error). */
  aheadM: number;
  maxSpeedMps: number;
  maxSpreadM: number;
  windowFixes: number;
}

export const DEFAULT_STAGING: StagingConfig = {
  maxAccuracyM: 10,
  behindM: 20,
  aheadM: 2,
  maxSpeedMps: 1,
  maxSpreadM: 3,
  windowFixes: 3,
};

export interface StagingSample {
  t: number;
  xy: Vec2;
  /** Distance along the route; the start line is 0. */
  s: number;
  /** Distance from the route line. */
  d: number;
  acc: number;
  spd?: number | null;
}

export interface StagingStatus {
  gpsOk: boolean;
  atLine: boolean;
  stationary: boolean;
  ready: boolean;
  /** Latest position along the route (negative = behind the line). */
  s: number | undefined;
  accuracyM: number | undefined;
}

/** Speed for each sample: device speed when present, otherwise derived from the previous sample. */
function speeds(samples: readonly StagingSample[]): number[] {
  return samples.map((x, i) => {
    if (x.spd != null) return x.spd;
    const prev = samples[i - 1];
    if (!prev || x.t <= prev.t) return 0;
    return dist(prev.xy, x.xy) / ((x.t - prev.t) / 1000);
  });
}

/** All checks in §4.4 step 2, evaluated over the most recent fixes. */
export function checkStaging(
  history: readonly StagingSample[],
  cfg: StagingConfig = DEFAULT_STAGING,
  maxRouteDistM = 20,
): StagingStatus {
  const last = history[history.length - 1];
  if (!last) {
    return {
      gpsOk: false,
      atLine: false,
      stationary: false,
      ready: false,
      s: undefined,
      accuracyM: undefined,
    };
  }
  const gpsOk = last.acc <= cfg.maxAccuracyM;
  const atLine = last.s >= -cfg.behindM && last.s <= cfg.aheadM && last.d <= maxRouteDistM;
  const win = history.slice(-cfg.windowFixes);
  let stationary = win.length >= cfg.windowFixes;
  if (stationary) {
    stationary = speeds(win).every((v) => v < cfg.maxSpeedMps);
    for (let i = 0; stationary && i < win.length; i++) {
      for (let j = i + 1; j < win.length; j++) {
        if (dist((win[i] as StagingSample).xy, (win[j] as StagingSample).xy) >= cfg.maxSpreadM) {
          stationary = false;
          break;
        }
      }
    }
  }
  return {
    gpsOk,
    atLine,
    stationary,
    ready: gpsOk && atLine && stationary,
    s: last.s,
    accuracyM: last.acc,
  };
}

/** Whole seconds still to show at time `now` (e.g. 5, 4, … 1, then 0 at zero). */
export function countdownRemaining(zeroAt: number, now: number): number {
  return Math.max(0, Math.ceil((zeroAt - now) / 1000 - 1e-9));
}

export interface JumpStartConfig {
  maxForwardM: number;
  maxSpeedMps: number;
  /** Consecutive fixes over a threshold (distance or speed) needed to call a jump start. */
  speedFixes: number;
  /** Device speed needed to back up the distance trigger (ignored when there is no speed). */
  corroborateSpeedMps: number;
}

export const DEFAULT_JUMP_START: JumpStartConfig = {
  maxForwardM: 3,
  maxSpeedMps: 2,
  speedFixes: 2,
  corroborateSpeedMps: 1,
};

/** Watches the fixes during the countdown for movement off the line (§4.4 step 6). */
export class JumpStartDetector {
  private fastCount = 0;
  private farCount = 0;
  private triggered = false;

  constructor(
    private readonly stagedS: number,
    private readonly cfg: JumpStartConfig = DEFAULT_JUMP_START,
  ) {}

  /** Returns true exactly once, on the fix that detects the jump start. */
  onFix(s: number, speedMps: number | null | undefined): boolean {
    if (this.triggered) return false;
    this.fastCount = speedMps != null && speedMps > this.cfg.maxSpeedMps ? this.fastCount + 1 : 0;
    // A single fix past the threshold is usually stationary GPS drift, so require a streak.
    // When the device reports speed, it must agree that the car is actually moving.
    const moving = speedMps == null || speedMps > this.cfg.corroborateSpeedMps;
    this.farCount = s - this.stagedS > this.cfg.maxForwardM && moving ? this.farCount + 1 : 0;
    if (this.farCount >= this.cfg.speedFixes || this.fastCount >= this.cfg.speedFixes) {
      this.triggered = true;
      return true;
    }
    return false;
  }

  get jumped(): boolean {
    return this.triggered;
  }

  /** Mark a jump start found another way (e.g. from the launch time). Returns true if new. */
  flag(): boolean {
    if (this.triggered) return false;
    this.triggered = true;
    return true;
  }
}

/**
 * Launch time relative to zero (§4.4 step 7); negative if the car moved before zero.
 *
 * With Doppler speed: the acceleration between the first two moving fixes is extrapolated back to
 * v = 0 (t − v / a), but never to before the last fix that showed the car still. Using two moving
 * fixes matters: pairing a stationary fix with a moving one snaps the estimate back to the
 * stationary fix, up to a second too early. This works from fixes taken after zero, which matters
 * at 1 Hz, where a car leaving 1 s early may not log a single fast fix before zero.
 * Without speed: the time the car passed `thresholdM` from its staged position (coarse).
 */
export class LaunchDetector {
  private prev: { t: number; s: number } | null = null;
  private lastStillT: number | undefined;
  private firstMoving: { t: number; v: number } | null = null;
  private result: number | undefined;

  constructor(
    private readonly stagedS: number,
    private readonly zeroAt: number,
    private readonly thresholdM = 1.5,
    private readonly stillMps = 0.5,
    private readonly movingMps = 1.5,
  ) {}

  onFix(t: number, s: number, v?: number | null): number | undefined {
    if (this.result !== undefined) return this.result;
    const prev = this.prev;
    this.prev = { t, s };
    if (v != null && Number.isFinite(v)) {
      if (v < this.stillMps) {
        this.lastStillT = t;
        this.firstMoving = null;
        return undefined;
      }
      const first = this.firstMoving;
      if (!first || v <= first.v || t <= first.t) {
        this.firstMoving = { t, v };
        return undefined;
      }
      if (v < this.movingMps) return undefined;
      const a = (v - first.v) / ((t - first.t) / 1000);
      const launch = Math.max(this.lastStillT ?? -Infinity, first.t - (first.v / a) * 1000);
      this.result = Math.round(launch - this.zeroAt);
      return this.result;
    }
    const target = this.stagedS + this.thresholdM;
    if (s < target) return undefined;
    const tCross =
      prev && s > prev.s ? prev.t + ((target - prev.s) / (s - prev.s)) * (t - prev.t) : t;
    this.result = Math.round(tCross - this.zeroAt);
    return this.result;
  }

  get launchMs(): number | undefined {
    return this.result;
  }
}

/** Median of receivedAt − fix.timestamp, collected while staged (§4.4 clock alignment). */
export class ClockOffsetTracker {
  private samples: number[] = [];
  constructor(private readonly maxSamples = 30) {}

  add(fixT: number, receivedAt: number | undefined): void {
    if (receivedAt === undefined) return;
    this.samples.push(receivedAt - fixT);
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  get medianMs(): number | undefined {
    return this.samples.length ? median(this.samples) : undefined;
  }
}
