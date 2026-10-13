import { describe, expect, it } from 'vitest';
import {
  BASE_T,
  type Drive,
  feed,
  fixAt,
  makeTracker,
  straightGeometry,
} from '../../../tests/harness';
import { GapSmoother } from '../../engine/delta';
import type { Fix } from '../../engine/filters';
import { prepareRoute } from '../../engine/route';
import type { RunResult, TrackerOptions } from '../../engine/tracker';
import { ovalCircuit, simulateDrive } from '../../gps/simulator';
import {
  formatGap,
  formatTime,
  initialLive,
  type LiveContext,
  type LiveModel,
  liveReduce,
} from './liveModel';

const stage = prepareRoute({ type: 'stage', geometry: straightGeometry(1000), intervalM: 100 });

/** East-bound at constant speed from x0, one fix per second (exact speeds, smoothing has no effect). */
function straight(v = 30, n = 50, x0 = -45, startMs = 0): Fix[] {
  return Array.from({ length: n }, (_, k) => fixAt(x0 + v * k, 0, startMs + k * 1000, { spd: v }));
}

/** Run a drive through the real tracker and fold its events into the live model. */
function live(
  setup: (d: Drive) => void,
  opts: {
    ctx?: Partial<LiveContext>;
    model?: LiveModel;
    tracker?: Partial<TrackerOptions>;
    route?: typeof stage;
  } = {},
) {
  const route = opts.route ?? stage;
  const d = makeTracker(route, opts.tracker);
  const ctx: LiveContext = { refSectors: {}, smoother: new GapSmoother(1000), ...opts.ctx };
  let m = opts.model ?? initialLive(route.checkpoints.length);
  const seen: LiveModel[] = [];
  d.tracker.on((e) => {
    m = liveReduce(m, e, ctx);
    seen.push(m);
  });
  setup(d);
  return { model: () => m, seen, d };
}

describe('formatting', () => {
  it.each([
    [0, '0:00.00'],
    [1234, '0:01.23'],
    [59_996, '1:00.00'], // rounds before splitting minutes
    [61_005, '1:01.01'],
    [3_723_450, '1:02:03.45'],
    [-1500, '−0:01.50'],
    [null, '–:––.––'],
  ])('formatTime(%s) = %s', (ms, text) => expect(formatTime(ms)).toBe(text));

  it('formatTime with other precisions', () => {
    expect(formatTime(61_456, 1)).toBe('1:01.5');
    expect(formatTime(61_456, 0)).toBe('1:01');
    expect(formatTime(-0.4)).toBe('0:00.00'); // no "−0"
  });

  it.each([
    [345, '+0.35'],
    [-1234, '−1.23'],
    [0, '±0.00'],
    [4, '±0.00'], // rounds to zero: no sign
    [-1005, '−1.01'],
    [null, '–'],
    [Number.NaN, '–'],
  ])('formatGap(%s) = %s', (ms, text) => expect(formatGap(ms)).toBe(text));
});

describe('live model: a flying stage run', () => {
  it('first run ever: every sector is a personal best (purple), no gap without a reference', () => {
    const { model, seen } = live((d) => {
      d.tracker.arm('flying');
      feed(d, straight());
    });
    const m = model();
    expect(seen.map((s) => s.state).filter((s, i, a) => s !== a[i - 1])).toEqual([
      'armed',
      'ready',
      'running',
      'finished',
    ]);
    expect(m.sectors.map((c) => c.color)).toEqual(Array(10).fill('purple'));
    expect(m.sectors.map((c) => c.ms)).toEqual(Array(10).fill(3333));
    expect(m.lastSector).toEqual({ index: 9, ms: 3333, deltaMs: null, color: 'purple' });
    expect(m.gapMs).toBeNull();
    expect(m.t0).toBeCloseTo(BASE_T + 1500, 6);
    expect(m.lastResult?.totalMs).toBe(33_333);
    expect(m.bestSectors.flying).toEqual(Array(10).fill(3333));
    expect(m.distanceM).toBeGreaterThan(900);
    expect(m.speedMps).toBeCloseTo(30, 6);
  });

  it('against a faster reference: red sectors, +0.667 s per sector, positive smoothed gap', () => {
    const ref = live((d) => {
      d.tracker.arm('flying');
      feed(d, straight(30));
    }).model().lastResult as RunResult;
    const { model, seen } = live(
      (d) => {
        d.tracker.arm('flying');
        feed(d, straight(25, 60));
      },
      {
        ctx: { refSectors: { flying: ref.sectorMs } },
        model: initialLive(10, { flying: ref.sectorMs }),
        tracker: { references: { flying: ref.profile } },
      },
    );
    const m = model();
    expect(m.sectors.map((c) => c.color)).toEqual(Array(10).fill('red'));
    expect(m.lastSector?.deltaMs).toBe(4000 - 3333);
    // the gap grows with distance: D/25 − D/30 s
    const gaps = seen.map((s) => s.gapMs).filter((g): g is number => g !== null);
    expect(gaps.at(-1)).toBeGreaterThan(5000);
    expect(gaps.every((g, i) => i === 0 || g >= (gaps[i - 1] as number) - 1)).toBe(true);
    // bests are unchanged by a slower valid run
    expect(m.bestSectors.flying).toEqual(Array(10).fill(3333));
  });

  it('an identical run ties the best: purple; a faster one than the reference but not the best: green', () => {
    const best = live((d) => {
      d.tracker.arm('flying');
      feed(d, straight(30));
    }).model().lastResult as RunResult;
    const tie = live(
      (d) => {
        d.tracker.arm('flying');
        feed(d, straight(30));
      },
      {
        ctx: { refSectors: { flying: best.sectorMs } },
        model: initialLive(10, { flying: best.sectorMs }),
      },
    ).model();
    expect(tie.sectors.map((c) => c.color)).toEqual(Array(10).fill('purple'));

    const slowRef = Array(10).fill(3500);
    const green = live(
      (d) => {
        d.tracker.arm('flying');
        feed(d, straight(30));
      },
      {
        ctx: { refSectors: { flying: slowRef } },
        model: initialLive(10, { flying: Array(10).fill(3000) }),
      },
    ).model();
    expect(green.sectors.map((c) => c.color)).toEqual(Array(10).fill('green'));
    expect(green.lastSector?.deltaMs).toBe(3333 - 3500);
  });

  it('counts GPS gaps and rejected fixes, and flags off-route', () => {
    const fixes = straight().flatMap((f, k) => {
      if (k === 10 || k === 11) return []; // 3 s gap
      if (k === 20) return [{ ...f, acc: 80 }];
      if (k >= 25 && k <= 27) return [fixAt(-45 + 30 * k, 60, k * 1000, { spd: 30 })];
      return [f];
    });
    const m = live((d) => {
      d.tracker.arm('flying');
      feed(d, fixes);
    }).model();
    expect(m.gpsGaps).toBe(1);
    expect(m.rejectedFixes).toBe(1);
    expect(m.offRoute).toBe(true);
    expect(m.lastResult?.valid).toBe(false);
    expect(m.bestSectors.flying).toEqual([]); // invalid runs don't set bests
  });
});

describe('live model: standing start', () => {
  /** Parked at x = −5, START at 3.5 s (zero at 8.5 s), leaves at `moveAt`. */
  function standing(moveAt: number): Fix[] {
    const out: Fix[] = [];
    for (let t = 0; t <= 60_000; t += 1000) {
      const dt = Math.max(0, t - moveAt) / 1000;
      const v = Math.min(4 * dt, 30);
      const x = dt <= 7.5 ? -5 + 2 * dt * dt : -5 + 112.5 + 30 * (dt - 7.5);
      out.push(fixAt(x, 0, t, { spd: v }));
    }
    return out;
  }

  it('shows staging, counts down 5…0, starts at zero', () => {
    const { model, seen } = live((d) => {
      d.tracker.arm('standing', 5);
      feed(d, standing(9000), { startCountdownAt: BASE_T + 3500 });
    });
    expect(seen.some((s) => s.state === 'staged' && s.staging?.ready)).toBe(true);
    const remaining = seen.map((s) => s.countdown?.remaining).filter((r) => r !== undefined);
    expect([...new Set(remaining)]).toEqual([5, 4, 3, 2, 1, 0]);
    const totals = seen.map((s) => s.countdown?.total).filter((r) => r !== undefined);
    expect([...new Set(totals)]).toEqual([5]); // the length stays put while counting down
    const m = model();
    expect(m).toMatchObject({
      mode: 'standing',
      lap: 1,
      countdown: null,
      jumpStart: false,
      t0: BASE_T + 8500,
    });
    expect(m.lastResult?.launchMs).toBe(500);
  });

  it('flags a jump start, and re-arming clears it and the sectors', () => {
    const { model, d } = live((dd) => {
      dd.tracker.arm('standing', 5);
      feed(dd, standing(7000), { startCountdownAt: BASE_T + 3500 });
    });
    expect(model().jumpStart).toBe(true);
    expect(model().sectors.some((c) => c.color !== 'pending')).toBe(true);
    d.tracker.arm('standing', 5);
    expect(model()).toMatchObject({
      state: 'armed',
      jumpStart: false,
      t0: null,
      lap: 0,
      countdown: null,
      staging: null,
    });
    expect(model().sectors.every((c) => c.color === 'pending')).toBe(true);
    expect(model().results).toHaveLength(1); // the session's results are kept
  });

  it('cancelling the countdown clears it', () => {
    const { model, d } = live((dd) => {
      dd.tracker.arm('standing', 5);
      feed(dd, standing(60_000).slice(0, 4));
      dd.clock.set(BASE_T + 3500);
      dd.tracker.startCountdown();
    });
    expect(model().countdown?.remaining).toBe(5);
    d.tracker.cancelCountdown();
    expect(model()).toMatchObject({ state: 'staged', countdown: null });
  });
});

describe('live model: circuit laps and aborts', () => {
  it('resets the sector strip each lap and keeps every lap', () => {
    const circuit = prepareRoute({
      type: 'circuit',
      geometry: ovalCircuit(400, 100),
      intervalM: 200,
    });
    const lapStarts: number[] = [];
    const { model, seen } = live(
      (d) => {
        d.tracker.arm('flying');
        feed(
          d,
          simulateDrive({ route: circuit, start: { mode: 'flying' }, laps: 3, speed: 25 }).fixes,
        );
      },
      { route: circuit },
    );
    seen.forEach((s, i) => {
      if (s.lap !== seen[i - 1]?.lap) lapStarts.push(i);
    });
    const m = model();
    expect(m.results.map((r) => r.lapNumber)).toEqual([1, 2, 3]);
    expect(m.lap).toBe(4); // lap 4 started when lap 3 ended
    // right after each new lap starts, the strip is empty again
    for (const i of lapStarts.slice(1)) {
      expect((seen[i] as LiveModel).sectors.every((c) => c.color === 'pending')).toBe(true);
    }
    expect(m.bestSectors.flying).toHaveLength(circuit.checkpoints.length);
  });

  it('records an aborted stage run', () => {
    const m = live((d) => {
      d.tracker.arm('flying');
      feed(d, straight().slice(0, 12));
      d.tracker.stop();
    }).model();
    expect(m.state).toBe('aborted');
    expect(m.lastResult).toMatchObject({ valid: false, invalidReason: 'user-abort' });
    expect(m.results).toHaveLength(1);
  });
});
