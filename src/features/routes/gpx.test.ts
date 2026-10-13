// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { routeFromDraft } from '../../data/routeModel';
import { type GpxCandidate, parseGpx } from './gpx';
import { dedupe, endGapM, lineLengthM, looksClosed, simplifyLine } from './simplify';

const fixture = (name: string) => readFileSync(`tests/fixtures/gpx/${name}`, 'utf8');

function candidates(name: string): GpxCandidate[] {
  const r = parseGpx(fixture(name));
  if (!r.ok) throw new Error(r.error);
  return r.candidates;
}

describe('parseGpx: valid files', () => {
  it('imports a named track as a stage', () => {
    const [c, ...rest] = candidates('stage-track.gpx');
    expect(rest).toHaveLength(0);
    expect(c).toMatchObject({
      name: 'Forest stage',
      kind: 'track',
      suggestedType: 'stage',
      pointsIn: 76,
    });
    expect(c?.lengthM).toBeGreaterThan(1550); // 1.5 km plus the wiggle
    expect(c?.lengthM).toBeLessThan(1700);
    expect(c?.geometry.length).toBeLessThanOrEqual(76);
  });

  it('recognises a recorded lap as a circuit and simplifies collinear points', () => {
    const [c] = candidates('circuit-lap.gpx');
    expect(c?.suggestedType).toBe('circuit');
    // stadium: 2 × 200 m straights + 2 × π·60 m bends, recorded 8 m short of closing
    expect(c?.lengthM).toBeCloseTo(400 + 2 * Math.PI * 60 - 8, -1);
    // the straights were recorded every 5 m; they collapse to their end points
    expect((c?.geometry.length as number) < (c?.pointsIn as number) - 60).toBe(true);
    expect(endGapM(c?.geometry ?? [])).toBeLessThan(10);
  });

  it('imports a planned <rte> with a default name', () => {
    const [c] = candidates('planned-route.gpx');
    expect(c).toMatchObject({ name: 'Route 1', kind: 'route', suggestedType: 'stage' });
    expect(c?.geometry).toHaveLength(4);
    expect(c?.lengthM).toBeCloseTo(1100, -1);
  });

  it('joins track segments in order, ignores waypoints, and lists every track', () => {
    const cs = candidates('multi.gpx');
    expect(cs.map((c) => c.name)).toEqual(['Paused run', 'Track 2']);
    // 0–500 m, the 20 m pause, 520–1000 m (fixture coordinates are within 1% of nominal)
    expect(Math.abs((cs[0]?.lengthM as number) / 1000 - 1)).toBeLessThan(0.01);
    expect(cs[0]?.geometry).toHaveLength(2); // all on one straight line
    expect(Math.abs((cs[1]?.lengthM as number) / 500 - 1)).toBeLessThan(0.01);
  });

  it('handles GPX 1.0 with extensions, blank names and duplicate points', () => {
    const [c] = candidates('garmin-1-0.gpx');
    expect(c?.name).toBe('Track 1');
    expect(c?.geometry).toHaveLength(2);
    expect(c?.lengthM).toBeCloseTo(200, 0);
  });

  it('drops out-of-range and unreadable points but keeps the rest', () => {
    const [c] = candidates('bad-coords.gpx');
    expect(c?.name).toBe('Some junk');
    expect(c?.lengthM).toBeCloseTo(3 * 111.2, -1); // the three good points, 0.001° apart
    for (const [lon, lat] of c?.geometry ?? []) {
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(lon)).toBeLessThanOrEqual(180);
    }
  });

  it('produces geometry the route model accepts', () => {
    for (const file of ['stage-track.gpx', 'circuit-lap.gpx', 'planned-route.gpx', 'multi.gpx']) {
      for (const c of candidates(file)) {
        const route = routeFromDraft(
          { name: c.name, type: c.suggestedType, geometry: c.geometry, source: 'gpx' },
          'id',
          1,
        );
        expect(route.lengthM).toBeGreaterThan(100);
      }
    }
  });
});

describe('parseGpx: malformed files', () => {
  it.each([
    ['bad-empty.gpx', 'The file is empty.'],
    ['bad-truncated.gpx', 'This is not valid XML. The file may be damaged or cut off.'],
    ['bad-not-xml.gpx', 'This is not valid XML. The file may be damaged or cut off.'],
    ['bad-wrong-root.gpx', 'This is not a GPX file.'],
    [
      'bad-waypoints-only.gpx',
      'Nothing to import. It only has waypoints. Record or draw the route instead.',
    ],
    ['bad-single-point.gpx', 'Nothing to import. Its tracks have fewer than two usable points.'],
  ])('%s → %s', (file, error) => {
    expect(parseGpx(fixture(file))).toEqual({ ok: false, error });
  });

  it('reports a GPX with no content at all', () => {
    const r = parseGpx('<gpx xmlns="http://www.topografix.com/GPX/1/1"></gpx>');
    expect(r).toEqual({ ok: false, error: 'Nothing to import. It has no tracks or routes.' });
  });
});

describe('polyline helpers', () => {
  it('simplifyLine keeps corners and drops points within tolerance', () => {
    const line: [number, number][] = [
      [14, 50],
      [14.0005, 50.000001], // ~0.1 m off the line
      [14.001, 50],
      [14.001, 50.001], // a real corner
    ];
    expect(simplifyLine(line, 1)).toEqual([line[0], line[2], line[3]]);
    expect(simplifyLine(line.slice(0, 2), 1)).toHaveLength(2);
  });

  it('dedupe, lengths and closure', () => {
    expect(
      dedupe([
        [1, 2],
        [1, 2],
        [3, 4],
        [1, 2],
      ]),
    ).toEqual([
      [1, 2],
      [3, 4],
      [1, 2],
    ]);
    expect(lineLengthM([])).toBe(0);
    expect(endGapM([])).toBe(0);
    const square: [number, number][] = [
      [14, 50],
      [14.002, 50],
      [14.002, 50.001],
      [14, 50.001],
      [14, 50.00005],
    ];
    expect(looksClosed(square)).toBe(true);
    expect(looksClosed(square.slice(0, 3))).toBe(false);
  });
});
