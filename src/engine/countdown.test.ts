import { describe, expect, it } from 'vitest';
import {
  ClockOffsetTracker,
  checkStaging,
  clampCountdown,
  countdownRemaining,
  JumpStartDetector,
  LaunchDetector,
  type StagingSample,
} from './countdown';

const sample = (t: number, s: number, o: Partial<StagingSample> = {}): StagingSample => ({
  t,
  xy: { x: s, y: 0 },
  s,
  d: 1,
  acc: 5,
  spd: 0,
  ...o,
});
const still = (s = -5) => [sample(0, s), sample(1000, s + 0.5), sample(2000, s + 0.2)];

describe('clampCountdown', () => {
  it.each([
    [1, 3],
    [3, 3],
    [5.4, 5],
    [10, 10],
    [15, 10],
  ])('%d → %d', (input, expected) => expect(clampCountdown(input)).toBe(expected));
});

describe('countdownRemaining', () => {
  const zero = 10_000;
  it.each([
    [5000, 5], // a 5 s countdown has just started
    [5001, 5],
    [5999, 5],
    [6000, 4],
    [9999, 1],
    [10_000, 0],
    [12_000, 0],
  ])('at %d ms → %d', (now, expected) => expect(countdownRemaining(zero, now)).toBe(expected));
});

describe('checkStaging', () => {
  it('is not ready without fixes', () => {
    expect(checkStaging([]).ready).toBe(false);
  });

  it('is ready when accurate, at the line and stationary', () => {
    const st = checkStaging(still());
    expect(st).toMatchObject({ gpsOk: true, atLine: true, stationary: true, ready: true, s: -4.8 });
  });

  it.each([
    ['poor accuracy', [...still().slice(0, 2), sample(2000, -5, { acc: 12 })], 'gpsOk'],
    ['too far behind the line', still(-25), 'atLine'],
    ['past the line', still(2.5), 'atLine'],
    ['too far from the route', [...still().slice(0, 2), sample(2000, -5, { d: 30 })], 'atLine'],
    [
      'moving (device speed)',
      [...still().slice(0, 2), sample(2000, -5, { spd: 1.2 })],
      'stationary',
    ],
    ['positions spread ≥ 3 m', [sample(0, -8), sample(1000, -6.5), sample(2000, -5)], 'stationary'],
    ['too few fixes', still().slice(1), 'stationary'],
  ] as const)('blocks on %s', (_, history, failing) => {
    const st = checkStaging(history);
    expect(st[failing]).toBe(false);
    expect(st.ready).toBe(false);
  });

  it('derives speed from positions when the device gives none', () => {
    const noSpd = (t: number, s: number) => sample(t, s, { spd: null });
    // 2 m in 1 s = 2 m/s → moving, even though the spread is under 3 m
    expect(checkStaging([noSpd(0, -6), noSpd(1000, -6), noSpd(2000, -4)]).stationary).toBe(false);
    expect(checkStaging([noSpd(0, -6), noSpd(1000, -5.8), noSpd(2000, -5.6)]).stationary).toBe(
      true,
    );
    // duplicate timestamps count as 0 m/s rather than infinity
    expect(checkStaging([noSpd(0, -6), noSpd(0, -6), noSpd(1000, -5.8)]).stationary).toBe(true);
  });
});

describe('JumpStartDetector', () => {
  it('triggers on more than 3 m forward for 2 consecutive fixes, once (no device speed)', () => {
    const j = new JumpStartDetector(-5);
    expect(j.onFix(-3, null)).toBe(false); // 2 m of drift is tolerated
    expect(j.onFix(-1.9, null)).toBe(false); // 3.1 m, but a single fix could be drift
    expect(j.onFix(-1.5, null)).toBe(true); // still past 3 m on the next fix
    expect(j.onFix(5, 10)).toBe(false); // only reported once
    expect(j.jumped).toBe(true);
  });

  it('ignores position drift past 3 m when the device says the car is still', () => {
    const j = new JumpStartDetector(0);
    expect(j.onFix(3.5, 0.2)).toBe(false);
    expect(j.onFix(4, 0.3)).toBe(false);
    expect(j.onFix(4.5, 1.5)).toBe(false); // speed agrees now, streak restarts
    expect(j.onFix(5, 1.5)).toBe(true);
  });

  it('ignores a single drifting fix past 3 m', () => {
    const j = new JumpStartDetector(0);
    expect(j.onFix(3.5, null)).toBe(false);
    expect(j.onFix(1, null)).toBe(false);
    expect(j.onFix(3.5, null)).toBe(false);
    expect(j.jumped).toBe(false);
  });

  it('triggers on more than 2 m/s for 2 consecutive fixes, not 1', () => {
    const j = new JumpStartDetector(0);
    expect(j.onFix(0, 2.5)).toBe(false);
    expect(j.onFix(0, 0.5)).toBe(false); // streak broken
    expect(j.onFix(0, 2.5)).toBe(false);
    expect(j.onFix(0, null)).toBe(false); // unknown speed breaks the streak too
    expect(j.onFix(0, 2.1)).toBe(false);
    expect(j.onFix(0, 2.1)).toBe(true);
  });

  it('does not trigger on backward drift', () => {
    const j = new JumpStartDetector(0);
    expect(j.onFix(-10, 0)).toBe(false);
    expect(j.jumped).toBe(false);
  });
});

describe('LaunchDetector', () => {
  it('interpolates when the car passes 1.5 m from its staged position', () => {
    const l = new LaunchDetector(-5, 10_000);
    expect(l.onFix(10_000, -5)).toBeUndefined();
    expect(l.onFix(11_000, -4.5)).toBeUndefined();
    // -3.5 is reached a quarter of the way from -4.5 to -0.5
    expect(l.onFix(12_000, -0.5)).toBe(1250);
    expect(l.onFix(13_000, 10)).toBe(1250);
    expect(l.launchMs).toBe(1250);
  });

  it('extrapolates Doppler speed from two moving fixes back to v = 0', () => {
    const l = new LaunchDetector(-5, 10_000);
    expect(l.onFix(9000, -5, 0.1)).toBeUndefined(); // still
    expect(l.onFix(10_000, -5, 0)).toBeUndefined(); // still
    expect(l.onFix(11_000, -4, 1.2)).toBeUndefined(); // first moving fix
    // 1.2 → 5.2 m/s in 1 s: a = 4 m/s², so v = 0 at 11.0 − 0.3 = 10.7 s
    expect(l.onFix(12_000, -1, 5.2)).toBe(700);
  });

  it('never puts the launch before the last stationary fix', () => {
    const l = new LaunchDetector(0, 10_000);
    l.onFix(10_000, 0, 0.2); // still at 10.0 s
    l.onFix(10_400, 0.5, 2); // moving
    // 2 → 2.4 m/s in 1 s implies v = 0 five seconds earlier, which the 10.0 s fix rules out
    expect(l.onFix(11_400, 3, 2.4)).toBe(0);
  });

  it('ignores speed noise at standstill and decelerating fixes', () => {
    const l = new LaunchDetector(0, 10_000);
    expect(l.onFix(9000, 0, 0.6)).toBeUndefined(); // noise above the still threshold
    expect(l.onFix(10_000, 0, 0.55)).toBeUndefined(); // not increasing: becomes the new first fix
    expect(l.onFix(11_000, 0, 0.1)).toBeUndefined(); // still again
    expect(l.onFix(12_000, 0, 0.9)).toBeUndefined();
    expect(l.onFix(13_000, 0, 1.2)).toBeUndefined(); // increasing, but below 1.5 m/s
    expect(l.launchMs).toBeUndefined();
  });

  it('is negative for a jump start, and uses the fix time when there is no previous fix', () => {
    const l = new LaunchDetector(0, 10_000);
    expect(l.onFix(9000, 4)).toBe(-1000);
  });
});

describe('ClockOffsetTracker', () => {
  it('keeps the median of receivedAt − timestamp over recent fixes', () => {
    const c = new ClockOffsetTracker(3);
    expect(c.medianMs).toBeUndefined();
    c.add(1000, undefined);
    expect(c.medianMs).toBeUndefined();
    c.add(1000, 1040);
    c.add(2000, 2500); // outlier
    c.add(3000, 3030);
    expect(c.medianMs).toBe(40);
    c.add(4000, 4600);
    c.add(5000, 5700); // the first two have aged out: [30, 600, 700]
    expect(c.medianMs).toBe(600);
  });
});
