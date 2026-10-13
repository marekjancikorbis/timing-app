// Property-based tests (§8): invariants over random routes, intervals, speeds and noise.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sectorsFromProfile } from '../src/engine/delta';
import { createProjection, type LonLat } from '../src/engine/geo';
import {
  computeCheckpoints,
  INTERVAL_MAX_M,
  INTERVAL_MIN_M,
  INTERVAL_STEP_M,
  prepareRoute,
  type RouteType,
  sectorLengths,
  withInterval,
} from '../src/engine/route';
import type { RunResult } from '../src/engine/tracker';
import { mulberry32, ovalCircuit, simulateDrive } from '../src/gps/simulator';
import { BASE_T, feed, makeTracker } from './harness';

const interval = fc
  .integer({ min: 0, max: (INTERVAL_MAX_M - INTERVAL_MIN_M) / INTERVAL_STEP_M })
  .map((k) => INTERVAL_MIN_M + k * INTERVAL_STEP_M);

/** A random smooth road: heading wanders by at most 3° per 10 m (radius ≥ ~190 m). */
function randomRoad(seed: number, lengthM: number): LonLat[] {
  const rnd = mulberry32(seed);
  const proj = createProjection(14 + rnd(), 48 + rnd() * 4);
  let heading = rnd() * 360;
  let turn = 0;
  let x = 0;
  let y = 0;
  const pts: LonLat[] = [proj.toLonLat({ x, y })];
  for (let d = 0; d < lengthM; d += 10) {
    turn = Math.max(-3, Math.min(3, turn + (rnd() - 0.5) * 1.5));
    heading += turn;
    x += 10 * Math.sin((heading * Math.PI) / 180);
    y += 10 * Math.cos((heading * Math.PI) / 180);
    pts.push(proj.toLonLat({ x, y }));
  }
  return pts;
}

describe('checkpoints', () => {
  it('are strictly increasing, end at L, and sum to L for any length and interval', () => {
    fc.assert(
      fc.property(fc.double({ min: 1, max: 100_000, noNaN: true }), interval, (L, I) => {
        const cps = computeCheckpoints(L, I);
        expect(cps.at(-1)).toBe(L);
        for (let i = 1; i < cps.length; i++) expect(cps[i]).toBeGreaterThan(cps[i - 1] as number);
        const lens = sectorLengths(cps);
        expect(lens.reduce((a, b) => a + b, 0)).toBeCloseTo(L, 6);
        for (const len of lens.slice(0, -1)) expect(len).toBeCloseTo(I, 6);
        if (lens.length > 1) expect(lens.at(-1) as number).toBeGreaterThanOrEqual(I / 2 - 1e-6);
      }),
      { numRuns: 500 },
    );
  });
});

interface DriveCase {
  seed: number;
  lengthM: number;
  intervalM: number;
  speed: number;
  noiseM: number;
  type: RouteType;
  laps: number;
}

const driveCase: fc.Arbitrary<DriveCase> = fc.record({
  seed: fc.integer({ min: 1, max: 1_000_000 }),
  lengthM: fc.integer({ min: 400, max: 4000 }),
  intervalM: interval,
  speed: fc.double({ min: 8, max: 50, noNaN: true }), // ~30–180 km/h
  noiseM: fc.double({ min: 0, max: 4, noNaN: true }),
  type: fc.constantFrom<RouteType>('stage', 'circuit'),
  laps: fc.integer({ min: 1, max: 3 }),
});

function drive(c: DriveCase, intervalM = c.intervalM) {
  const geometry =
    c.type === 'circuit'
      ? ovalCircuit(c.lengthM / 4, c.lengthM / 8)
      : randomRoad(c.seed, c.lengthM);
  const route = prepareRoute({ type: c.type, geometry, intervalM });
  // Circuit laps take at least 15 s: the lap guard (default minimum 10 s) is meant to reject
  // anything quicker as a false split, so faster laps are outside its contract.
  const base = c.type === 'circuit' ? Math.min(c.speed, route.lengthM / 15 / 1.25) : c.speed;
  const varying = (s: number) => base * (1 + 0.25 * Math.sin(s / 150));
  const sim = simulateDrive({
    route,
    start: { mode: 'flying' },
    laps: c.laps,
    speed: varying,
    noiseM: c.noiseM,
    seed: c.seed,
    startEpoch: BASE_T,
  });
  const d = makeTracker(route);
  d.tracker.arm('flying');
  feed(d, sim.fixes);
  return { route, d, runs: d.runs() };
}

describe('tracker invariants over random drives', () => {
  it('completes the right number of laps/runs, with monotonic checkpoints and sector sum = total', () => {
    fc.assert(
      fc.property(driveCase, (c) => {
        const { route, d, runs } = drive(c);
        const expected = c.type === 'circuit' ? c.laps : 1;
        // no missed and no double laps
        expect(runs.map((r) => r.lapNumber)).toEqual(
          Array.from({ length: expected }, (_, i) => i + 1),
        );
        expect(runs.every((r) => r.valid)).toBe(true);

        for (const run of runs) {
          expect(run.sectorMs).toHaveLength(route.checkpoints.length);
          // every sector is positive and they add up to the total (each rounded to the ms)
          for (const ms of run.sectorMs) expect(ms).toBeGreaterThan(0);
          const sum = run.sectorMs.reduce((a, b) => a + b, 0);
          expect(Math.abs(sum - run.totalMs)).toBeLessThanOrEqual(run.sectorMs.length / 2 + 1);

          // live checkpoint events: every index once, in order, cumulative times increasing
          const cps = d.of('checkpoint').filter((e) => e.lap === run.lapNumber);
          expect(cps.map((e) => e.index)).toEqual(route.checkpoints.map((_, i) => i));
          for (let i = 1; i < cps.length; i++) {
            expect(cps[i]?.cumMs).toBeGreaterThan(cps[i - 1]?.cumMs as number);
          }
          expect(cps.at(-1)?.cumMs).toBeCloseTo(run.totalMs, -1);

          // the stored profile never goes backwards
          for (let i = 1; i < run.profile.s.length; i++) {
            expect(run.profile.s[i]).toBeGreaterThanOrEqual(run.profile.s[i - 1] as number);
            expect(run.profile.t[i]).toBeGreaterThanOrEqual(run.profile.t[i - 1] as number);
          }
        }
      }),
      { numRuns: 60 },
    );
  });

  it('recomputing a run for a new interval matches a fresh run at that interval', () => {
    fc.assert(
      fc.property(driveCase, interval, (c, newInterval) => {
        const before = drive(c);
        const fresh = drive(c, newInterval);
        const recheck = withInterval(before.route, newInterval).checkpoints;
        expect(recheck).toEqual(fresh.route.checkpoints);
        before.runs.forEach((run: RunResult, i) => {
          const recomputed = sectorsFromProfile(run.profile, recheck).sectorMs.map(Math.round);
          const freshRun = fresh.runs[i] as RunResult;
          expect(freshRun.totalMs).toBe(run.totalMs);
          recomputed.forEach((ms, k) => {
            expect(Math.abs(ms - (freshRun.sectorMs[k] as number))).toBeLessThanOrEqual(1);
          });
        });
      }),
      { numRuns: 40 },
    );
  });
});
