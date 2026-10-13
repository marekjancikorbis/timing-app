// Synthetic drives with known ground truth (§8). Pure and seeded, so tests are reproducible.

import type { Fix } from '../engine/filters';
import { createProjection } from '../engine/geo';
import { type PreparedRoute, pointAt } from '../engine/route';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

export type SimStart =
  | { mode: 'flying'; approachM?: number }
  | {
      mode: 'standing';
      /** Where the car waits, metres along the route (negative = behind the line). */
      stagedS?: number;
      /** Time spent stationary before launching (relative to the first fix). */
      launchAtMs: number;
      /** Launch before `launchAtMs` by this much to simulate a jump start. */
      accelMps2?: number;
    };

export interface SimOptions {
  route: PreparedRoute;
  start: SimStart;
  /** Laps to drive on a circuit (ignored for stages). */
  laps?: number;
  /** Target speed in m/s at distance s along the lap. */
  speed: number | ((s: number) => number);
  accelMps2?: number;
  brakeMps2?: number;
  hz?: number;
  /** Position noise: standard deviation per axis, metres. */
  noiseM?: number;
  /** 0 = white noise; close to 1 = slowly wandering error, like real GPS. */
  noiseCorrelation?: number;
  seed?: number;
  /** Epoch ms of the first fix. */
  startEpoch?: number;
  /** [from, to] ms ranges (relative to the first fix) with no fixes. */
  dropouts?: [number, number][];
  /** Delay between the fix timestamp and its delivery (receivedAt). */
  latencyMs?: number;
  /** Seconds of driving after the finish / last lap. */
  runOutS?: number;
}

export interface SimResult {
  fixes: Fix[];
  /** Ground truth: epoch ms when the car was at absolute distance sAbs (laps add L each). */
  timeAt(sAbs: number): number;
}

const DT = 10; // integration step, ms

export function simulateDrive(o: SimOptions): SimResult {
  const route = o.route;
  const L = route.lengthM;
  const rand = mulberry32(o.seed ?? 1);
  const hz = o.hz ?? 1;
  const noise = o.noiseM ?? 0;
  const rho = o.noiseCorrelation ?? 0;
  const accel = o.accelMps2 ?? 4;
  const brake = o.brakeMps2 ?? 6;
  const t0 = o.startEpoch ?? 1_700_000_000_000;
  const speedAt = typeof o.speed === 'number' ? () => o.speed as number : o.speed;
  const laps = route.type === 'circuit' ? (o.laps ?? 1) : 1;
  const runOut = (o.runOutS ?? 5) * 1000;

  let sAbs: number;
  let v: number;
  let waitUntil = 0;
  if (o.start.mode === 'flying') {
    const approach = o.start.approachM ?? 150;
    sAbs = route.type === 'stage' ? -Math.min(approach, 190) : -approach;
    v = speedAt(((sAbs % L) + L) % L);
  } else {
    sAbs = o.start.stagedS ?? -5;
    v = 0;
    waitUntil = o.start.launchAtMs;
  }
  const launchAccel = o.start.mode === 'standing' ? (o.start.accelMps2 ?? accel) : accel;
  const endS = laps * L;

  // Integrate the trajectory, recording (t, sAbs).
  const ts: number[] = [];
  const ss: number[] = [];
  let t = 0;
  let finishedAt = Number.POSITIVE_INFINITY;
  while (t <= finishedAt + runOut) {
    ts.push(t);
    ss.push(sAbs);
    if (t >= waitUntil) {
      const lapS = ((sAbs % L) + L) % L;
      const target = sAbs >= endS ? speedAt(lapS) * 0.5 : speedAt(lapS);
      const a = v < target ? (v < 1 ? launchAccel : accel) : -brake;
      v = Math.max(
        0,
        a > 0 ? Math.min(target, v + (a * DT) / 1000) : Math.max(target, v + (a * DT) / 1000),
      );
      sAbs += (v * DT) / 1000;
    }
    if (sAbs >= endS && finishedAt === Number.POSITIVE_INFINITY) finishedAt = t;
    t += DT;
    if (t > 3_600_000) throw new Error('simulation did not finish');
  }

  const timeAt = (target: number): number => {
    let lo = 0;
    let hi = ss.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((ss[mid] as number) < target) lo = mid + 1;
      else hi = mid;
    }
    const s1 = ss[lo] as number;
    const s0 = (ss[lo - 1] ?? s1) as number;
    const t1 = ts[lo] as number;
    const tPrev = (ts[lo - 1] ?? t1) as number;
    const f = s1 > s0 ? (target - s0) / (s1 - s0) : 0;
    return t0 + tPrev + f * (t1 - tPrev);
  };

  // Sample fixes.
  const fixes: Fix[] = [];
  const period = 1000 / hz;
  const phase = rand() * period;
  let ex = 0;
  let ey = 0;
  const innov = Math.sqrt(1 - rho * rho);
  for (let ft = phase; ft <= (ts[ts.length - 1] as number); ft += period) {
    ex = rho * ex + innov * noise * gaussian(rand);
    ey = rho * ey + innov * noise * gaussian(rand);
    if (o.dropouts?.some(([a, b]) => ft >= a && ft < b)) continue;
    const i = Math.min(ss.length - 1, Math.round(ft / DT));
    const s = ss[i] as number;
    const sNext = (ss[Math.min(ss.length - 1, i + 10)] ?? s) as number;
    const lapS = route.type === 'circuit' ? ((s % L) + L) % L : s;
    const p = pointAt(route, lapS);
    const [lon, lat] = route.proj.toLonLat({ x: p.x + ex, y: p.y + ey });
    const trueSpeed = (sNext - s) / 0.1;
    const epoch = Math.round(t0 + ft);
    fixes.push({
      t: epoch,
      lat,
      lon,
      acc: Math.max(3, noise * 1.6),
      spd: Math.max(0, trueSpeed + 0.2 * gaussian(rand)),
      hdg: null,
      receivedAt: epoch + (o.latencyMs ?? 0),
    });
  }
  return { fixes, timeAt };
}

/** Closed loop of the given length made of two straights and two semicircles, as [lon, lat]. */
export function ovalCircuit(
  straightM: number,
  radiusM: number,
  lon0 = 14.42,
  lat0 = 50.08,
): [number, number][] {
  const pts: { x: number; y: number }[] = [];
  const step = 5;
  for (let x = 0; x <= straightM; x += step) pts.push({ x, y: -radiusM });
  for (let a = -90; a <= 90; a += 3) {
    const r = (a * Math.PI) / 180;
    pts.push({ x: straightM + radiusM * Math.cos(r), y: radiusM * Math.sin(r) });
  }
  for (let x = straightM; x >= 0; x -= step) pts.push({ x, y: radiusM });
  for (let a = 90; a <= 270; a += 3) {
    const r = (a * Math.PI) / 180;
    pts.push({ x: radiusM * Math.cos(r), y: radiusM * Math.sin(r) });
  }
  const proj = createProjection(lon0, lat0);
  return pts.map((p) => proj.toLonLat(p));
}

/** A winding point-to-point road (sine wiggle with a hairpin), as [lon, lat]. */
export function windingStage(lengthM: number, lon0 = 14.5, lat0 = 49.9): [number, number][] {
  const pts: { x: number; y: number }[] = [];
  for (let x = 0; x <= lengthM * 0.8; x += 5) pts.push({ x, y: 60 * Math.sin(x / 120) });
  const proj = createProjection(lon0, lat0);
  return pts.map((p) => proj.toLonLat(p));
}
