import { describe, expect, it } from 'vitest';
import {
  bestRun,
  bestSectors,
  GapSmoother,
  liveGapMs,
  type Profile,
  type RunLike,
  sectorColor,
  sectorsFromProfile,
  theoreticalBestMs,
  timeAtDistance,
} from './delta';

// 10 m/s for the first 100 m, then 20 m/s.
const ref: Profile = { s: [0, 50, 100, 200, 300], t: [0, 5000, 10_000, 15_000, 20_000] };

describe('timeAtDistance', () => {
  it.each([
    [0, 0],
    [25, 2500],
    [100, 10_000],
    [150, 12_500],
    [300, 20_000],
  ])('at %d m → %d ms', (d, ms) => expect(timeAtDistance(ref, d)).toBeCloseTo(ms, 9));

  it('clamps outside the profile', () => {
    expect(timeAtDistance(ref, -10)).toBe(0);
    expect(timeAtDistance(ref, 400)).toBe(20_000);
    expect(timeAtDistance({ s: [], t: [] }, 5)).toBeNaN();
  });

  it('handles a stationary stretch (repeated s) without dividing by zero', () => {
    const p: Profile = { s: [0, 10, 10, 20], t: [0, 1000, 3000, 4000] };
    expect(timeAtDistance(p, 10)).toBe(1000); // first arrival
    expect(timeAtDistance(p, 15)).toBe(3500);
  });
});

describe('sectorsFromProfile', () => {
  it('derives cumulative and per-sector times', () => {
    const { cumMs, sectorMs } = sectorsFromProfile(ref, [100, 200, 300]);
    expect(cumMs).toEqual([10_000, 15_000, 20_000]);
    expect(sectorMs).toEqual([10_000, 5000, 5000]);
  });
});

describe('liveGapMs', () => {
  it('is positive when slower than the reference at the same distance', () => {
    expect(liveGapMs(150, 13_000, ref)).toBeCloseTo(500, 9);
    expect(liveGapMs(150, 12_000, ref)).toBeCloseTo(-500, 9);
  });
});

describe('GapSmoother', () => {
  it('averages over the time window and drops old samples', () => {
    const sm = new GapSmoother(1000);
    expect(sm.push(0, 100)).toBe(100);
    expect(sm.push(500, 200)).toBe(150);
    expect(sm.push(1000, 300)).toBe(200);
    expect(sm.push(1600, 400)).toBe(350); // samples at 0 and 500 have aged out
    sm.reset();
    expect(sm.push(2000, -50)).toBe(-50);
  });
});

const runs: (RunLike & { id: string })[] = [
  {
    id: 'a',
    startMode: 'flying',
    valid: true,
    totalMs: 30_000,
    sectorMs: [10_000, 10_000, 10_000],
  },
  { id: 'b', startMode: 'flying', valid: true, totalMs: 29_500, sectorMs: [10_500, 9500, 9500] },
  { id: 'c', startMode: 'flying', valid: false, totalMs: 20_000, sectorMs: [5000, 5000, 10_000] },
  {
    id: 'd',
    startMode: 'standing',
    valid: true,
    totalMs: 32_000,
    sectorMs: [12_000, 10_000, 10_000],
  },
  {
    id: 'e',
    startMode: 'standing',
    valid: true,
    jumpStart: true,
    totalMs: 31_000,
    sectorMs: [11_000, 10_000, 10_000],
  },
];

describe('bests, grouped by start mode', () => {
  it('bestRun ignores invalid runs and other start modes', () => {
    expect(bestRun(runs, 'flying')?.id).toBe('b');
    expect(bestRun(runs, 'standing')?.id).toBe('d');
    expect(bestRun(runs, 'standing', false)?.id).toBe('e');
    expect(bestRun([], 'flying')).toBeUndefined();
  });

  it('bestSectors / theoretical best combine sectors from different runs', () => {
    expect(bestSectors(runs, 'flying')).toEqual([10_000, 9500, 9500]);
    expect(theoreticalBestMs(runs, 'flying')).toBe(29_000);
    expect(theoreticalBestMs(runs, 'standing')).toBe(32_000); // jump start excluded
    expect(theoreticalBestMs([runs[2] as RunLike], 'flying')).toBeUndefined();
  });
});

describe('sectorColor', () => {
  it.each([
    [9000, 9500, 9200, 'purple'], // beats the best ever
    [9200, 9500, 9200, 'purple'], // ties the best ever
    [9300, 9500, 9200, 'green'],
    [9600, 9500, 9200, 'red'],
    [9600, undefined, 9200, 'neutral'],
    [9600, undefined, undefined, 'purple'], // the first time ever is the best
  ] as const)('%d vs ref %s / best %s → %s', (ms, refMs, bestMs, expected) => {
    expect(sectorColor(ms, refMs, bestMs)).toBe(expected);
  });
});
