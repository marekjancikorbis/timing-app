import { describe, expect, it } from 'vitest';
import {
  BASE_T,
  feed,
  fixAt,
  LAT0,
  LON0,
  makeTracker,
  straightGeometry,
} from '../../tests/harness';
import { mulberry32, ovalCircuit, simulateDrive } from '../gps/simulator';
import type { Fix } from './filters';
import { createProjection } from './geo';
import { prepareRoute } from './route';

/** These tests check the timing logic with exact arithmetic, so smoothing is off unless stated. */
const mk: typeof makeTracker = (route, opts = {}) =>
  makeTracker(route, { smoothing: null, ...opts });

const stage = prepareRoute({ type: 'stage', geometry: straightGeometry(1000), intervalM: 100 });
const circuit = prepareRoute({ type: 'circuit', geometry: ovalCircuit(400, 100), intervalM: 200 });

/**
 * East-bound drive at constant speed: x = x0 + v·t, one fix per second.
 * Flying from x0 = -45 at 30 m/s crosses x = 0 at exactly t = 1500 ms and x = 1000 at t = 34 833.3 ms.
 */
function straight(
  x0 = -45,
  v = 30,
  n = 40,
  startMs = 0,
  mutate?: (f: Fix, k: number) => Fix | null,
): Fix[] {
  const out: Fix[] = [];
  for (let k = 0; k < n; k++) {
    const f = fixAt(x0 + v * k, 0, startMs + k * 1000);
    const m = mutate ? mutate(f, k) : f;
    if (m) out.push(m);
  }
  return out;
}

describe('flying start on a stage', () => {
  it('interpolates the start and finish crossings and every checkpoint', () => {
    const d = mk(stage);
    d.tracker.arm('flying');
    feed(d, straight());

    const [start] = d.of('start');
    expect(start?.t0).toBeCloseTo(BASE_T + 1500, 6);
    const cps = d.of('checkpoint');
    expect(cps.map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    cps.slice(0, -1).forEach((c, i) => {
      expect(c.cumMs).toBeCloseTo(((i + 1) * 100 * 1000) / 30, 3);
      expect(c.sectorMs).toBeCloseTo(3333.333, 2);
    });

    const [fin] = d.of('finish');
    expect(fin?.run).toMatchObject({
      lapNumber: 1,
      startMode: 'flying',
      totalMs: 33_333,
      intervalM: 100,
      valid: true,
      sectorFlags: Array(10).fill('ok'),
    });
    expect(fin?.run.sectorMs).toEqual(Array(10).fill(3333));
    expect(d.tracker.state).toBe('finished');
    expect(d.of('state').map((e) => e.state)).toEqual(['armed', 'ready', 'running', 'finished']);
  });

  it('holds events back until the crossing is confirmed, then emits start first', () => {
    const d = mk(stage);
    d.tracker.arm('flying');
    feed(d, straight().slice(0, 4)); // crossing fix + 1 more: not confirmed yet
    expect(d.of('start')).toHaveLength(0);
    expect(d.of('position')).toHaveLength(0);
    expect(d.tracker.t0).toBeUndefined();
    feed(d, straight().slice(4, 5));
    const types = d.events.map((e) => e.type).filter((t) => t !== 'state');
    expect(types.slice(0, 4)).toEqual(['start', 'position', 'position', 'position']);
    expect(d.tracker.elapsedMs()).toBeCloseTo(d.clock.now() - (BASE_T + 1500), 6);
  });

  it('discards a crossing without forward progress (GPS jitter at the line)', () => {
    const d = mk(stage);
    d.tracker.arm('flying');
    // creep over the line and stop 4 m past it
    feed(d, [
      fixAt(-6, 0, 0),
      fixAt(-2, 0, 1000),
      fixAt(3, 0, 2000),
      fixAt(4, 0, 3000),
      fixAt(4, 0, 4000),
    ]);
    expect(d.of('start')).toHaveLength(0);
    expect(d.tracker.state).toBe('ready');
  });

  it('starts at low speed even when one noisy segment points 63° off the road', () => {
    // 8 m/s; the fix after the line is 16 m to the side: that segment's bearing is 26.6° (road: 90°),
    // beyond the 60° bearing tolerance. Progress along the road is what counts.
    const d = mk(stage);
    d.tracker.arm('flying');
    const fixes = [fixAt(-24, 0, 0), fixAt(-16, 0, 1000), fixAt(-8, 0, 2000), fixAt(0, 16, 3000)];
    for (let k = 1; k <= 10; k++) fixes.push(fixAt(8 * k, 0, 3000 + k * 1000));
    feed(d, fixes);
    // The gate (x = 0, ±20 m) is hit at the end of the (−8, 0) → (0, 16) segment.
    expect(d.of('start')[0]?.t0).toBeCloseTo(BASE_T + 3000, 6);
  });

  it('starts from the distance when the car passes the line outside the gate', () => {
    const d = mk(stage);
    d.tracker.arm('flying');
    // Crosses x = 0 at y = 30, outside the ±20 m gate, but within 50 m of the road.
    const fixes = [fixAt(-40, 0, 0), fixAt(-20, 10, 1000), fixAt(10, 30, 2000)];
    for (let k = 1; k <= 5; k++) fixes.push(fixAt(10 + 20 * k, 0, 2000 + k * 1000));
    feed(d, fixes);
    // s goes −20 → +10 between 1 s and 2 s: zero is two thirds of the way
    expect(d.of('start')[0]?.t0).toBeCloseTo(BASE_T + 1000 + 2000 / 3, 0);
  });

  it('ignores a crossing in the wrong direction', () => {
    const d = mk(stage);
    d.tracker.arm('flying');
    feed(d, straight(45, -30, 6));
    expect(d.of('start')).toHaveLength(0);
  });

  it('stays armed (not ready) when far from the start', () => {
    const d = mk(stage);
    d.tracker.arm('flying');
    feed(d, [fixAt(500, 0, 0)]);
    expect(d.tracker.state).toBe('armed');
  });

  it('finishes from the lead-out when the finish gate is missed', () => {
    const narrow = prepareRoute({ type: 'stage', geometry: straightGeometry(1000), gateWidthM: 4 });
    const d = mk(narrow);
    d.tracker.arm('flying');
    // 10 m to the side of the road at the finish: outside a 4 m gate, still on route
    feed(
      d,
      straight(-45, 30, 40, 0, (f, k) => (k >= 30 ? fixAt(-45 + 30 * k, 10, k * 1000) : f)),
    );
    expect(d.of('finish')[0]?.run.totalMs).toBe(33_333);
  });

  it('auto re-arms after a finish when asked', () => {
    const d = mk(stage, { autoRearm: true });
    d.tracker.arm('flying');
    feed(d, straight());
    expect(d.of('finish')).toHaveLength(1);
    expect(d.tracker.state).toBe('armed');
  });
});

describe('live gaps against a reference', () => {
  it('are ~0 against an identical run and positive when slower', () => {
    const first = mk(stage);
    first.tracker.arm('flying');
    feed(first, straight());
    const ref = first.of('finish')[0]?.run.profile;
    expect(ref).toBeDefined();

    const same = mk(stage, { references: { flying: ref } });
    same.tracker.arm('flying');
    feed(same, straight());
    for (const p of same.of('position')) expect(Math.abs(p.gapMs ?? NaN)).toBeLessThan(1);
    for (const c of same.of('checkpoint')) expect(Math.abs(c.gapMs ?? NaN)).toBeLessThan(1);

    const slow = mk(stage);
    slow.tracker.setReferences({ flying: ref });
    slow.tracker.arm('flying');
    feed(slow, straight(-45, 25, 50));
    const cps = slow.of('checkpoint');
    // At 25 vs 30 m/s the gap at distance D is D/25 − D/30 seconds.
    cps.forEach((c, i) => {
      const D = (i + 1) * 100;
      expect(c.gapMs).toBeCloseTo((D / 25 - D / 30) * 1000, 0);
    });
  });
});

describe('fix problems during a run', () => {
  it('flags estimated sectors across a short GPS gap but keeps the run valid', () => {
    const d = mk(stage);
    d.tracker.arm('flying');
    feed(
      d,
      straight(-45, 30, 40, 0, (f, k) => (k >= 10 && k <= 12 ? null : f)),
    );
    expect(d.of('gpsGap')[0]?.gapMs).toBe(4000);
    const run = d.of('finish')[0]?.run;
    expect(run?.valid).toBe(true);
    // fixes 9 → 13 are x = 225 → 345: checkpoints 300 (index 2) is crossed in the gap
    expect(run?.sectorFlags[2]).toBe('estimated');
    expect(run?.sectorFlags.filter((f) => f === 'estimated')).toHaveLength(1);
    expect(run?.totalMs).toBe(33_333); // straight-line interpolation is still exact
  });

  it('invalidates the run after a gap over 15 s', () => {
    const d = mk(stage);
    d.tracker.arm('flying');
    feed(
      d,
      straight(-45, 30, 40, 0, (f, k) => (k >= 6 && k <= 22 ? null : f)),
    );
    const run = d.of('finish')[0]?.run;
    expect(run?.valid).toBe(false);
    expect(run?.invalidReason).toBe('gps-gap');
  });

  it('marks the run off-route after 3 fixes more than 50 m away (60 m; 80 m in 1 s would be rejected as a jump)', () => {
    const d = mk(stage);
    d.tracker.arm('flying');
    const off = (f: Fix, k: number) => (k >= 10 && k <= 12 ? fixAt(-45 + 30 * k, 60, k * 1000) : f);
    feed(d, straight(-45, 30, 40, 0, off));
    expect(d.of('offRoute')).toHaveLength(1);
    expect(d.of('finish')[0]?.run).toMatchObject({ valid: false, invalidReason: 'off-route' });
  });

  it('two fixes off the route are not enough', () => {
    const d = mk(stage);
    d.tracker.arm('flying');
    const off = (f: Fix, k: number) =>
      k === 10 || k === 11 ? fixAt(-45 + 30 * k, 60, k * 1000) : f;
    feed(d, straight(-45, 30, 40, 0, off));
    expect(d.of('offRoute')).toHaveLength(0);
    expect(d.of('finish')[0]?.run.valid).toBe(true);
  });

  it('can abort on off-route instead', () => {
    const d = mk(stage, { abortOnOffRoute: true });
    d.tracker.arm('flying');
    const off = (f: Fix, k: number) => (k >= 10 ? fixAt(-45 + 30 * k, 60, k * 1000) : f);
    feed(d, straight(-45, 30, 40, 0, off));
    expect(d.tracker.state).toBe('aborted');
    expect(d.of('aborted')[0]?.run).toMatchObject({
      valid: false,
      invalidReason: 'off-route',
      sectorMs: [],
    });
  });

  it('rejects bad fixes but keeps them in the trace, flagged', () => {
    const d = mk(stage);
    d.tracker.arm('flying');
    feed(
      d,
      straight(-45, 30, 40, 0, (f, k) => (k === 8 ? { ...f, acc: 60 } : f)),
    );
    expect(d.of('fixRejected')).toEqual([{ type: 'fixRejected', reason: 'accuracy' }]);
    const trace = d.of('finish')[0]?.run.trace ?? [];
    expect(trace.filter((p) => p.rej === 'accuracy')).toHaveLength(1);
    expect(trace.find((p) => p.rej)?.s).toBeUndefined();
  });
});

describe('user stop', () => {
  it('aborts a stage run in progress as user-abort', () => {
    const d = mk(stage);
    d.tracker.arm('flying');
    feed(d, straight().slice(0, 10));
    d.tracker.stop();
    expect(d.tracker.state).toBe('aborted');
    expect(d.of('aborted')[0]?.run).toMatchObject({ valid: false, invalidReason: 'user-abort' });
  });

  it('goes back to idle when nothing is running', () => {
    const d = mk(stage);
    d.tracker.arm('flying');
    d.tracker.stop();
    expect(d.tracker.state).toBe('idle');
    expect(d.of('aborted')).toHaveLength(0);
  });
});

describe('circuit laps', () => {
  const L = circuit.lengthM;

  it('splits laps at the line and keeps running', () => {
    const d = mk(circuit);
    d.tracker.arm('flying');
    const sim = simulateDrive({ route: circuit, start: { mode: 'flying' }, laps: 3, speed: 25 });
    feed(d, sim.fixes);
    const laps = d.of('lap').map((e) => e.run);
    expect(laps.map((r) => r.lapNumber)).toEqual([1, 2, 3]);
    for (const [i, r] of laps.entries()) {
      const truth = sim.timeAt((i + 1) * L) - sim.timeAt(i * L);
      expect(Math.abs(r.totalMs - truth)).toBeLessThan(20);
      expect(r.sectorMs.reduce((a, b) => a + b, 0)).toBeCloseTo(r.totalMs, -1);
      expect(r.startMode).toBe('flying');
    }
    expect(d.of('finish')).toHaveLength(0);
    expect(d.tracker.state).toBe('running');
    d.tracker.stop();
    expect(d.tracker.state).toBe('finished');
  });

  it('never double-counts laps with 3 m GPS noise', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const d = mk(circuit);
      d.tracker.arm('flying');
      const sim = simulateDrive({
        route: circuit,
        start: { mode: 'flying' },
        laps: 3,
        speed: 25,
        noiseM: 3,
        seed,
        runOutS: 3,
      });
      feed(d, sim.fixes);
      expect(
        d.of('lap').map((e) => e.run.lapNumber),
        `seed ${seed}`,
      ).toEqual([1, 2, 3]);
    }
  });

  it('still splits laps when the fixes miss the gate (fallback on distance)', () => {
    const sim = simulateDrive({ route: circuit, start: { mode: 'flying' }, laps: 4, speed: 25 });
    const proj = createProjection(LON0, LAT0);
    // After the start, push every fix near the line 30 m outward: outside the ±20 m gate,
    // still inside the 50 m off-route limit. The line is at x = 0 on the y = -100 straight.
    const fixes = sim.fixes.map((f) => {
      const p = proj.toXY(f.lon, f.lat);
      if (f.t < BASE_T + 20_000 || Math.abs(p.x) > 60 || p.y > -60) return f;
      const [lon, lat] = proj.toLonLat({ x: p.x, y: p.y - 30 });
      return { ...f, lon, lat };
    });
    const d = mk(circuit);
    d.tracker.arm('flying');
    feed(d, fixes);
    const laps = d.of('lap').map((e) => e.run);
    expect(laps.map((r) => r.lapNumber)).toEqual([1, 2, 3, 4]);
    laps.forEach((r, i) => {
      const truth = sim.timeAt((i + 1) * circuit.lengthM) - sim.timeAt(i * circuit.lengthM);
      // the fallback interpolates the shifted fixes' along-track distance: within ~0.1 s
      expect(Math.abs(r.totalMs - truth), `lap ${i + 1}`).toBeLessThan(100);
      expect(r.valid).toBe(true);
    });
  });

  it('lap guard: re-crossing the line soon after the start is not a lap', () => {
    const d = mk(circuit);
    d.tracker.arm('flying');
    // The start straight runs east along y = -100 (x from 0 to 400).
    const y = -100;
    const xs = [-45, -15, 15, 45, 75, 60, 30, 0, -20, -10, 10, 40, 70];
    feed(
      d,
      xs.map((x, k) => fixAt(x, y, k * 1000)),
      {},
    );
    expect(d.of('start')).toHaveLength(1);
    expect(d.of('lap')).toHaveLength(0);
  });

  it('lap guard: laps shorter than the minimum lap time are ignored', () => {
    const d = mk(circuit, { minLapMs: 120_000 });
    d.tracker.arm('flying');
    feed(d, simulateDrive({ route: circuit, start: { mode: 'flying' }, laps: 1, speed: 25 }).fixes);
    expect(d.of('lap')).toHaveLength(0);
  });
});

describe('standing start', () => {
  /** Stationary at x = -5 until 9 s, then 10 m/s; START tapped at 3.5 s, 5 s countdown → zero at 8.5 s. */
  function standingDrive(moveAtMs = 9000, mutate?: (f: Fix) => Fix): Fix[] {
    const out: Fix[] = [];
    for (let t = 0; t <= 115_000; t += 1000) {
      const x = t < moveAtMs ? -5 : -5 + (10 * (t - moveAtMs)) / 1000;
      // No device speed: speed jumps 0 → 10 m/s here, which no real car does.
      const f = fixAt(x, 0, t, { spd: null });
      out.push(mutate ? mutate(f) : f);
    }
    return out;
  }

  it('stages, counts down on the fake clock and starts exactly at zero', () => {
    const d = mk(stage);
    d.tracker.arm('standing', 5);
    expect(d.tracker.startCountdown()).toBe(false); // no fixes yet → not staged
    feed(d, standingDrive().slice(0, 4)); // up to t = 3000
    expect(d.tracker.state).toBe('staged');
    expect(d.tracker.staging).toMatchObject({
      ready: true,
      gpsOk: true,
      atLine: true,
      stationary: true,
    });

    d.clock.set(BASE_T + 3500);
    expect(d.tracker.startCountdown()).toBe(true);
    expect(d.tracker.countdownZeroAt).toBe(BASE_T + 8500);
    feed(d, standingDrive().slice(4));

    expect(d.of('countdownTick').map((e) => e.remaining)).toEqual([5, 4, 3, 2, 1, 0]);
    const [start] = d.of('start');
    expect(start).toEqual({ type: 'start', t0: BASE_T + 8500, mode: 'standing', lap: 1 });

    const run = d.of('finish')[0]?.run;
    // At t = 9000 the car leaves x = -5 at 10 m/s, so x = 1000 is reached at 109.5 s → 101 s after zero.
    expect(run).toMatchObject({
      startMode: 'standing',
      countdownS: 5,
      totalMs: 101_000,
      jumpStart: false,
      launchMs: 650, // 1.5 m past the staged spot at 9.15 s
      valid: true,
    });
    expect(run?.sectorMs[0]).toBe(11_000); // x = 100 at 19.5 s
    expect(run?.sectorMs.slice(1, 9)).toEqual(Array(8).fill(10_000));
  });

  it('cancel returns to staged without starting', () => {
    const d = mk(stage);
    d.tracker.arm('standing', 5);
    feed(d, standingDrive().slice(0, 4));
    d.tracker.startCountdown();
    d.tracker.cancelCountdown();
    expect(d.tracker.state).toBe('staged');
    expect(d.tracker.countdownZeroAt).toBeUndefined();
    d.clock.advance(10_000);
    d.tracker.tick();
    expect(d.of('start')).toHaveLength(0);
    d.tracker.cancelCountdown(); // no-op when not counting down
    expect(d.tracker.state).toBe('staged');
  });

  it('becomes un-staged when the car moves before START', () => {
    const d = mk(stage);
    d.tracker.arm('standing');
    feed(d, standingDrive().slice(0, 4));
    feed(d, [fixAt(-15, 0, 4000, { spd: 3 })]);
    expect(d.tracker.state).toBe('armed');
    expect(d.tracker.staging?.stationary).toBe(false);
    expect(d.tracker.startCountdown()).toBe(false);
  });

  it('detects a jump start; the run stays valid unless configured otherwise', () => {
    for (const invalidates of [false, true]) {
      const d = mk(stage, { jumpStartInvalidates: invalidates });
      d.tracker.arm('standing', 5);
      feed(d, standingDrive(7000), { startCountdownAt: BASE_T + 3500 }); // moves 1.5 s early
      expect(d.of('jumpStart')).toHaveLength(1);
      const run = d.of('finish')[0]?.run;
      expect(run?.jumpStart).toBe(true);
      expect(run?.launchMs).toBe(-1350); // 1.5 m at 10 m/s after 7 s, i.e. 1.35 s before zero
      expect(run?.valid).toBe(!invalidates);
      if (invalidates) expect(run?.invalidReason).toBe('jump-start');
    }
  });

  it('estimates launch time from Doppler speed and uses it to catch an early launch', () => {
    // Constant 4 m/s² from t = moveAt; one fix per second with exact speeds.
    const accelDrive = (moveAt: number): Fix[] => {
      const out: Fix[] = [];
      for (let t = 0; t <= 60_000; t += 1000) {
        const dt = Math.max(0, t - moveAt) / 1000;
        const v = Math.min(4 * dt, 30);
        const x = dt <= 7.5 ? -5 + 2 * dt * dt : -5 + 112.5 + 30 * (dt - 7.5);
        out.push(fixAt(x, 0, t, { spd: v }));
      }
      return out;
    };
    const run = (moveAt: number) => {
      const d = mk(stage);
      d.tracker.arm('standing', 5);
      feed(d, accelDrive(moveAt), { startCountdownAt: BASE_T + 3500 }); // zero at 8.5 s
      return { d, run: d.runs()[0] };
    };
    // Leaves 0.5 s after zero: launch +500 ms, no jump start.
    expect(run(9000).run).toMatchObject({ launchMs: 500, jumpStart: false });
    // Leaves 1.5 s early: before zero there is one moving fix (2 m, 4 m/s). That is under the 3 m
    // distance trigger and short of the 2-fix speed streak. The launch estimate from the 8 s and 9 s
    // fixes puts v = 0 at 7.0 s, so the jump start is flagged just after zero.
    const early = run(7000);
    expect(early.run).toMatchObject({ launchMs: -1500, jumpStart: true });
    expect(early.d.of('jumpStart')).toHaveLength(1);
  });

  it('records the clock offset and can correct fix times with it', () => {
    const late = (f: Fix): Fix => ({ ...f, receivedAt: f.t + 400 });
    const results = [false, true].map((correct) => {
      const d = mk(stage, { clockOffsetCorrection: correct });
      d.tracker.arm('standing', 5);
      feed(d, standingDrive(9400, late), { startCountdownAt: BASE_T + 3900 });
      return d.of('finish')[0]?.run;
    });
    expect(results[0]?.clockOffsetMs).toBe(400);
    expect((results[1]?.totalMs ?? 0) - (results[0]?.totalMs ?? 0)).toBe(400);
  });

  it('on a circuit only lap 1 is a standing lap', () => {
    const d = mk(circuit);
    d.tracker.arm('standing', 3);
    const sim = simulateDrive({
      route: circuit,
      start: { mode: 'standing', stagedS: -5, launchAtMs: 9000 },
      laps: 2,
      speed: 25,
    });
    feed(d, sim.fixes, { startCountdownAt: sim.fixes[0]!.t + 5500 });
    const laps = d.of('lap').map((e) => e.run);
    expect(laps.map((r) => r.startMode)).toEqual(['standing', 'flying']);
    expect(laps[0]?.countdownS).toBe(3);
    expect(d.of('start').map((e) => e.mode)).toEqual(['standing', 'flying', 'flying']);
  });
});

describe('along-track smoothing in the tracker', () => {
  it('is exact when device speed agrees with the positions', () => {
    const d = makeTracker(stage);
    d.tracker.arm('flying');
    feed(
      d,
      straight(-45, 30, 40, 0, (f) => ({ ...f, spd: 30 })),
    );
    expect(d.of('finish')[0]?.run.totalMs).toBe(33_333);
  });

  it('roughly halves the timing error from noisy positions (RMS over 20 drives)', () => {
    const rms = [true, false].map((on) => {
      let sq = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const rnd = mulberry32(seed);
        // ±4 m uniform along-track noise, exact Doppler speed, 5 fixes of run-up before the line
        const noisy: Fix[] = [];
        for (let k = 0; k < 45; k++) {
          noisy.push(fixAt(-165 + 30 * k + (rnd() - 0.5) * 8, 0, k * 1000, { spd: 30 }));
        }
        const d = on ? makeTracker(stage) : mk(stage);
        d.tracker.arm('flying');
        feed(d, noisy);
        const total = d.of('finish')[0]?.run.totalMs;
        expect(total).toBeDefined();
        sq += ((total as number) - 33_333) ** 2;
      }
      return Math.sqrt(sq / 20);
    });
    expect(rms[0]).toBeLessThan(rms[1]! * 0.6);
  });
});
