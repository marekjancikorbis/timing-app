// Reference profiles, live gap, sector maths and theoretical best (§4.6).

import type { StartMode } from './types';

/**
 * Distance → elapsed-time profile of a run. `s` is non-decreasing; `t` is ms since the run start.
 * Every derived number (checkpoint times, gaps) is interpolated from this, so changing the sector
 * interval only needs a recompute, never a re-drive (§4.2).
 */
export interface Profile {
  s: number[];
  t: number[];
}

/** Elapsed time at distance d, linearly interpolated. Clamped to the ends of the profile. */
export function timeAtDistance(p: Profile, d: number): number {
  const n = p.s.length;
  if (n === 0) return Number.NaN;
  if (d <= (p.s[0] as number)) return p.t[0] as number;
  if (d >= (p.s[n - 1] as number)) return p.t[n - 1] as number;
  // first index with s >= d
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((p.s[mid] as number) < d) lo = mid + 1;
    else hi = mid;
  }
  const s1 = p.s[lo] as number;
  const s0 = p.s[lo - 1] as number;
  const t1 = p.t[lo] as number;
  const t0 = p.t[lo - 1] as number;
  return s1 === s0 ? t0 : t0 + ((d - s0) / (s1 - s0)) * (t1 - t0);
}

/** Cumulative time at each checkpoint, and the time for each sector. */
export function sectorsFromProfile(
  p: Profile,
  checkpoints: readonly number[],
): { cumMs: number[]; sectorMs: number[] } {
  const cumMs = checkpoints.map((d) => timeAtDistance(p, d));
  const sectorMs = cumMs.map((c, i) => c - (i === 0 ? 0 : (cumMs[i - 1] as number)));
  return { cumMs, sectorMs };
}

/** Live gap in ms: positive = slower than the reference at the same point on the route. */
export function liveGapMs(s: number, elapsedMs: number, ref: Profile): number {
  return elapsedMs - timeAtDistance(ref, s);
}

/** Moving average over a time window (~1 s by default) to calm the big live-gap number. */
export class GapSmoother {
  private samples: { t: number; v: number }[] = [];
  constructor(private windowMs = 1000) {}

  push(t: number, v: number): number {
    this.samples.push({ t, v });
    while (this.samples.length > 1 && (this.samples[0] as { t: number }).t < t - this.windowMs) {
      this.samples.shift();
    }
    return this.samples.reduce((a, x) => a + x.v, 0) / this.samples.length;
  }

  reset(): void {
    this.samples = [];
  }
}

export interface RunLike {
  startMode: StartMode;
  valid: boolean;
  totalMs: number;
  sectorMs: number[];
  jumpStart?: boolean;
}

function eligible<T extends RunLike>(
  runs: readonly T[],
  mode: StartMode,
  excludeJumpStarts: boolean,
) {
  return runs.filter((r) => r.valid && r.startMode === mode && !(excludeJumpStarts && r.jumpStart));
}

/** Best valid run with the same start mode (the default reference). */
export function bestRun<T extends RunLike>(
  runs: readonly T[],
  mode: StartMode,
  excludeJumpStarts = true,
): T | undefined {
  let best: T | undefined;
  for (const r of eligible(runs, mode, excludeJumpStarts)) {
    if (!best || r.totalMs < best.totalMs) best = r;
  }
  return best;
}

/** Best time per sector across valid runs of one start mode (all must share the same interval). */
export function bestSectors(
  runs: readonly RunLike[],
  mode: StartMode,
  excludeJumpStarts = true,
): number[] {
  const best: number[] = [];
  for (const r of eligible(runs, mode, excludeJumpStarts)) {
    r.sectorMs.forEach((ms, i) => {
      if (best[i] === undefined || ms < (best[i] as number)) best[i] = ms;
    });
  }
  return best;
}

/** Sum of best sectors, or undefined if there are no eligible runs. */
export function theoreticalBestMs(runs: readonly RunLike[], mode: StartMode): number | undefined {
  const best = bestSectors(runs, mode);
  return best.length ? best.reduce((a, b) => a + b, 0) : undefined;
}

export type SectorColor = 'purple' | 'green' | 'red' | 'neutral';

/** purple = best ever, green = faster than the reference, red = slower (§4.6). */
export function sectorColor(
  ms: number,
  refMs: number | undefined,
  bestMs: number | undefined,
): SectorColor {
  if (bestMs === undefined || ms <= bestMs) return 'purple';
  if (refMs === undefined) return 'neutral';
  return ms < refMs ? 'green' : 'red';
}
