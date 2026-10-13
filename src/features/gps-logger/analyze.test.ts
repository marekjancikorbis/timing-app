import { describe, expect, it } from 'vitest';
import type { Fix } from '../../engine/filters';
import { prepareRoute } from '../../engine/route';
import { ovalCircuit, simulateDrive } from '../../gps/simulator';
import { analyzeLog, exitChecks } from './analyze';

const route = prepareRoute({ type: 'circuit', geometry: ovalCircuit(400, 100) });

/** 90 s parked, then two laps; fixes delivered 120 ms after their timestamp. */
function sessionLog(
  noiseM: number,
  rho: number,
  extra: Partial<Parameters<typeof simulateDrive>[0]> = {},
) {
  return simulateDrive({
    route,
    start: { mode: 'standing', stagedS: -5, launchAtMs: 90_000 },
    laps: 2,
    speed: 25,
    noiseM,
    noiseCorrelation: rho,
    latencyMs: 120,
    seed: 3,
    ...extra,
  }).fixes;
}

describe('analyzeLog', () => {
  it('returns undefined for an empty log', () => {
    expect(analyzeLog([])).toBeUndefined();
  });

  it('measures rate, accuracy, clock offset and Doppler availability', () => {
    const s = analyzeLog(sessionLog(3, 0.9));
    expect(s?.rateHz).toBeCloseTo(1, 2);
    expect(s?.slowIntervalShare).toBe(0);
    expect(s?.maxGapMs).toBe(1000);
    expect(s?.accuracyMedianM).toBeCloseTo(4.8, 6); // the simulator reports 1.6 σ
    expect(s?.clockOffset).toEqual({ medianMs: 120, p5Ms: 120, p95Ms: 120 });
    expect(s?.speedReportedShare).toBe(1);
    expect(Math.abs(s?.speedBiasMps ?? 99)).toBeLessThan(0.3);
  });

  it('finds the stationary stretch and estimates how much the error wanders', () => {
    const wandering = analyzeLog(sessionLog(3, 0.9))?.stationary;
    expect(wandering?.segments).toBe(1);
    expect(wandering?.durationS).toBeGreaterThan(80);
    expect(wandering?.errorCorrelation).toBeGreaterThan(0.75);
    expect(wandering?.deviationP95M).toBeGreaterThan(2);

    const white = analyzeLog(sessionLog(3, 0))?.stationary;
    expect(Math.abs(white?.errorCorrelation ?? 99)).toBeLessThan(0.25);
    // independent fixes move about σ·√2·√2 ≈ 6 m (p95 of the radial) between any two of them
    expect(white?.drift5sP95M).toBeGreaterThan(wandering?.drift5sP95M ?? 0);
  });

  it('reports gaps', () => {
    const s = analyzeLog(sessionLog(2, 0.9, { dropouts: [[100_000, 104_500]] }));
    expect(s?.maxGapMs).toBe(5000);
    expect(s?.slowIntervalShare).toBeGreaterThan(0);
  });

  it('copes without device speed or receive times', () => {
    const bare: Fix[] = sessionLog(2, 0.9).map(({ t, lat, lon, acc }) => ({ t, lat, lon, acc }));
    const s = analyzeLog(bare);
    expect(s?.speedReportedShare).toBe(0);
    expect(s?.speedBiasMps).toBeUndefined();
    expect(s?.clockOffset).toBeUndefined();
    expect(s?.stationary?.segments).toBe(1); // found from position-derived speed
  });

  it('splits two parked stretches separated by a short real move', () => {
    // 20 s parked, 5 s at 6 m/s (30 m), 20 s parked: no device speed
    const fixes: Fix[] = [];
    for (let k = 0; k <= 45; k++) {
      const x = k <= 20 ? 0 : k <= 25 ? 6 * (k - 20) : 30;
      fixes.push({ t: k * 1000, lat: 50, lon: 14 + x / 71_700, acc: 4 });
    }
    const st = analyzeLog(fixes)?.stationary;
    expect(st?.segments).toBe(2);
    expect(st?.deviationMaxM).toBeLessThan(1);
  });

  it('sorts and de-duplicates out-of-order fixes', () => {
    const log = sessionLog(2, 0.9).slice(0, 20);
    const shuffled = [...log].reverse();
    shuffled.push({ ...(log[5] as Fix) });
    expect(analyzeLog(shuffled)?.fixes).toBe(20);
  });
});

describe('edge cases', () => {
  it('a single fix has no rate, gaps or stationary stretch', () => {
    const s = analyzeLog([{ t: 0, lat: 50, lon: 14, acc: 5 }]);
    expect(s).toMatchObject({
      fixes: 1,
      durationS: 0,
      rateHz: 0,
      slowIntervalShare: 0,
      maxGapMs: 0,
    });
    expect(s?.stationary).toBeUndefined();
  });

  it('a phone that repeats the same position when parked: correlation is n/a, not NaN', () => {
    const frozen: Fix[] = Array.from({ length: 70 }, (_, k) => ({
      t: k * 1000,
      lat: 50,
      lon: 14,
      acc: 5,
      spd: 0,
    }));
    const s = analyzeLog(frozen) as NonNullable<ReturnType<typeof analyzeLog>>;
    expect(s.stationary).toMatchObject({ segments: 1, deviationP95M: 0, drift5sP95M: 0 });
    expect(s.stationary?.errorCorrelation).toBeNaN();
    expect(exitChecks(s)[2]?.detail).toBe(
      '69 s still; p95 0.0 m from centre, 0.0 m per 5 s, error correlation n/a',
    );
  });

  it('skips fix pairs across a gap when measuring correlation', () => {
    // 12 s parked, error alternating ±1 m (anti-correlated), fix 6 missing: a 2 s hole between
    // fixes 5 and 7, which have the same sign. 10 counted pairs of −1 over 12 squares = −10/12;
    // counting the pair across the hole (+1) would give −9/12.
    const fixes: Fix[] = [];
    for (let k = 0; k <= 12; k++) {
      if (k === 6) continue;
      fixes.push({ t: k * 1000, lat: 50 + (k % 2 ? 1 : -1) / 111_229, lon: 14, acc: 5, spd: 0 });
    }
    const st = analyzeLog(fixes)?.stationary;
    expect(st?.segments).toBe(1);
    expect(st?.errorCorrelation).toBeCloseTo(-10 / 12, 3);
  });
});

describe('exitChecks (Phase 0 criteria)', () => {
  it('passes a good log', () => {
    const checks = exitChecks(
      analyzeLog(sessionLog(3, 0.9)) as NonNullable<ReturnType<typeof analyzeLog>>,
    );
    expect(checks.map((c) => c.ok)).toEqual([true, true, true, true]);
    expect(checks[2]?.detail).toMatch(/error correlation 0\.\d\d/);
  });

  it('fails slow, inaccurate logs without a stationary stretch or receive times', () => {
    const fixes: Fix[] = [];
    for (let k = 0; k < 40; k++) fixes.push({ t: k * 2000, lat: 50 + k * 0.001, lon: 14, acc: 15 });
    const checks = exitChecks(analyzeLog(fixes) as NonNullable<ReturnType<typeof analyzeLog>>);
    expect(checks.map((c) => c.ok)).toEqual([false, false, false, false]);
    expect(checks[2]?.detail).toMatch(/no stationary stretch/);
  });
});
