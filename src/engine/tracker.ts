// Tracker state machine (§4.5): start detection, sector timing, laps, finish.
// Pure TS. Feed it fixes with onFix() and call tick() from a timer / rAF while counting down.

import type { Clock } from './clock';
import {
  ClockOffsetTracker,
  checkStaging,
  clampCountdown,
  countdownRemaining,
  DEFAULT_JUMP_START,
  DEFAULT_STAGING,
  type JumpStartConfig,
  JumpStartDetector,
  LaunchDetector,
  type StagingConfig,
  type StagingSample,
  type StagingStatus,
} from './countdown';
import { liveGapMs, type Profile, sectorsFromProfile, timeAtDistance } from './delta';
import {
  DEFAULT_FILTER,
  type FilterConfig,
  type Fix,
  FixFilter,
  type RejectReason,
} from './filters';
import {
  angleDiffDeg,
  bearingDeg,
  dist,
  median,
  offset,
  segmentIntersection,
  type Vec2,
} from './geo';
import {
  bearingAt,
  type PreparedGate,
  type PreparedRoute,
  projectGlobal,
  projectWindow,
} from './route';
import { AlongTrackSmoother, DEFAULT_SMOOTHER, type SmootherConfig } from './smoothing';
import type { StartMode } from './types';

export type TrackerState =
  | 'idle'
  | 'armed' // waiting for conditions (flying: valid fix near start; standing: staging checks)
  | 'ready' // flying: waiting to cross the start line
  | 'staged' // standing: all staging checks pass, START may be tapped
  | 'countdown'
  | 'running'
  | 'finished'
  | 'aborted';

export type SectorFlag = 'ok' | 'estimated';
export type InvalidReason = 'off-route' | 'gps-gap' | 'user-abort' | 'jump-start';

export interface TracePoint {
  t: number;
  lat: number;
  lon: number;
  acc: number;
  spd?: number;
  s?: number;
  /** Set when the fix failed validation; kept for diagnostics only. */
  rej?: RejectReason;
}

export interface RunResult {
  lapNumber: number;
  startMode: StartMode;
  countdownS?: number;
  jumpStart?: boolean;
  launchMs?: number;
  clockOffsetMs?: number;
  /** Epoch ms of time zero. */
  startTime: number;
  totalMs: number;
  intervalM: number;
  sectorMs: number[];
  sectorFlags: SectorFlag[];
  valid: boolean;
  invalidReason?: InvalidReason;
  profile: Profile;
  trace: TracePoint[];
}

export type TrackerEvent =
  | { type: 'state'; state: TrackerState }
  | { type: 'staging'; status: StagingStatus }
  | { type: 'countdownTick'; remaining: number; zeroAt: number }
  | { type: 'start'; t0: number; mode: StartMode; lap: number }
  | {
      type: 'checkpoint';
      lap: number;
      index: number;
      cumMs: number;
      sectorMs: number;
      estimated: boolean;
      gapMs?: number;
    }
  | {
      type: 'position';
      s: number;
      d: number;
      elapsedMs: number;
      speedMps: number;
      acc: number;
      gapMs?: number;
    }
  | { type: 'lap'; run: RunResult }
  | { type: 'finish'; run: RunResult }
  | { type: 'aborted'; run?: RunResult }
  | { type: 'jumpStart' }
  | { type: 'offRoute' }
  | { type: 'gpsGap'; gapMs: number }
  | { type: 'fixRejected'; reason: RejectReason };

export interface TrackerOptions {
  clock: Clock;
  filter?: FilterConfig;
  staging?: StagingConfig;
  jumpStart?: JumpStartConfig;
  /** Reference profiles per start mode, for live gaps. */
  references?: Partial<Record<StartMode, Profile>>;
  directionToleranceDeg?: number;
  /** Flying start: fixes after the crossing that must show forward progress. */
  confirmFixes?: number;
  confirmProgressM?: number;
  offRouteM?: number;
  offRouteFixes?: number;
  abortOnOffRoute?: boolean;
  /** Fix gaps longer than this mark crossed checkpoints as estimated. */
  estimateGapMs?: number;
  /** Fix gaps longer than this invalidate the run. */
  invalidGapMs?: number;
  minLapMs?: number;
  minLapFraction?: number;
  jumpStartInvalidates?: boolean;
  /** Convert fix timestamps to system time using the median staged offset (§4.4). */
  clockOffsetCorrection?: boolean;
  autoRearm?: boolean;
  /** Doppler-aided along-track smoothing of positions; null turns it off. */
  smoothing?: SmootherConfig | null;
  /** A launch estimated this many ms before zero (or more) is a jump start. */
  jumpLaunchToleranceMs?: number;
  /** Staged fixes whose median position is the jump-start reference. */
  stagedRefFixes?: number;
}

const DEFAULTS = {
  directionToleranceDeg: 60,
  confirmFixes: 2,
  confirmProgressM: 10,
  offRouteM: 50,
  offRouteFixes: 3,
  abortOnOffRoute: false,
  estimateGapMs: 2500,
  invalidGapMs: 15_000,
  minLapMs: 10_000,
  minLapFraction: 0.5,
  jumpStartInvalidates: false,
  clockOffsetCorrection: false,
  stagedRefFixes: 10,
  jumpLaunchToleranceMs: 300,
  autoRearm: false,
};

interface Lap {
  number: number;
  mode: StartMode;
  t0: number;
  profile: Profile;
  sPrev: number;
  tPrev: number;
  xyPrev: Vec2 | null;
  speed: number;
  nextCp: number;
  flags: SectorFlag[];
  invalid?: InvalidReason;
  offRouteCount: number;
  trace: TracePoint[];
  /** Flying start not yet confirmed: events are held back. */
  provisional: boolean;
  held: TrackerEvent[];
  fixCount: number;
  countdownS?: number;
  clockOffsetMs?: number;
}

type Listener = (e: TrackerEvent) => void;

export class Tracker {
  private readonly o: typeof DEFAULTS & TrackerOptions;
  private readonly filter: FixFilter;
  private listeners = new Set<Listener>();

  private _state: TrackerState = 'idle';
  private mode: StartMode = 'flying';
  private countdownS = 5;
  private lap: Lap | null = null;
  private lapsDone = 0;
  private prev: { t: number; xy: Vec2 } | null = null;
  /** Flying start: last position relative to the start line while waiting (undefined = off route). */
  private waitS: number | undefined;

  // along-track smoothing
  private smoother: AlongTrackSmoother | null;
  private smS: number | undefined; // last raw distance (lap-local)
  private smWrap = 0; // laps added to unwrap a circuit

  // standing start
  private stagingHistory: StagingSample[] = [];
  private stagingStatus: StagingStatus | null = null;
  private offsets = new ClockOffsetTracker();
  private zeroAt = 0;
  private lastRemaining = -1;
  private stagedS = 0;
  private jump: JumpStartDetector | null = null;
  private launch: LaunchDetector | null = null;

  constructor(
    readonly route: PreparedRoute,
    options: TrackerOptions,
  ) {
    this.o = { ...DEFAULTS, ...options };
    this.filter = new FixFilter(options.filter ?? DEFAULT_FILTER);
    const sm = options.smoothing === undefined ? DEFAULT_SMOOTHER : options.smoothing;
    this.smoother = sm ? new AlongTrackSmoother(sm) : null;
  }

  get state(): TrackerState {
    return this._state;
  }

  get startMode(): StartMode {
    return this.mode;
  }

  get countdownZeroAt(): number | undefined {
    return this._state === 'countdown' ? this.zeroAt : undefined;
  }

  get staging(): StagingStatus | null {
    return this.stagingStatus;
  }

  /** Time zero of the current lap/run, epoch ms. */
  get t0(): number | undefined {
    return this.lap && !this.lap.provisional ? this.lap.t0 : undefined;
  }

  /** Running clock for the display, from the injected clock. */
  elapsedMs(): number | undefined {
    const t0 = this.t0;
    return t0 === undefined ? undefined : this.o.clock.now() - t0;
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setReferences(refs: Partial<Record<StartMode, Profile>>): void {
    this.o.references = refs;
  }

  arm(mode: StartMode, countdownS = this.countdownS): void {
    this.mode = mode;
    this.countdownS = clampCountdown(countdownS);
    this.lap = null;
    this.lapsDone = 0;
    this.stagingHistory = [];
    this.stagingStatus = null;
    this.offsets = new ClockOffsetTracker();
    this.smoother?.reset();
    this.smS = undefined;
    this.smWrap = 0;
    this.waitS = undefined;
    this.jump = null;
    this.launch = null;
    this.setState('armed');
  }

  /** Tap START (standing mode). Returns false if the staging checks don't pass. */
  startCountdown(): boolean {
    if (this._state !== 'staged') return false;
    const now = this.o.clock.now();
    this.zeroAt = now + this.countdownS * 1000;
    this.lastRemaining = -1;
    this.stagedS = median(this.stagingHistory.slice(-this.o.stagedRefFixes).map((x) => x.s));
    this.jump = new JumpStartDetector(this.stagedS, this.o.jumpStart ?? DEFAULT_JUMP_START);
    this.launch = new LaunchDetector(this.stagedS, this.zeroAt);
    this.setState('countdown');
    this.tick(now);
    return true;
  }

  cancelCountdown(): void {
    if (this._state !== 'countdown') return;
    this.jump = null;
    this.launch = null;
    this.setState(this.stagingStatus?.ready ? 'staged' : 'armed');
  }

  /** User stop. A stage run in progress is aborted; on a circuit the unfinished lap is dropped. */
  stop(): void {
    const lap = this.lap;
    if (this._state === 'running' && lap && !lap.provisional) {
      if (this.route.type === 'stage') {
        lap.invalid ??= 'user-abort';
        const run = this.buildResult(lap, lap.tPrev - lap.t0, false);
        this.lap = null;
        this.emit({ type: 'aborted', run });
        this.setState('aborted');
      } else {
        this.lap = null;
        this.setState('finished');
      }
      return;
    }
    this.lap = null;
    this.setState('idle');
  }

  /** Drive the countdown. Call often (rAF or a 50 ms interval) while counting down. */
  tick(now = this.o.clock.now()): void {
    if (this._state !== 'countdown') return;
    const remaining = countdownRemaining(this.zeroAt, now);
    if (remaining !== this.lastRemaining) {
      this.lastRemaining = remaining;
      this.emit({ type: 'countdownTick', remaining, zeroAt: this.zeroAt });
    }
    if (now >= this.zeroAt) this.startStandingLap();
  }

  onFix(raw: Fix): void {
    const fix: Fix =
      raw.receivedAt === undefined ? { ...raw, receivedAt: this.o.clock.now() } : raw;
    if (this._state === 'countdown') this.tick();

    const reason = this.filter.check(fix);
    if (reason) {
      this.lap?.trace.push(toTrace(fix, undefined, reason));
      this.emit({ type: 'fixRejected', reason });
      return;
    }
    const t = this.fixTime(fix);
    const xy = this.smooth(t, this.route.proj.toXY(fix.lon, fix.lat), fix.spd);

    switch (this._state) {
      case 'armed':
      case 'ready':
        if (this.mode === 'flying') this.onFlyingWait(fix, t, xy);
        else this.onStaging(fix, t, xy);
        break;
      case 'staged':
        this.onStaging(fix, t, xy);
        break;
      case 'countdown':
        this.onCountdownFix(fix, t, xy);
        break;
      case 'running':
        if (this.lap) this.onRunningFix(this.lap, fix, t, xy);
        break;
      default:
        break;
    }
    this.prev = { t, xy };
  }

  // ───────────────────────── flying start ─────────────────────────

  private onFlyingWait(fix: Fix, t: number, xy: Vec2): void {
    const pending = this.lap;
    if (pending?.provisional) {
      this.onRunningFix(pending, fix, t, xy);
      if (this.lap !== pending) return; // discarded inside
      if (pending.fixCount > this.o.confirmFixes) {
        if (pending.sPrev >= this.o.confirmProgressM) this.confirmLap(pending);
        else this.discardProvisional();
      }
      return;
    }

    // Position relative to the start line (negative = before it), and where it was last fix.
    const near = this.stagingProjection(xy);
    const prevS = this.waitS;
    this.waitS = near.d <= this.o.offRouteM ? near.s : undefined;
    const prev = this.prev;
    if (prev && prevS !== undefined && this.waitS !== undefined && this.waitS > prevS) {
      // Direction is judged by progress along the route, not by the bearing of one fix-to-fix
      // segment: at low speed that bearing is mostly GPS noise (e.g. 8 m apart, 3.5 m error).
      let cross = this.crossing(this.route.startGate, prev, { t, xy }, false);
      // Fallback: through the line but outside the gate (or an outlier fix): use the distance.
      if (cross === null && prevS < 0 && this.waitS >= 0) {
        cross = prev.t + ((0 - prevS) / (this.waitS - prevS)) * (t - prev.t);
      }
      if (cross !== null) {
        this.waitS = undefined;
        const lap = this.newLap(cross, 'flying', true);
        this.onRunningFix(lap, fix, t, xy);
        return;
      }
    }
    const ready = near.d <= this.o.offRouteM && (this.route.type === 'circuit' || near.s < 0);
    this.setState(ready ? 'ready' : 'armed');
  }

  private confirmLap(lap: Lap): void {
    lap.provisional = false;
    const held = lap.held;
    lap.held = [];
    this.setState('running');
    this.emit({ type: 'start', t0: lap.t0, mode: lap.mode, lap: lap.number });
    for (const e of held) this.emit(e);
  }

  private discardProvisional(): void {
    this.lap = null;
    this.setState('ready');
  }

  // ───────────────────────── standing start ─────────────────────────

  /** Position along the route near the start line (negative = behind it). */
  private stagingProjection(xy: Vec2): { s: number; d: number } {
    if (this.route.type === 'stage') return projectWindow(this.route, xy, this.route.sMin, 100);
    const p = projectGlobal(this.route, xy);
    return p.s > this.route.lengthM / 2 ? { s: p.s - this.route.lengthM, d: p.d } : p;
  }

  private onStaging(fix: Fix, t: number, xy: Vec2): void {
    const { s, d } = this.stagingProjection(xy);
    this.stagingHistory.push({ t, xy, s, d, acc: fix.acc, spd: fix.spd });
    if (this.stagingHistory.length > 20) this.stagingHistory.shift();
    this.offsets.add(fix.t, fix.receivedAt);
    const status = checkStaging(this.stagingHistory, this.o.staging ?? DEFAULT_STAGING);
    this.stagingStatus = status;
    this.emit({ type: 'staging', status });
    this.setState(status.ready ? 'staged' : 'armed');
  }

  private onCountdownFix(fix: Fix, t: number, xy: Vec2): void {
    const { s } = this.stagingProjection(xy);
    if (this.jump?.onFix(s, fix.spd ?? this.derivedSpeed(t, xy))) this.emit({ type: 'jumpStart' });
    this.onLaunchFix(t, s, fix.spd);
  }

  private startStandingLap(): void {
    const lap = this.newLap(this.zeroAt, 'standing', false);
    lap.sPrev = this.stagedS;
    lap.profile = { s: [this.stagedS], t: [0] };
    lap.countdownS = this.countdownS;
    lap.clockOffsetMs = this.offsets.medianMs;
    this.setState('running');
    this.emit({ type: 'start', t0: lap.t0, mode: 'standing', lap: lap.number });
  }

  /** Launch timing; a launch clearly before zero is a jump start even if spotted after zero. */
  private onLaunchFix(t: number, s: number, speed: number | null | undefined): void {
    const launch = this.launch;
    if (!launch || launch.launchMs !== undefined) return;
    const ms = launch.onFix(t, s, speed);
    if (ms !== undefined && ms < -this.o.jumpLaunchToleranceMs && this.jump?.flag()) {
      this.emit({ type: 'jumpStart' });
    }
  }

  // ───────────────────────── running ─────────────────────────

  private newLap(t0: number, mode: StartMode, provisional: boolean): Lap {
    const lap: Lap = {
      number: this.lapsDone + 1,
      mode,
      t0,
      profile: { s: [0], t: [0] },
      sPrev: 0,
      tPrev: t0,
      xyPrev: null,
      speed: 0,
      nextCp: 0,
      flags: this.route.checkpoints.map(() => 'ok'),
      offRouteCount: 0,
      trace: [],
      provisional,
      held: [],
      fixCount: 0,
    };
    this.lap = lap;
    return lap;
  }

  private onRunningFix(lap: Lap, fix: Fix, t: number, xy: Vec2): void {
    const route = this.route;
    const L = route.lengthM;
    lap.fixCount++;
    const dt = t - lap.tPrev;
    if (lap.fixCount > 1 && dt > this.o.estimateGapMs) {
      this.emitLap(lap, { type: 'gpsGap', gapMs: dt });
      if (dt > this.o.invalidGapMs) lap.invalid ??= 'gps-gap';
    }
    const estimated = lap.fixCount > 1 && dt > this.o.estimateGapMs;

    // Finish / lap line.
    const segPrev = lap.xyPrev ?? this.prev?.xy;
    if (segPrev && !lap.provisional) {
      const gate = route.type === 'stage' ? route.finishGate : route.startGate;
      const tCross = this.crossing(gate, { t: lap.tPrev, xy: segPrev }, { t, xy });
      const lapOk =
        route.type === 'stage' ||
        (lap.sPrev > L * this.o.minLapFraction &&
          tCross !== null &&
          tCross - lap.t0 > this.o.minLapMs);
      if (tCross !== null && lapOk) {
        this.completeLap(lap, tCross, estimated);
        if (route.type === 'circuit' && this.lap) this.onRunningFix(this.lap, fix, t, xy);
        return;
      }
    }

    // Distance along the route, searched only near the last position.
    const v = fix.spd ?? lap.speed;
    const hi = lap.sPrev + Math.max((v * Math.max(dt, 1000) * 2) / 1000, 150);
    const lo = lap.sPrev - 30;
    const p = projectWindow(route, xy, lo, route.type === 'circuit' ? Math.min(hi, L) : hi);

    if (p.d > this.o.offRouteM) {
      lap.offRouteCount++;
      if (lap.offRouteCount === this.o.offRouteFixes && !lap.provisional) {
        lap.invalid ??= 'off-route';
        this.emit({ type: 'offRoute' });
        if (this.o.abortOnOffRoute) {
          const run = this.buildResult(lap, t - lap.t0, false);
          this.lap = null;
          this.emit({ type: 'aborted', run });
          this.setState('aborted');
          return;
        }
      }
    } else {
      lap.offRouteCount = 0;
    }

    // Stage fallback: past the finish without a gate crossing (e.g. wide of the gate).
    if (route.type === 'stage' && !lap.provisional && p.s >= L && lap.sPrev < L) {
      const tFin = lap.tPrev + ((L - lap.sPrev) / (p.s - lap.sPrev)) * dt;
      this.completeLap(lap, tFin, estimated);
      return;
    }

    // Circuit fallback: already into the next lap without a gate crossing (e.g. a fast chord
    // cutting a corner right at the line, or an outlier fix). Treat the lap as ended at s = L.
    if (route.type === 'circuit' && !lap.provisional && lap.sPrev > L * this.o.minLapFraction) {
      const q = projectWindow(route, xy, 0, 150);
      const sNext = q.s + L;
      if (q.d < p.d && sNext > lap.sPrev) {
        const tLap = lap.tPrev + ((L - lap.sPrev) / (sNext - lap.sPrev)) * dt;
        if (tLap - lap.t0 > this.o.minLapMs) {
          this.completeLap(lap, tLap, estimated);
          if (this.lap) this.onRunningFix(this.lap, fix, t, xy);
          return;
        }
      }
    }

    const s = Math.max(lap.sPrev, Math.min(p.s, L));
    const elapsed = t - lap.t0;

    // Intermediate checkpoints (the last one, at L, is the finish / lap line).
    const cps = route.checkpoints;
    while (lap.nextCp < cps.length - 1 && (cps[lap.nextCp] as number) <= s) {
      const idx = lap.nextCp;
      const D = cps[idx] as number;
      const tk =
        s > lap.sPrev ? lap.tPrev - lap.t0 + ((D - lap.sPrev) / (s - lap.sPrev)) * dt : elapsed;
      const prevCum = idx === 0 ? 0 : timeAtDistance(lap.profile, cps[idx - 1] as number);
      if (estimated) lap.flags[idx] = 'estimated';
      const ref = this.o.references?.[lap.mode];
      this.emitLap(lap, {
        type: 'checkpoint',
        lap: lap.number,
        index: idx,
        cumMs: tk,
        sectorMs: tk - prevCum,
        estimated,
        gapMs: ref ? tk - timeAtDistance(ref, D) : undefined,
      });
      lap.nextCp++;
      // keep the profile exact at the checkpoint so later reads match the event
      lap.profile.s.push(D);
      lap.profile.t.push(tk);
    }

    lap.profile.s.push(s);
    lap.profile.t.push(elapsed);
    if (dt > 0 && lap.xyPrev) lap.speed = fix.spd ?? dist(lap.xyPrev, xy) / (dt / 1000);
    else if (fix.spd != null) lap.speed = fix.spd;
    lap.sPrev = s;
    lap.tPrev = t;
    lap.xyPrev = xy;
    lap.trace.push(toTrace(fix, s));
    if (lap.mode === 'standing') this.onLaunchFix(t, s, fix.spd);

    const ref = this.o.references?.[lap.mode];
    this.emitLap(lap, {
      type: 'position',
      s,
      d: p.d,
      elapsedMs: elapsed,
      speedMps: lap.speed,
      acc: fix.acc,
      gapMs: ref ? liveGapMs(s, elapsed, ref) : undefined,
    });
  }

  private completeLap(lap: Lap, tEnd: number, estimated: boolean): void {
    const totalMs = tEnd - lap.t0;
    if (estimated) lap.flags[lap.flags.length - 1] = 'estimated';
    const run = this.buildResult(lap, totalMs, true);
    // Checkpoints crossed in the final segment, plus the finish / lap line itself.
    const ref = this.o.references?.[lap.mode];
    const exact = sectorsFromProfile(run.profile, this.route.checkpoints);
    exact.cumMs.forEach((cum, idx) => {
      if (idx < lap.nextCp) return;
      const D = this.route.checkpoints[idx] as number;
      this.emit({
        type: 'checkpoint',
        lap: lap.number,
        index: idx,
        cumMs: cum,
        sectorMs: exact.sectorMs[idx] as number,
        estimated: run.sectorFlags[idx] === 'estimated',
        gapMs: ref ? cum - timeAtDistance(ref, D) : undefined,
      });
    });
    this.lapsDone++;
    if (this.route.type === 'circuit') {
      this.emit({ type: 'lap', run });
      const next = this.newLap(tEnd, 'flying', false);
      this.emit({ type: 'start', t0: next.t0, mode: 'flying', lap: next.number });
    } else {
      this.lap = null;
      this.emit({ type: 'finish', run });
      this.setState('finished');
      if (this.o.autoRearm) this.arm(this.mode);
    }
  }

  private buildResult(lap: Lap, totalMs: number, finished: boolean): RunResult {
    const L = this.route.lengthM;
    const profile: Profile = { s: [], t: [] };
    lap.profile.s.forEach((s, i) => {
      if (!finished || s < L) {
        profile.s.push(s);
        profile.t.push(lap.profile.t[i] as number);
      }
    });
    if (finished) {
      profile.s.push(L);
      profile.t.push(totalMs);
    }
    const { sectorMs } = sectorsFromProfile(profile, this.route.checkpoints);
    const jumped = lap.mode === 'standing' && (this.jump?.jumped ?? false);
    let invalid = lap.invalid;
    if (jumped && this.o.jumpStartInvalidates) invalid ??= 'jump-start';
    const run: RunResult = {
      lapNumber: lap.number,
      startMode: lap.mode,
      startTime: lap.t0,
      totalMs: Math.round(totalMs),
      intervalM: this.route.intervalM,
      sectorMs: finished ? sectorMs.map(Math.round) : [],
      sectorFlags: finished ? [...lap.flags] : [],
      valid: finished && invalid === undefined,
      profile,
      trace: lap.trace,
    };
    if (invalid) run.invalidReason = invalid;
    if (lap.mode === 'standing') {
      run.countdownS = lap.countdownS;
      run.jumpStart = jumped;
      run.launchMs = this.launch?.launchMs;
      run.clockOffsetMs = lap.clockOffsetMs;
    }
    return run;
  }

  // ───────────────────────── smoothing ─────────────────────────

  /** Distance along the route near the last smoothed position, for the smoother only. */
  private smootherProject(xy: Vec2): { s: number; d: number } {
    const r = this.route;
    const prev = this.smS;
    if (prev === undefined)
      return r.type === 'circuit' ? projectGlobal(r, xy) : this.stagingProjection(xy);
    const p = projectWindow(r, xy, prev - 30, prev + 300);
    if (r.type !== 'circuit') return p;
    // Near the line on a circuit the window has to wrap around.
    if (prev > r.lengthM - 300) {
      const q = projectWindow(r, xy, 0, prev + 300 - r.lengthM);
      if (q.d < p.d) return { s: q.s + r.lengthM, d: q.d };
    } else if (prev < 30) {
      const q = projectWindow(r, xy, r.lengthM + prev - 30, r.lengthM);
      if (q.d < p.d) return { s: q.s - r.lengthM, d: q.d };
    }
    return p;
  }

  /** Move a raw position along the road to the smoothed distance (the lateral error is kept). */
  private smooth(t: number, xy: Vec2, speed: number | null | undefined): Vec2 {
    const sm = this.smoother;
    if (!sm) return xy;
    const p = this.smootherProject(xy);
    if (p.d > this.o.offRouteM || speed == null) {
      sm.reset();
      this.smS = p.d > this.o.offRouteM ? undefined : p.s;
      return xy;
    }
    const L = this.route.lengthM;
    // p.s may be just outside [0, L] on a circuit (wrapped); keep an unwrapped running distance.
    if (this.route.type === 'circuit' && this.smS !== undefined) {
      if (p.s >= L) this.smWrap++;
      else if (p.s < 0) this.smWrap--;
    }
    const local = this.route.type === 'circuit' ? ((p.s % L) + L) % L : p.s;
    this.smS = local;
    const sAbs = local + this.smWrap * L;
    const corrected = sm.update(t, sAbs, speed) - sAbs;
    return corrected === 0 ? xy : offset(xy, bearingAt(this.route, local), corrected);
  }

  // ───────────────────────── helpers ─────────────────────────

  /** Interpolated time at which a→b crosses the gate in the right direction, or null. */
  private crossing(
    gate: PreparedGate,
    a: { t: number; xy: Vec2 },
    b: { t: number; xy: Vec2 },
    checkBearing = true,
  ): number | null {
    const hit = segmentIntersection(a.xy, b.xy, gate.a, gate.b);
    if (!hit || dist(a.xy, b.xy) < 0.01) return null;
    if (
      checkBearing &&
      angleDiffDeg(bearingDeg(a.xy, b.xy), gate.bearingDeg) > this.o.directionToleranceDeg
    )
      return null;
    return a.t + hit.t * (b.t - a.t);
  }

  private derivedSpeed(t: number, xy: Vec2): number | undefined {
    if (!this.prev || t <= this.prev.t) return undefined;
    return dist(this.prev.xy, xy) / ((t - this.prev.t) / 1000);
  }

  private fixTime(fix: Fix): number {
    if (!this.o.clockOffsetCorrection) return fix.t;
    const off = this.lap?.clockOffsetMs ?? this.offsets.medianMs;
    return off === undefined ? fix.t : fix.t + off;
  }

  private emitLap(lap: Lap, e: TrackerEvent): void {
    if (lap.provisional) lap.held.push(e);
    else this.emit(e);
  }

  private emit(e: TrackerEvent): void {
    for (const l of this.listeners) l(e);
  }

  private setState(state: TrackerState): void {
    if (state === this._state) return;
    this._state = state;
    this.emit({ type: 'state', state });
  }
}

function toTrace(fix: Fix, s?: number, rej?: RejectReason): TracePoint {
  const p: TracePoint = { t: fix.t, lat: fix.lat, lon: fix.lon, acc: fix.acc };
  if (fix.spd != null) p.spd = fix.spd;
  if (s !== undefined) p.s = Math.round(s * 100) / 100;
  if (rej) p.rej = rej;
  return p;
}
