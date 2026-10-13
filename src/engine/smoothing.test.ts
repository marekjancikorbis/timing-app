import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../gps/simulator';
import { AlongTrackSmoother, DEFAULT_SMOOTHER } from './smoothing';

describe('AlongTrackSmoother', () => {
  it('passes raw values through without a speed, and restarts', () => {
    const sm = new AlongTrackSmoother();
    expect(sm.update(0, 10, null)).toBe(10);
    expect(sm.update(1000, 50, undefined)).toBe(50);
    expect(sm.update(2000, 70, Number.NaN)).toBe(70);
  });

  it('is exact when positions and speeds agree, including under acceleration', () => {
    const sm = new AlongTrackSmoother();
    for (let k = 0; k <= 10; k++) {
      // s = 2k² (a = 4 m/s²), v = 4k
      expect(sm.update(k * 1000, 2 * k * k, 4 * k)).toBeCloseTo(2 * k * k, 9);
    }
  });

  it('reduces white along-track noise by more than half once warmed up', () => {
    const rnd = mulberry32(42);
    const sm = new AlongTrackSmoother();
    let rawSq = 0;
    let smSq = 0;
    let n = 0;
    for (let k = 0; k < 400; k++) {
      const truth = 25 * k;
      const noise = (rnd() + rnd() + rnd() - 1.5) * 4; // σ ≈ 2 m
      const out = sm.update(k * 1000, truth + noise, 25);
      if (k >= 20) {
        rawSq += noise ** 2;
        smSq += (out - truth) ** 2;
        n++;
      }
    }
    expect(Math.sqrt(smSq / n)).toBeLessThan(0.5 * Math.sqrt(rawSq / n));
  });

  it('averages plainly while warming up (1/n), not from the first sample alone', () => {
    const sm = new AlongTrackSmoother();
    sm.update(0, 4, 0); // first sample: +4 m error
    expect(sm.update(1000, -4, 0)).toBeCloseTo(0, 9); // mean of +4 and −4
  });

  it('treats speeds under the dead-band as standing still', () => {
    const sm = new AlongTrackSmoother();
    sm.update(0, 0, 0.4);
    // 0.4 m/s of noise for 9 s would integrate to 3.6 m; with the dead-band it stays at 0
    let out = 0;
    for (let k = 1; k < 10; k++) out = sm.update(k * 1000, 0, 0.4);
    expect(out).toBeCloseTo(0, 9);
  });

  it('restarts after a long gap or a non-increasing time', () => {
    const sm = new AlongTrackSmoother();
    sm.update(0, 0, 10);
    sm.update(1000, 10, 10);
    expect(sm.update(1000 + DEFAULT_SMOOTHER.maxGapMs + 1, 500, 10)).toBe(500);
    expect(sm.update(1000, 123, 10)).toBe(123);
  });

  it('never moves a position by more than the correction limit', () => {
    const sm = new AlongTrackSmoother();
    for (let k = 0; k < 10; k++) sm.update(k * 1000, 20 * k, 20);
    // an 80 m jump in position: the smoothed value may lag, but by at most 15 m
    expect(sm.update(10_000, 280, 20)).toBe(280 - DEFAULT_SMOOTHER.maxCorrectionM);
  });
});
