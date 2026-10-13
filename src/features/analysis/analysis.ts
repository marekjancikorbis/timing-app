// Run analysis (§3.2 should-have, Phase 4): delta and speed against distance, a sector-by-sector
// comparison with a reference run, and the trace coloured by where time was won or lost.
// Pure, so it is unit-tested; the charts and the map only draw what this returns.

import { type Profile, timeAtDistance } from '../../engine/delta';
import type { TracePoint } from '../../engine/tracker';

/** Distance samples every `stepM` metres from 0 to `lengthM` (the end is always included). */
export function distanceGrid(lengthM: number, stepM = 10): number[] {
  if (!(lengthM > 0)) return [];
  const out: number[] = [];
  for (let s = 0; s < lengthM; s += stepM) out.push(s);
  out.push(lengthM);
  return out;
}

/** End of a profile: how far the run got. */
export function profileEnd(p: Profile): number {
  return p.s.length ? (p.s[p.s.length - 1] as number) : 0;
}

/**
 * Gap to the reference along the route, in seconds (positive = slower). Only over the stretch both
 * runs covered, so an unfinished run doesn't show a fake gap.
 */
export function deltaSeries(run: Profile, ref: Profile, stepM = 10): { s: number[]; dS: number[] } {
  const s = distanceGrid(Math.min(profileEnd(run), profileEnd(ref)), stepM);
  return { s, dS: s.map((d) => (timeAtDistance(run, d) - timeAtDistance(ref, d)) / 1000) };
}

/** Trace points that were used for timing (rejected fixes and points before the start dropped). */
function usable(trace: readonly TracePoint[]): (TracePoint & { s: number })[] {
  return trace.filter((p): p is TracePoint & { s: number } => p.s !== undefined && !p.rej);
}

/**
 * Speed in km/h at each fix, against distance. Uses the device's Doppler speed when it reported
 * one, otherwise distance along the route over time.
 */
export function speedSeries(trace: readonly TracePoint[]): { s: number[]; kmh: number[] } {
  const pts = usable(trace);
  const s: number[] = [];
  const kmh: number[] = [];
  pts.forEach((p, i) => {
    let mps = p.spd;
    if (mps == null) {
      const q = pts[i - 1] ?? pts[i + 1];
      if (!q || q.t === p.t) return;
      mps = Math.abs(p.s - q.s) / (Math.abs(p.t - q.t) / 1000);
    }
    s.push(p.s);
    kmh.push(mps * 3.6);
  });
  return { s, kmh };
}

/** Sample a (distance, value) series at other distances; NaN outside its range (a gap in the chart). */
export function resampleSeries(
  xs: readonly number[],
  ys: readonly number[],
  at: readonly number[],
): number[] {
  return at.map((d) => {
    const n = xs.length;
    if (n === 0 || d < (xs[0] as number) || d > (xs[n - 1] as number)) return Number.NaN;
    let i = 1;
    while (i < n - 1 && (xs[i] as number) < d) i++;
    const x0 = xs[i - 1] as number;
    const x1 = xs[i] as number;
    const y0 = ys[i - 1] as number;
    const y1 = ys[i] as number;
    return x1 === x0 ? y1 : y0 + ((d - x0) / (x1 - x0)) * (y1 - y0);
  });
}

export interface SectorRow {
  index: number;
  fromM: number;
  toM: number;
  ms: number;
  refMs?: number;
  /** This sector's time minus the reference's (positive = lost time). */
  deltaMs?: number;
  /** Gap to the reference at the end of this sector. */
  cumDeltaMs?: number;
  estimated: boolean;
}

export function sectorRows(
  checkpoints: readonly number[],
  sectorMs: readonly number[],
  flags: readonly string[],
  refSectorMs?: readonly number[],
): SectorRow[] {
  let cum = 0;
  let cumRef = 0;
  return sectorMs.map((ms, i) => {
    const row: SectorRow = {
      index: i,
      fromM: i === 0 ? 0 : (checkpoints[i - 1] as number),
      toM: checkpoints[i] as number,
      ms,
      estimated: flags[i] === 'estimated',
    };
    cum += ms;
    const ref = refSectorMs?.[i];
    if (ref !== undefined) {
      cumRef += ref;
      row.refMs = ref;
      row.deltaMs = ms - ref;
      row.cumDeltaMs = cum - cumRef;
    }
    return row;
  });
}

/**
 * The run's trace as short line segments, each with `rate`: time won (negative) or lost (positive)
 * against the reference over that segment, in ms per 100 m. Without a reference, `rate` is 0 and
 * `kmh` carries the speed so the map can colour by speed instead.
 */
export function coloredTrace(
  trace: readonly TracePoint[],
  run: Profile,
  ref?: Profile,
): { type: 'FeatureCollection'; features: object[] } {
  const pts = usable(trace);
  const refEnd = ref ? profileEnd(ref) : 0;
  const features: object[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as TracePoint & { s: number };
    const b = pts[i] as TracePoint & { s: number };
    const ds = b.s - a.s;
    let rate = 0;
    if (ref && ds > 0.5 && b.s <= refEnd) {
      const dA = timeAtDistance(run, a.s) - timeAtDistance(ref, a.s);
      const dB = timeAtDistance(run, b.s) - timeAtDistance(ref, b.s);
      rate = ((dB - dA) / ds) * 100;
    }
    const dt = (b.t - a.t) / 1000;
    const kmh = b.spd != null ? b.spd * 3.6 : dt > 0 ? (ds / dt) * 3.6 : 0;
    features.push({
      type: 'Feature',
      properties: { rate: Math.round(rate), kmh: Math.round(kmh) },
      geometry: {
        type: 'LineString',
        coordinates: [
          [a.lon, a.lat],
          [b.lon, b.lat],
        ],
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

interface RefCandidate {
  id: string;
  startMode: string;
  valid: boolean;
  totalMs: number;
  jumpStart?: boolean;
}

/**
 * What a run is compared with when none is picked: the fastest other valid run with the same start
 * mode (§4.6). The best run itself is compared with the next best.
 */
export function defaultReference<T extends RefCandidate>(
  run: RefCandidate,
  runs: readonly T[],
): T | undefined {
  let best: T | undefined;
  for (const r of runs) {
    if (r.id === run.id || !r.valid || r.jumpStart || r.startMode !== run.startMode) continue;
    if (!best || r.totalMs < best.totalMs) best = r;
  }
  return best;
}
