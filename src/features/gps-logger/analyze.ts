// Phase 0 log analysis (§7): is this phone's GPS good enough? Pure functions over recorded fixes.

import type { Fix } from '../../engine/filters';
import { createProjection, dist, median, percentile, type Vec2 } from '../../engine/geo';

export interface StationaryStats {
  /** Stationary stretches of at least `minStationaryS`. */
  segments: number;
  durationS: number;
  /** Distance of fixes from the stretch's median position. */
  deviationP95M: number;
  deviationMaxM: number;
  /** How far the reported position moves over 5 s (≈ a countdown): the jump-start risk. */
  drift5sP95M: number;
  /**
   * Lag-1 correlation of the position error between consecutive fixes, 0 = white, → 1 = slowly
   * wandering. Decides whether smoothing can reach the 0.2 s target (see NOTES.md).
   */
  errorCorrelation: number;
}

export interface LogStats {
  fixes: number;
  durationS: number;
  rateHz: number;
  /** Share of fix intervals longer than 1.5 s. */
  slowIntervalShare: number;
  maxGapMs: number;
  accuracyMedianM: number;
  accuracyP95M: number;
  /** Share of moving fixes (> 2 m/s) that came with a device speed. */
  speedReportedShare: number;
  clockOffset: { medianMs: number; p5Ms: number; p95Ms: number } | undefined;
  stationary: StationaryStats | undefined;
  /** Device speed vs. speed from positions, while moving (m/s): a sanity check of Doppler. */
  speedBiasMps: number | undefined;
}

export interface ExitCheck {
  label: string;
  ok: boolean;
  detail: string;
}

const MIN_STATIONARY_S = 10;
const STILL_MPS = 0.5;
/** Position-derived speed carries ~0.3 m/s of noise when parked, so it gets a looser threshold. */
const STILL_DERIVED_MPS = 1;
const MAX_BLIP = 2;

/**
 * Speed per fix: device speed when reported, otherwise displacement across ±5 fixes. A wide window
 * matters: with 2 m of position noise, neighbouring fixes alone imply ~1 m/s for a parked car.
 */
function speeds(fixes: readonly Fix[], xy: readonly Vec2[]): number[] {
  return fixes.map((f, i) => {
    if (f.spd != null) return f.spd;
    const a = Math.max(0, i - 5);
    const b = Math.min(fixes.length - 1, i + 5);
    const dt = ((fixes[b] as Fix).t - (fixes[a] as Fix).t) / 1000;
    return dt > 0 ? dist(xy[a] as Vec2, xy[b] as Vec2) / dt : 0;
  });
}

function stationaryStats(fixes: readonly Fix[], xy: readonly Vec2[], v: readonly number[]) {
  // A still stretch survives up to MAX_BLIP moving-looking fixes in a row (noise spikes);
  // real motion produces a longer streak.
  const isStill = (i: number) =>
    (v[i] as number) < ((fixes[i] as Fix).spd != null ? STILL_MPS : STILL_DERIVED_MPS);
  const runs: [number, number][] = [];
  let start = -1;
  let lastStill = -1;
  for (let i = 0; i <= fixes.length; i++) {
    const still = i < fixes.length && isStill(i);
    if (still) {
      if (start < 0) start = i;
      lastStill = i;
      continue;
    }
    if (start >= 0 && (i === fixes.length || i - lastStill > MAX_BLIP)) {
      const dur = ((fixes[lastStill] as Fix).t - (fixes[start] as Fix).t) / 1000;
      if (dur >= MIN_STATIONARY_S) runs.push([start, lastStill]);
      start = -1;
    }
  }
  if (runs.length === 0) return undefined;

  const deviations: number[] = [];
  const drifts: number[] = [];
  let num = 0;
  let den = 0;
  let durationS = 0;
  for (const [a, b] of runs) {
    const pts = xy.slice(a, b + 1);
    const ts = fixes.slice(a, b + 1).map((f) => f.t);
    durationS += ((ts.at(-1) as number) - (ts[0] as number)) / 1000;
    const mx = median(pts.map((p) => p.x));
    const my = median(pts.map((p) => p.y));
    const dev = pts.map((p) => ({ x: p.x - mx, y: p.y - my }));
    for (const d of dev) deviations.push(Math.hypot(d.x, d.y));
    for (let i = 1; i < dev.length; i++) {
      if ((ts[i] as number) - (ts[i - 1] as number) > 1500) continue;
      const p = dev[i - 1] as Vec2;
      const q = dev[i] as Vec2;
      num += p.x * q.x + p.y * q.y;
    }
    for (const d of dev) den += d.x * d.x + d.y * d.y;
    // displacement between fixes ~5 s apart
    let j = 0;
    for (let i = 0; i < pts.length; i++) {
      while (j < pts.length && (ts[j] as number) - (ts[i] as number) < 5000) j++;
      if (j < pts.length && (ts[j] as number) - (ts[i] as number) <= 6000) {
        drifts.push(dist(pts[i] as Vec2, pts[j] as Vec2));
      }
    }
  }
  return {
    segments: runs.length,
    durationS,
    deviationP95M: percentile(deviations, 95),
    deviationMaxM: Math.max(...deviations),
    drift5sP95M: drifts.length ? percentile(drifts, 95) : Number.NaN,
    errorCorrelation: den > 0 ? num / den : Number.NaN,
  };
}

export function analyzeLog(input: readonly Fix[]): LogStats | undefined {
  const fixes = [...input]
    .sort((a, b) => a.t - b.t)
    .filter((f, i, arr) => i === 0 || f.t !== arr[i - 1]?.t);
  const first = fixes[0];
  const last = fixes.at(-1);
  if (!first || !last) return undefined;
  const proj = createProjection(first.lon, first.lat);
  const xy = fixes.map((f) => proj.toXY(f.lon, f.lat));
  const v = speeds(fixes, xy);

  const intervals: number[] = [];
  for (let i = 1; i < fixes.length; i++)
    intervals.push((fixes[i] as Fix).t - (fixes[i - 1] as Fix).t);
  const durationS = (last.t - first.t) / 1000;

  const offsets = fixes
    .filter((f) => f.receivedAt !== undefined)
    .map((f) => (f.receivedAt as number) - f.t);

  // Doppler vs. position-derived speed over 2 s, while moving
  const moving: number[] = [];
  const bias: number[] = [];
  for (let i = 1; i < fixes.length - 1; i++) {
    const a = fixes[i - 1] as Fix;
    const b = fixes[i + 1] as Fix;
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0 || dt > 3) continue;
    const derived = dist(xy[i - 1] as Vec2, xy[i + 1] as Vec2) / dt;
    if (derived < 2) continue;
    const f = fixes[i] as Fix;
    moving.push(f.spd != null ? 1 : 0);
    if (f.spd != null) bias.push(f.spd - derived);
  }

  return {
    fixes: fixes.length,
    durationS,
    rateHz: durationS > 0 ? (fixes.length - 1) / durationS : 0,
    slowIntervalShare: intervals.length
      ? intervals.filter((d) => d > 1500).length / intervals.length
      : 0,
    maxGapMs: intervals.length ? Math.max(...intervals) : 0,
    accuracyMedianM: median(fixes.map((f) => f.acc)),
    accuracyP95M: percentile(
      fixes.map((f) => f.acc),
      95,
    ),
    speedReportedShare: moving.length
      ? moving.reduce((a, b) => a + b, 0) / moving.length
      : Number.NaN,
    clockOffset: offsets.length
      ? { medianMs: median(offsets), p5Ms: percentile(offsets, 5), p95Ms: percentile(offsets, 95) }
      : undefined,
    stationary: stationaryStats(fixes, xy, v),
    speedBiasMps: bias.length ? median(bias) : undefined,
  };
}

/** NaN (e.g. a phone that repeats the same position when parked) reads as "n/a". */
function fmt(n: number, digits: number): string {
  return Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

/** The Phase 0 exit criteria (§7) for one log. */
export function exitChecks(s: LogStats): ExitCheck[] {
  const st = s.stationary;
  return [
    {
      label: 'Update rate ≥ 0.9 Hz',
      ok: s.rateHz >= 0.9,
      detail: `${s.rateHz.toFixed(2)} Hz, ${(s.slowIntervalShare * 100).toFixed(1)}% of gaps > 1.5 s, longest ${(s.maxGapMs / 1000).toFixed(1)} s`,
    },
    {
      label: 'Median accuracy ≤ 8 m',
      ok: s.accuracyMedianM <= 8,
      detail: `median ${s.accuracyMedianM.toFixed(1)} m, p95 ${s.accuracyP95M.toFixed(1)} m`,
    },
    {
      label: 'Stationary drift measured (≥ 60 s still)',
      ok: st !== undefined && st.durationS >= 60,
      detail: st
        ? `${st.durationS.toFixed(0)} s still; p95 ${st.deviationP95M.toFixed(1)} m from centre, ${fmt(st.drift5sP95M, 1)} m per 5 s, error correlation ${fmt(st.errorCorrelation, 2)}`
        : 'no stationary stretch of 10 s or more',
    },
    {
      label: 'Clock offset measured',
      ok: s.clockOffset !== undefined,
      detail: s.clockOffset
        ? `median ${s.clockOffset.medianMs.toFixed(0)} ms (p5 ${s.clockOffset.p5Ms.toFixed(0)}, p95 ${s.clockOffset.p95Ms.toFixed(0)})`
        : 'no receivedAt times in this log',
    },
  ];
}
