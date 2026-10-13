import { describe, expect, it } from 'vitest';
import type { LonLat } from '../../engine/geo';
import { boundsOf, lineFeature, lineFromSnapshot, sameLine } from './drawGlue';

const line: LonLat[] = [
  [14.4, 50.0],
  [14.41, 50.01],
  [14.42, 50.0],
];
const ID = '6f1c1a8e-3b2d-4c5e-9f00-112233445566';

describe('draw glue', () => {
  it('wraps the route as a Terra Draw linestring feature with the given id (copying coordinates)', () => {
    const f = lineFeature(line, ID);
    expect(f).toEqual({
      id: ID,
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: line },
      properties: { mode: 'linestring' },
    });
    expect(f.geometry.coordinates[0]).not.toBe(line[0]);
  });

  it('reads the preferred line back, or else the most recently drawn one, with its id', () => {
    const other = {
      id: 'drawn-1',
      geometry: {
        type: 'LineString',
        coordinates: [
          [1, 1],
          [2, 2],
        ],
      },
    };
    const point = { id: 'p', geometry: { type: 'Point', coordinates: [3, 3] } };
    expect(lineFromSnapshot([lineFeature(line, ID), other, point], ID)).toEqual({
      id: ID,
      geometry: line,
    });
    // a freshly drawn line has Terra Draw's own id, which the caller then keeps
    expect(lineFromSnapshot([point, other])).toEqual({
      id: 'drawn-1',
      geometry: [
        [1, 1],
        [2, 2],
      ],
    });
    expect(lineFromSnapshot([point, other], 'gone')).toEqual({
      id: 'drawn-1',
      geometry: [
        [1, 1],
        [2, 2],
      ],
    });
  });

  it('drops elevation and junk coordinates, and needs two good points', () => {
    const messy = {
      id: ID,
      geometry: {
        type: 'LineString',
        coordinates: [[14, 50, 300], [Number.NaN, 50], 'x', [14.1, 50.1]],
      },
    };
    expect(lineFromSnapshot([messy])?.geometry).toEqual([
      [14, 50],
      [14.1, 50.1],
    ]);
    const short = { id: ID, geometry: { type: 'LineString', coordinates: [[14, 50]] } };
    expect(lineFromSnapshot([short])).toBeNull();
    expect(lineFromSnapshot([])).toBeNull();
  });

  it('compares lines to a tolerance', () => {
    expect(
      sameLine(
        line,
        line.map(([a, b]) => [a + 1e-9, b]),
      ),
    ).toBe(true);
    expect(
      sameLine(
        line,
        line.map(([a, b]) => [a + 1e-6, b]),
      ),
    ).toBe(false);
    expect(sameLine(line, line.slice(1))).toBe(false);
  });

  it('computes padded bounds', () => {
    expect(boundsOf(line, 0)).toEqual([14.4, 50.0, 14.42, 50.01]);
    expect(boundsOf([], 0)).toBeNull();
  });
});
