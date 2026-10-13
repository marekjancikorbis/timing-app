import { describe, expect, it } from 'vitest';
import {
  angleDiffDeg,
  bearingDeg,
  createProjection,
  dist,
  haversineM,
  median,
  metresPerDegree,
  offset,
  percentile,
  projectOnSegment,
  segmentIntersection,
} from './geo';

describe('projection', () => {
  const proj = createProjection(14.42, 50.08);

  it('maps the origin to (0, 0) and round-trips', () => {
    expect(proj.toXY(14.42, 50.08)).toEqual({ x: 0, y: 0 });
    const [lon, lat] = proj.toLonLat({ x: 1234.5, y: -678.9 });
    const back = proj.toXY(lon, lat);
    expect(back.x).toBeCloseTo(1234.5, 6);
    expect(back.y).toBeCloseTo(-678.9, 6);
  });

  it('uses ellipsoidal scale at the origin latitude (1° at 50° N: 111 229 m lat, 71 696 m lon)', () => {
    const p = createProjection(0, 50);
    expect(p.toXY(0, 51).y / 111_229).toBeCloseTo(1, 4);
    expect(p.toXY(1, 50).x / 71_696).toBeCloseTo(1, 4);
    const eq = metresPerDegree(0);
    expect(eq.lat).toBeCloseTo(110_574, -1);
    expect(eq.lon).toBeCloseTo(111_319, -1);
  });

  it('agrees with spherical haversine within 0.3% over 5 km', () => {
    const [lon, lat] = proj.toLonLat({ x: 3000, y: 4000 });
    const h = haversineM(14.42, 50.08, lon, lat);
    expect(Math.abs(h - 5000) / 5000).toBeLessThan(0.003);
  });
});

describe('basic vector maths', () => {
  it('dist', () => expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5));

  it.each([
    [{ x: 0, y: 1 }, 0],
    [{ x: 1, y: 0 }, 90],
    [{ x: 0, y: -1 }, 180],
    [{ x: -1, y: 0 }, 270],
    [{ x: 1, y: 1 }, 45],
  ])('bearing to %o is %d°', (to, expected) => {
    expect(bearingDeg({ x: 0, y: 0 }, to)).toBeCloseTo(expected, 9);
  });

  it.each([
    [10, 350, 20],
    [350, 10, 20],
    [0, 180, 180],
    [90, 90, 0],
    [-30, 30, 60],
    [720, 10, 10],
  ])('angleDiff(%d, %d) = %d', (a, b, expected) => {
    expect(angleDiffDeg(a, b)).toBeCloseTo(expected, 9);
  });

  it('offset moves along a bearing', () => {
    const p = offset({ x: 10, y: 10 }, 90, 5);
    expect(p.x).toBeCloseTo(15, 9);
    expect(p.y).toBeCloseTo(10, 9);
  });
});

describe('segmentIntersection', () => {
  const o = { x: 0, y: 0 };
  it('finds the fraction along both segments', () => {
    const hit = segmentIntersection(
      { x: -10, y: 0 },
      { x: 30, y: 0 },
      { x: 0, y: -5 },
      { x: 0, y: 15 },
    );
    expect(hit?.t).toBeCloseTo(0.25, 12);
    expect(hit?.u).toBeCloseTo(0.25, 12);
  });
  it('returns null for parallel segments', () => {
    expect(segmentIntersection(o, { x: 10, y: 0 }, { x: 0, y: 1 }, { x: 10, y: 1 })).toBeNull();
  });
  it('returns null when the lines meet outside the segments', () => {
    expect(segmentIntersection(o, { x: 10, y: 0 }, { x: 20, y: -5 }, { x: 20, y: 5 })).toBeNull();
    expect(segmentIntersection(o, { x: 10, y: 0 }, { x: 5, y: 1 }, { x: 5, y: 5 })).toBeNull();
  });
});

describe('projectOnSegment', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 };
  it('projects inside the segment', () => {
    expect(projectOnSegment({ x: 4, y: 3 }, a, b)).toEqual({ t: 0.4, d2: 9 });
  });
  it('clamps before and after', () => {
    expect(projectOnSegment({ x: -5, y: 0 }, a, b)).toEqual({ t: 0, d2: 25 });
    expect(projectOnSegment({ x: 13, y: 4 }, a, b)).toEqual({ t: 1, d2: 25 });
  });
  it('handles a zero-length segment', () => {
    expect(projectOnSegment({ x: 3, y: 4 }, a, a)).toEqual({ t: 0, d2: 25 });
  });
});

describe('statistics', () => {
  it('median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
  it('percentile (nearest rank)', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile(v, 100)).toBe(100);
    expect(percentile(v, 0)).toBe(1);
    expect(percentile([], 50)).toBeNaN();
  });
});
