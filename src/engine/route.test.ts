import { describe, expect, it } from 'vitest';
import { ll, straightGeometry } from '../../tests/harness';
import { ovalCircuit } from '../gps/simulator';
import { angleDiffDeg, dist } from './geo';
import {
  bearingAt,
  clampInterval,
  computeCheckpoints,
  gateToLonLat,
  INTERVAL_MAX_M,
  INTERVAL_MIN_M,
  INTERVAL_STEP_M,
  LEAD_IN_M,
  LEAD_OUT_M,
  pointAt,
  prepareRoute,
  projectGlobal,
  projectWindow,
  resample,
  sectorLengths,
  withInterval,
} from './route';

describe('computeCheckpoints', () => {
  it.each([
    // [length, interval, expected sector lengths]
    [2330, 100, [...Array(22).fill(100), 130]], // remainder 30 < 50 → merged
    [2330, 500, [500, 500, 500, 500, 330]], // remainder 330 ≥ 250 → kept (see note in README)
    [1040, 100, [...Array(9).fill(100), 140]], // 40 < 50 → merged
    [1050, 100, [...Array(10).fill(100), 50]], // exactly I/2 → kept
    [1000, 100, Array(10).fill(100)], // exact multiple: no remainder sector
    [1000, 1000, [1000]], // I = L → single sector
    [800, 1000, [800]], // I > L → single sector
    [1400, 1000, [1400]], // remainder 400 < 500 → merged into a single sector
  ])('L=%d, I=%d', (L, I, expected) => {
    const cps = computeCheckpoints(L, I);
    expect(sectorLengths(cps).map((x) => Math.round(x * 1000) / 1000)).toEqual(expected);
    expect(cps.at(-1)).toBe(L);
  });

  it('returns nothing for an empty route', () => {
    expect(computeCheckpoints(0, 100)).toEqual([]);
  });

  const intervals: number[] = [];
  for (let i = INTERVAL_MIN_M; i <= INTERVAL_MAX_M; i += INTERVAL_STEP_M) intervals.push(i);

  describe.each([737, 2330, 5000, 12_345.6])('route of %d m', (L) => {
    it.each(intervals)(
      'interval %d m: all sectors are I except a last one in [I/2, 1.5 I)',
      (I) => {
        const lens = sectorLengths(computeCheckpoints(L, I));
        expect(lens.reduce((a, b) => a + b, 0)).toBeCloseTo(L, 6);
        if (I >= L) {
          expect(lens).toEqual([L]);
          return;
        }
        for (const len of lens.slice(0, -1)) expect(len).toBeCloseTo(I, 6);
        const last = lens.at(-1) as number;
        if (lens.length === 1) {
          expect(last).toBeLessThan(1.5 * I); // L < 1.5 I merged into one
        } else {
          expect(last).toBeGreaterThanOrEqual(I / 2 - 1e-6);
          expect(last).toBeLessThan(1.5 * I);
        }
      },
    );
  });
});

describe('clampInterval', () => {
  it.each([
    [10, 100],
    [100, 100],
    [260, 250],
    [275, 300],
    [1000, 1000],
    [5000, 1000],
  ])('%d → %d', (input, expected) => expect(clampInterval(input)).toBe(expected));
});

describe('resample', () => {
  it('spaces points evenly and keeps the last point', () => {
    const pts = resample([
      { x: 0, y: 0 },
      { x: 12, y: 0 },
      { x: 12, y: 11 },
    ]);
    for (let i = 1; i < pts.length - 1; i++) {
      // along the polyline the step is 5 m; across the corner the chord is shorter
      expect(dist(pts[i - 1]!, pts[i]!)).toBeLessThanOrEqual(5 + 1e-9);
    }
    expect(pts.at(-1)).toEqual({ x: 12, y: 11 });
    expect(pts).toContainEqual({ x: 5, y: 0 });
    expect(pts).toContainEqual({ x: 10, y: 0 });
    expect(pts[3]?.x).toBeCloseTo(12, 9); // 15 m along: 12 east + 3 north
    expect(pts[3]?.y).toBeCloseTo(3, 9);
  });

  it('copies degenerate input', () => {
    expect(resample([{ x: 1, y: 2 }])).toEqual([{ x: 1, y: 2 }]);
  });
});

describe('prepareRoute: stage', () => {
  const route = prepareRoute({ type: 'stage', geometry: straightGeometry(1000), intervalM: 250 });

  it('measures length and builds checkpoints', () => {
    expect(route.lengthM).toBeCloseTo(1000, 1);
    expect(route.checkpoints.map(Math.round)).toEqual([250, 500, 750, 1000]);
  });

  it('adds a lead-in and lead-out so s can go negative / past the finish', () => {
    expect(route.sMin).toBe(-LEAD_IN_M);
    expect(route.sMax).toBeCloseTo(route.lengthM + LEAD_OUT_M, 6);
    const behind = projectGlobal(route, { x: -50, y: 3 });
    expect(behind.s).toBeCloseTo(-50, 6);
    expect(behind.d).toBeCloseTo(3, 6);
  });

  it('places perpendicular gates of the configured width at start and finish', () => {
    const { startGate: g, finishGate: f } = route;
    expect(g.bearingDeg).toBeCloseTo(90, 3);
    expect(dist(g.a, g.b)).toBeCloseTo(40, 6);
    expect((g.a.x + g.b.x) / 2).toBeCloseTo(0, 6);
    expect(g.a.x).toBeCloseTo(g.b.x, 6); // line runs north–south, across an east-bound road
    expect(f.s).toBeCloseTo(route.lengthM, 6);
    expect((f.a.x + f.b.x) / 2).toBeCloseTo(route.lengthM, 3);
    const custom = prepareRoute({ type: 'stage', geometry: straightGeometry(500), gateWidthM: 60 });
    expect(dist(custom.startGate.a, custom.startGate.b)).toBeCloseTo(60, 6);
  });

  it('converts gates back to lon/lat for storage', () => {
    const g = gateToLonLat(route, route.startGate);
    expect(g.a[0]).toBeCloseTo(ll(0, 20)[0], 9); // a = left of travel = north
    expect(g.a[1]).toBeCloseTo(ll(0, 20)[1], 9);
    expect(g.bearingDeg).toBeCloseTo(90, 3);
  });

  it('withInterval only changes the checkpoints', () => {
    const r2 = withInterval(route, 100);
    expect(r2.checkpoints).toHaveLength(10);
    expect(r2.pts).toBe(route.pts);
    expect(withInterval(route, 37).intervalM).toBe(INTERVAL_MIN_M);
  });

  it('rejects bad geometry', () => {
    expect(() => prepareRoute({ type: 'stage', geometry: [ll(0)] })).toThrow(/two points/);
    expect(() => prepareRoute({ type: 'stage', geometry: [ll(0), ll(3)] })).toThrow(/too short/);
  });
});

describe('prepareRoute: circuit', () => {
  const geometry = ovalCircuit(400, 100);
  const route = prepareRoute({ type: 'circuit', geometry, intervalM: 200 });
  const expectedL = 2 * 400 + 2 * Math.PI * 100;

  it('measures one lap and has no lead-in', () => {
    expect(route.lengthM).toBeCloseTo(expectedL, -1); // polygonal arcs are a touch shorter
    expect(route.sMin).toBe(0);
    expect(route.finishGate.s).toBeCloseTo(route.lengthM, 6);
  });

  it('closes an open loop automatically', () => {
    const open = prepareRoute({ type: 'circuit', geometry: geometry.slice(0, -3) });
    expect(dist(open.pts[0]!, open.pts.at(-1)!)).toBeLessThan(1e-6);
  });

  it('wraps pointAt and bearingAt around the lap', () => {
    const a = pointAt(route, 10);
    const b = pointAt(route, route.lengthM + 10);
    expect(dist(a, b)).toBeLessThan(1e-6);
    expect(angleDiffDeg(bearingAt(route, 0), 90)).toBeLessThan(3); // heads east (chord spans the arc join)
  });
});

describe('projectWindow', () => {
  // Hairpin: 500 m east, then back west 20 m further north.
  const route = prepareRoute({
    type: 'stage',
    geometry: [ll(0, 0), ll(500, 0), ll(500, 20), ll(0, 20)],
  });

  it('stays on the right leg of a hairpin', () => {
    const p = { x: 250, y: 11 }; // slightly nearer the return leg
    expect(projectGlobal(route, p).s).toBeCloseTo(500 + 20 + 250, 0);
    expect(projectWindow(route, p, 0, 400).s).toBeCloseTo(250, 0);
    expect(projectWindow(route, p, 600, 900).s).toBeCloseTo(770, 0);
  });

  it('clamps to the window edges', () => {
    const r = projectWindow(route, { x: 450, y: 0 }, 0, 300);
    expect(r.s).toBeCloseTo(300, 6);
    expect(r.d).toBeCloseTo(150, 6);
  });
});
