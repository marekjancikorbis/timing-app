import { describe, expect, it } from 'vitest';
import type { RunResult, TrackerEvent } from '../engine/tracker';
import { countdownBeeps, LONG_BEEP, SHORT_BEEP } from './audio';
import { CalloutPlanner, FASTER_HZ, SLOWER_HZ, spokenGap, spokenTime } from './callouts';

describe('countdownBeeps', () => {
  it('schedules one short beep per second and a long one at zero, on the audio clock', () => {
    // START tapped at wall time 10 000 ms for a 5 s countdown; the AudioContext clock reads 2.0 s
    const beeps = countdownBeeps(15_000, 5, 10_000, 2);
    expect(beeps.map((b) => b.at)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(
      beeps
        .slice(0, 5)
        .every((b) => b.freq === SHORT_BEEP.freq && b.duration === SHORT_BEEP.duration),
    ).toBe(true);
    expect(beeps[5]).toEqual({ at: 7, ...LONG_BEEP });
  });

  it('skips beeps that are already in the past (e.g. scheduled late)', () => {
    const beeps = countdownBeeps(15_000, 5, 12_500, 0);
    expect(beeps.map((b) => b.at)).toEqual([0.5, 1.5, 2.5]); // the 13 s, 14 s and zero beeps
    expect(countdownBeeps(15_000, 5, 16_000, 0)).toEqual([]);
  });
});

describe('spoken text', () => {
  it.each([
    [83_400, '1 23.4'],
    [61_049, '1 01.0'],
    [9_960, '10.0'],
    [600_000, '10 00.0'],
  ])('spokenTime(%d) = %s', (ms, text) => expect(spokenTime(ms)).toBe(text));

  it.each([
    [340, 'plus 0.3'],
    [-1250, 'minus 1.3'],
    [40, 'even'],
  ])('spokenGap(%d) = %s', (ms, text) => expect(spokenGap(ms)).toBe(text));
});

const cp = (gapMs?: number): TrackerEvent => ({
  type: 'checkpoint',
  lap: 1,
  index: 0,
  cumMs: 1000,
  sectorMs: 1000,
  estimated: false,
  gapMs,
});
const run = (o: Partial<RunResult>): RunResult =>
  ({ totalMs: 83_400, valid: true, ...o }) as RunResult;

describe('CalloutPlanner', () => {
  it('is silent when off', () => {
    const p = new CalloutPlanner('off');
    expect(p.plan(cp(-100), 0)).toBeNull();
    expect(p.plan({ type: 'finish', run: run({}) }, 0)).toBeNull();
  });

  it('beep mode: high tone when ahead (or level), low when behind, nothing without a reference', () => {
    const p = new CalloutPlanner('beep');
    expect(p.plan(cp(-100), 0)).toEqual({ kind: 'beep', freq: FASTER_HZ });
    expect(p.plan(cp(0), 1)).toEqual({ kind: 'beep', freq: FASTER_HZ });
    expect(p.plan(cp(250), 2)).toEqual({ kind: 'beep', freq: SLOWER_HZ });
    expect(p.plan(cp(undefined), 3)).toBeNull();
    expect(p.plan({ type: 'jumpStart' }, 4)).toEqual({ kind: 'beep', freq: SLOWER_HZ });
    expect(p.plan({ type: 'lap', run: run({}) }, 5)).toEqual({ kind: 'beep', freq: FASTER_HZ });
  });

  it('voice mode: throttles sector gaps but always speaks laps, finishes and warnings', () => {
    const p = new CalloutPlanner('voice', 8000);
    expect(p.plan(cp(340), 0)).toEqual({ kind: 'speak', text: 'plus 0.3' });
    expect(p.plan(cp(-500), 3000)).toBeNull(); // too soon
    expect(p.plan({ type: 'offRoute' }, 3500)).toEqual({ kind: 'speak', text: 'off route' });
    expect(p.plan(cp(-500), 9000)).toBeNull(); // the warning reset the timer
    expect(p.plan(cp(-500), 11_600)).toEqual({ kind: 'speak', text: 'minus 0.5' });
    expect(p.plan({ type: 'finish', run: run({}) }, 11_700)).toEqual({
      kind: 'speak',
      text: 'finish 1 23.4',
    });
    expect(p.plan({ type: 'lap', run: run({ valid: false, totalMs: 59_000 }) }, 11_800)).toEqual({
      kind: 'speak',
      text: 'lap 59.0, not valid',
    });
    expect(p.plan({ type: 'jumpStart' }, 11_900)).toEqual({ kind: 'speak', text: 'jump start' });
    expect(
      p.plan({ type: 'position', s: 1, d: 0, elapsedMs: 1, speedMps: 1, acc: 1 }, 30_000),
    ).toBeNull();
  });
});
