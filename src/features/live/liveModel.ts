// What the arm / countdown / live / finish screens show (§5), derived from tracker events.
// Pure reducer: the session controller feeds it events; the screens only render it.

import type { StagingStatus } from '../../engine/countdown';
import { GapSmoother, type SectorColor, sectorColor } from '../../engine/delta';
import type { RunResult, TrackerEvent, TrackerState } from '../../engine/tracker';
import type { StartMode } from '../../engine/types';

export interface SectorCell {
  ms?: number;
  color: SectorColor | 'pending';
  estimated?: boolean;
}

export interface LiveModel {
  state: TrackerState;
  mode: StartMode;
  lap: number;
  staging: StagingStatus | null;
  /** `total` is the countdown length (the first tick's `remaining`), e.g. for the lights. */
  countdown: { zeroAt: number; remaining: number; total: number } | null;
  /** Time zero of the current lap/run (epoch ms), for the running clock. */
  t0: number | null;
  /** Smoothed live gap to the reference at the same point (ms, + = slower). */
  gapMs: number | null;
  lastSector: { index: number; ms: number; deltaMs: number | null; color: SectorColor } | null;
  sectors: SectorCell[];
  speedMps: number | null;
  accuracyM: number | null;
  /** Distance along the route in the current lap (m). */
  distanceM: number | null;
  jumpStart: boolean;
  offRoute: boolean;
  /** Time of the last GPS gap warning (epoch ms of the event's arrival is not known; count instead). */
  gpsGaps: number;
  rejectedFixes: number;
  /** Most recent completed lap / run / aborted run. */
  lastResult: RunResult | null;
  /** Completed laps/runs since the screen opened. */
  results: RunResult[];
  /** Best sector times per start mode, including this session's valid laps. */
  bestSectors: Record<StartMode, number[]>;
}

export interface LiveContext {
  /** Sector times of the reference run per start mode (the run the gap is measured against). */
  refSectors: Partial<Record<StartMode, number[]>>;
  smoother: GapSmoother;
}

export function initialLive(
  sectorCount: number,
  bestSectors?: Partial<Record<StartMode, number[]>>,
): LiveModel {
  return {
    state: 'idle',
    mode: 'flying',
    lap: 0,
    staging: null,
    countdown: null,
    t0: null,
    gapMs: null,
    lastSector: null,
    sectors: Array.from({ length: sectorCount }, () => ({ color: 'pending' as const })),
    speedMps: null,
    accuracyM: null,
    distanceM: null,
    jumpStart: false,
    offRoute: false,
    gpsGaps: 0,
    rejectedFixes: 0,
    lastResult: null,
    results: [],
    bestSectors: {
      flying: [...(bestSectors?.flying ?? [])],
      standing: [...(bestSectors?.standing ?? [])],
    },
  };
}

function freshLap(m: LiveModel): Partial<LiveModel> {
  return {
    sectors: m.sectors.map(() => ({ color: 'pending' as const })),
    lastSector: null,
    gapMs: null,
    distanceM: null,
    offRoute: false,
  };
}

function mergeBests(best: number[], sectors: readonly number[]): number[] {
  return sectors.map((ms, i) => {
    const b = best[i];
    return b === undefined || ms < b ? ms : b;
  });
}

export function liveReduce(m: LiveModel, e: TrackerEvent, ctx: LiveContext): LiveModel {
  switch (e.type) {
    case 'state': {
      const next = { ...m, state: e.state };
      if (
        e.state === 'armed' &&
        (m.state === 'idle' || m.state === 'finished' || m.state === 'aborted')
      ) {
        ctx.smoother.reset();
        return {
          ...next,
          ...freshLap(m),
          t0: null,
          countdown: null,
          jumpStart: false,
          staging: null,
          lap: 0,
        };
      }
      if (e.state === 'staged' || (e.state === 'armed' && m.state === 'countdown')) {
        return { ...next, countdown: null }; // cancelled
      }
      return next;
    }
    case 'staging':
      return { ...m, staging: e.status, accuracyM: e.status.accuracyM ?? m.accuracyM };
    case 'countdownTick':
      return {
        ...m,
        countdown: {
          zeroAt: e.zeroAt,
          remaining: e.remaining,
          total: m.countdown?.zeroAt === e.zeroAt ? m.countdown.total : e.remaining,
        },
      };
    case 'start':
      ctx.smoother.reset();
      return { ...m, ...freshLap(m), lap: e.lap, mode: e.mode, t0: e.t0, countdown: null };
    case 'checkpoint': {
      // Stored runs keep whole milliseconds; compare like with like so a tie is a tie.
      const ms = Math.round(e.sectorMs);
      const ref = ctx.refSectors[m.mode]?.[e.index];
      const best = m.bestSectors[m.mode][e.index];
      const color = sectorColor(ms, ref, best);
      const sectors = m.sectors.map((c, i) =>
        i === e.index ? { ms, color, estimated: e.estimated } : c,
      );
      return {
        ...m,
        sectors,
        lastSector: { index: e.index, ms, deltaMs: ref === undefined ? null : ms - ref, color },
      };
    }
    case 'position':
      return {
        ...m,
        speedMps: e.speedMps,
        accuracyM: e.acc,
        distanceM: e.s,
        gapMs: e.gapMs === undefined ? m.gapMs : ctx.smoother.push(e.elapsedMs, e.gapMs),
      };
    case 'lap':
    case 'finish': {
      const run = e.run;
      const bestSectors = run.valid
        ? {
            ...m.bestSectors,
            [run.startMode]: mergeBests(m.bestSectors[run.startMode], run.sectorMs),
          }
        : m.bestSectors;
      return { ...m, lastResult: run, results: [...m.results, run], bestSectors };
    }
    case 'aborted':
      return e.run ? { ...m, lastResult: e.run, results: [...m.results, e.run] } : m;
    case 'jumpStart':
      return { ...m, jumpStart: true };
    case 'offRoute':
      return { ...m, offRoute: true };
    case 'gpsGap':
      return { ...m, gpsGaps: m.gpsGaps + 1 };
    case 'fixRejected':
      return { ...m, rejectedFixes: m.rejectedFixes + 1 };
  }
}

/** "+1.23" / "−0.46" with a real minus sign; null → "–". Rounds half up (0.345 → 0.35). */
export function formatGap(ms: number | null, digits = 2): string {
  if (ms === null || !Number.isFinite(ms)) return '–';
  const scale = 10 ** digits;
  const units = Math.round((Math.abs(ms) / 1000) * scale + 1e-9);
  const sign = units === 0 ? '±' : ms > 0 ? '+' : '−';
  return `${sign}${(units / scale).toFixed(digits)}`;
}

/** m:ss.cc, or h:mm:ss.cc past an hour. Rounds first, so 59.996 s is 1:00.00, never 0:60.00. */
export function formatTime(ms: number | null, digits = 2): string {
  if (ms === null || !Number.isFinite(ms)) return '–:––.––';
  const scale = 10 ** digits;
  const units = Math.round((Math.abs(ms) / 1000) * scale); // in 1/scale seconds
  const totalS = Math.floor(units / scale);
  const frac = units % scale;
  const h = Math.floor(totalS / 3600);
  const min = Math.floor((totalS % 3600) / 60);
  const sec =
    String(totalS % 60).padStart(2, '0') + (digits ? `.${String(frac).padStart(digits, '0')}` : '');
  const body = h > 0 ? `${h}:${String(min).padStart(2, '0')}:${sec}` : `${min}:${sec}`;
  return ms < 0 && units > 0 ? `−${body}` : body;
}
