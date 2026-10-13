import { describe, expect, it } from 'vitest';
import type { Profile } from '../../engine/delta';
import type { TracePoint } from '../../engine/tracker';
import {
  coloredTrace,
  defaultReference,
  deltaSeries,
  distanceGrid,
  resampleSeries,
  sectorRows,
  speedSeries,
} from './analysis';

// 1000 m: the reference drives at a steady 20 m/s; the run is 1 s slower over the second half.
const ref: Profile = { s: [0, 1000], t: [0, 50_000] };
const run: Profile = { s: [0, 500, 1000], t: [0, 25_000, 51_000] };

describe('distanceGrid', () => {
  it('samples every step and always includes the end', () => {
    expect(distanceGrid(25, 10)).toEqual([0, 10, 20, 25]);
    expect(distanceGrid(0)).toEqual([]);
  });
});

describe('deltaSeries', () => {
  it('is the time gap at each distance, in seconds', () => {
    const d = deltaSeries(run, ref, 250);
    expect(d.s).toEqual([0, 250, 500, 750, 1000]);
    expect(d.dS.map((x) => Math.round(x * 1000) / 1000)).toEqual([0, 0, 0, 0.5, 1]);
  });

  it('stops where the shorter run ends', () => {
    const partial: Profile = { s: [0, 400], t: [0, 20_000] };
    expect(deltaSeries(partial, ref, 100).s.at(-1)).toBe(400);
  });
});

const trace: TracePoint[] = [
  { t: 0, lat: 50, lon: 14, acc: 3, rej: 'accuracy' },
  { t: 1000, lat: 50, lon: 14.0001, acc: 3, s: 0, spd: 10 },
  { t: 2000, lat: 50, lon: 14.0002, acc: 3, s: 20 },
  { t: 3000, lat: 50, lon: 14.0003, acc: 3, s: 50, spd: 30 },
];

describe('speedSeries', () => {
  it('uses Doppler speed, else speed along the route, and skips unused fixes', () => {
    const v = speedSeries(trace);
    expect(v.s).toEqual([0, 20, 50]);
    expect(v.kmh).toEqual([36, 72, 108]);
  });
});

describe('resampleSeries', () => {
  it('interpolates and leaves gaps outside the range', () => {
    expect(resampleSeries([0, 10, 20], [0, 100, 0], [-1, 5, 10, 15, 21])).toEqual([
      Number.NaN,
      50,
      100,
      50,
      Number.NaN,
    ]);
  });
});

describe('sectorRows', () => {
  it('pairs each sector with the reference, with running gap', () => {
    const rows = sectorRows([500, 1000], [25_000, 26_000], ['ok', 'estimated'], [25_500, 24_500]);
    expect(rows).toEqual([
      {
        index: 0,
        fromM: 0,
        toM: 500,
        ms: 25_000,
        refMs: 25_500,
        deltaMs: -500,
        cumDeltaMs: -500,
        estimated: false,
      },
      {
        index: 1,
        fromM: 500,
        toM: 1000,
        ms: 26_000,
        refMs: 24_500,
        deltaMs: 1500,
        cumDeltaMs: 1000,
        estimated: true,
      },
    ]);
  });

  it('works without a reference', () => {
    expect(sectorRows([1000], [50_000], ['ok'])[0]?.deltaMs).toBeUndefined();
  });
});

describe('coloredTrace', () => {
  it('gives each segment the time won or lost per 100 m, and its speed', () => {
    const t: TracePoint[] = [
      { t: 0, lat: 50, lon: 14, acc: 3, s: 400 },
      { t: 5000, lat: 50, lon: 14.001, acc: 3, s: 500 },
      { t: 10_000, lat: 50, lon: 14.002, acc: 3, s: 600 },
    ];
    const fc = coloredTrace(t, run, ref);
    const props = fc.features.map((f) => (f as { properties: object }).properties);
    // first half: same pace as the reference; second half: 2 s lost per 1000 m = 200 ms / 100 m
    expect(props).toEqual([
      { rate: 0, kmh: 72 },
      { rate: 200, kmh: 72 },
    ]);
  });

  it('has rate 0 without a reference', () => {
    const fc = coloredTrace(trace, run);
    expect(fc.features).toHaveLength(2);
    expect(
      fc.features.every((f) => (f as { properties: { rate: number } }).properties.rate === 0),
    ).toBe(true);
  });
});

describe('defaultReference', () => {
  const r = (id: string, totalMs: number, o: object = {}) => ({
    id,
    totalMs,
    startMode: 'flying',
    valid: true,
    ...o,
  });

  it('is the fastest other valid run of the same start mode', () => {
    const runs = [
      r('a', 60_000),
      r('b', 59_000),
      r('c', 50_000, { valid: false }),
      r('d', 51_000, { startMode: 'standing' }),
      r('e', 52_000, { jumpStart: true }),
    ];
    expect(defaultReference(runs[0] as never, runs)?.id).toBe('b');
    expect(defaultReference(runs[1] as never, runs)?.id).toBe('a');
    expect(defaultReference(runs[3] as never, runs)).toBeUndefined();
  });
});
