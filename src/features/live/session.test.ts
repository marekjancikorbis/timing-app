import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE_T, fixAt, straightGeometry } from '../../../tests/harness';
import { type LapTimerDb, openDb } from '../../data/db';
import { prepareStored } from '../../data/routeModel';
import { createRoutesRepo } from '../../data/routesRepo';
import { createRunsRepo, type RunsRepo } from '../../data/runsRepo';
import type { Route } from '../../data/types';
import { FakeClock } from '../../engine/clock';
import type { Fix } from '../../engine/filters';
import { ManualGps } from '../../gps/manualGps';
import { ovalCircuit, simulateDrive } from '../../gps/simulator';
import { createTimingSession, type Feedback, type TimingSession } from './session';

let db: LapTimerDb;
let dbName: string;
let runs: RunsRepo;
let stage: Route;

beforeEach(async () => {
  dbName = `session-${Math.random()}`;
  db = openDb(dbName);
  await db.open();
  runs = createRunsRepo(db);
  stage = await createRoutesRepo(db).create({
    name: 'Straight',
    type: 'stage',
    geometry: straightGeometry(1000),
    source: 'drawn',
    intervalM: 250,
  });
});
afterEach(async () => {
  db.close();
  await Dexie.delete(dbName);
});

function recordingFeedback() {
  const log: string[] = [];
  const fb: Feedback = {
    countdown: (zeroAt, seconds) => {
      log.push(`countdown ${zeroAt - BASE_T} ${seconds}`);
      return () => log.push('countdown cancelled');
    },
    beep: (freq) => log.push(`beep ${freq}`),
    speak: (text) => log.push(`speak ${text}`),
    vibrate: (p) => log.push(`vibrate ${JSON.stringify(p)}`),
  };
  return { log, fb };
}

async function setup(
  route: Route,
  o: { audio?: 'off' | 'beep' | 'voice'; feedback?: Feedback } = {},
) {
  const clock = new FakeClock(BASE_T - 1000);
  const gps = new ManualGps();
  const session = await createTimingSession({
    route,
    gps,
    clock,
    runsRepo: runs,
    settings: { audioCallouts: o.audio ?? 'off', deltaSmoothingS: 1, jumpStartInvalidates: false },
    feedback: o.feedback,
  });
  return { clock, gps, session };
}

/** Deliver fixes in time order, ticking every 50 ms like the screen's animation loop. */
function play(
  s: { clock: FakeClock; gps: ManualGps; session: TimingSession },
  fixes: readonly Fix[],
  tapAt?: number,
) {
  let tapped = tapAt === undefined;
  for (const f of fixes) {
    while (s.clock.now() + 50 < f.t) {
      s.clock.advance(50);
      if (!tapped && s.clock.now() >= (tapAt as number)) tapped = s.session.startCountdown();
      s.session.tick();
    }
    s.clock.set(Math.max(s.clock.now(), f.t));
    s.gps.push(f);
  }
}

/** Flying: east at v m/s from x = −45 (crosses the line at 1.5 s when v = 30). */
const flying = (v: number, offsetMs = 0) =>
  Array.from({ length: Math.ceil(1100 / v) + 3 }, (_, k) =>
    fixAt(-45 + v * k, 0, offsetMs + k * 1000, { spd: v }),
  );

/** Parked at −5 m, accelerating at 4 m/s² from `moveAt` up to 30 m/s. */
function standing(moveAt: number): Fix[] {
  const out: Fix[] = [];
  for (let t = 0; t <= 60_000; t += 1000) {
    const dt = Math.max(0, t - moveAt) / 1000;
    const x = dt <= 7.5 ? -5 + 2 * dt * dt : -5 + 112.5 + 30 * (dt - 7.5);
    out.push(fixAt(x, 0, t, { spd: Math.min(4 * dt, 30) }));
  }
  return out;
}

describe('timing session', () => {
  it('standing start: stage → countdown with beeps → run → saved in a new session', async () => {
    const { log, fb } = recordingFeedback();
    const s = await setup(stage, { feedback: fb });
    await s.session.arm('standing', 5);
    expect(s.gps.running).toBe(true);
    expect(s.session.getState().gps.status).toBe('active');
    play(s, standing(9000), BASE_T + 3500);
    await s.session.flush();

    const st = s.session.getState();
    expect(st.live.state).toBe('finished');
    expect(st.saveError).toBeNull();
    expect(st.saved).toHaveLength(1);
    expect(st.saved[0]).toMatchObject({
      routeId: stage.id,
      startMode: 'standing',
      countdownS: 5,
      valid: true,
      intervalM: 250,
    });
    expect(log).toContain('countdown 8500 5'); // zero = START (3.5 s) + 5 s
    expect(log.filter((l) => l === 'vibrate 80')).toHaveLength(5);
    expect(log).toContain('vibrate 600');
    expect(await runs.listByRoute(stage.id)).toHaveLength(1);
    expect(await runs.sessions(stage.id)).toHaveLength(1);
    // the first valid run becomes the reference for the next standing run
    expect(st.reference.standing?.id).toBe(st.saved[0]?.id);
  });

  it('START does nothing until staged; cancelling stops the beeps', async () => {
    const { log, fb } = recordingFeedback();
    const s = await setup(stage, { feedback: fb });
    await s.session.arm('standing', 5);
    expect(s.session.startCountdown()).toBe(false);
    play(s, standing(60_000).slice(0, 4));
    expect(s.session.startCountdown()).toBe(true);
    s.session.cancelCountdown();
    expect(log.at(-1)).toBe('countdown cancelled');
    expect(s.session.getState().live).toMatchObject({ state: 'staged', countdown: null });
  });

  it('measures against the best saved run, and a faster run takes over as the reference', async () => {
    // A 30 m/s run is already in the history.
    const first = await setup(stage);
    await first.session.arm('flying', 5);
    play(first, flying(30));
    await first.session.flush();
    first.session.dispose();

    // Slower: red sectors, positive gap, and the reference stays.
    const { log, fb } = recordingFeedback();
    const second = await setup(stage, { audio: 'beep', feedback: fb });
    const ref = second.session.getState().reference.flying;
    expect(ref?.totalMs).toBe(33_333);
    await second.session.arm('flying', 5);
    play(second, flying(25));
    await second.session.flush();
    let st = second.session.getState();
    expect(st.live.sectors.map((c) => c.color)).toEqual(['red', 'red', 'red', 'red']);
    expect(st.live.gapMs).toBeGreaterThan(0);
    expect(st.reference.flying?.id).toBe(ref?.id);
    expect(log.filter((l) => l === 'beep 400')).toHaveLength(4); // "slower" beep at each checkpoint

    // Re-arm and go faster: green/purple, and it becomes the new reference.
    await second.session.arm('flying', 5);
    play(second, flying(40, 60_000));
    await second.session.flush();
    st = second.session.getState();
    expect(st.live.sectors.map((c) => c.color)).toEqual(['purple', 'purple', 'purple', 'purple']);
    expect(st.live.gapMs).toBeLessThan(0);
    expect(st.reference.flying?.totalMs).toBe(25_000);
    expect(st.saved).toHaveLength(2);
    expect(await runs.sessions(stage.id)).toHaveLength(2); // one per session object
  });

  it('keeps a pinned reference even when a faster run comes in', async () => {
    const first = await setup(stage);
    await first.session.arm('flying', 5);
    play(first, flying(25));
    await first.session.flush();
    const pinned = first.session.getState().saved[0];
    first.session.dispose();
    await runs.setReferenceChoice(stage.id, 'flying', 'run', pinned?.id);

    const second = await setup(stage);
    expect(second.session.getState().referenceKind.flying).toBe('run');
    expect(second.session.getState().reference.flying?.id).toBe(pinned?.id);
    await second.session.arm('flying', 5);
    play(second, flying(40));
    await second.session.flush();
    expect(second.session.getState().reference.flying?.id).toBe(pinned?.id);
  });

  it("session best: starts without a reference, then chases this session's best", async () => {
    const first = await setup(stage);
    await first.session.arm('flying', 5);
    play(first, flying(40));
    await first.session.flush();
    first.session.dispose();
    await runs.setReferenceChoice(stage.id, 'flying', 'session-best');

    const second = await setup(stage);
    expect(second.session.getState().reference.flying).toBeUndefined();
    await second.session.arm('flying', 5);
    play(second, flying(25));
    await second.session.flush();
    const st = second.session.getState();
    expect(st.reference.flying?.id).toBe(st.saved[0]?.id);
  });

  it('saves every lap of a circuit with its lap number', async () => {
    const circuit = await createRoutesRepo(db).create({
      name: 'Oval',
      type: 'circuit',
      geometry: ovalCircuit(400, 100),
      source: 'drawn',
      intervalM: 300,
    });
    const s = await setup(circuit, { audio: 'voice', ...recordingFeedback() });
    await s.session.arm('flying', 5);
    const fixes = simulateDrive({
      route: prepareStored(circuit),
      start: { mode: 'flying' },
      laps: 3,
      speed: 25,
      startEpoch: BASE_T,
    }).fixes;
    play(s, fixes);
    s.session.stop();
    await s.session.flush();
    const saved = await runs.listByRoute(circuit.id);
    expect(saved.map((r) => r.lapNumber)).toEqual([1, 2, 3]);
    expect(new Set(saved.map((r) => r.sessionId)).size).toBe(1);
    expect(s.session.getState().live.state).toBe('finished');
  });

  it('voice callouts speak the finish time', async () => {
    const { log, fb } = recordingFeedback();
    const s = await setup(stage, { audio: 'voice', feedback: fb });
    await s.session.arm('flying', 5);
    play(s, flying(30));
    expect(log).toContain('speak finish 33.3');
  });

  it('reports a failed save instead of crashing, and keeps timing', async () => {
    const s = await setup(stage);
    await s.session.arm('flying', 5);
    db.close(); // the next write fails
    play(s, flying(30));
    await s.session.flush();
    const st = s.session.getState();
    expect(st.saveError).toMatch(/^Could not save the run: /);
    expect(st.live.lastResult?.totalMs).toBe(33_333);
    await s.session.arm('flying', 5);
    expect(s.session.getState().saveError).toBeNull();
  });

  it('dispose stops the GPS and detaches everything', async () => {
    const s = await setup(stage);
    const seen: string[] = [];
    s.session.subscribe((st) => seen.push(st.live.state));
    await s.session.arm('flying', 5);
    s.session.dispose();
    expect(s.gps.running).toBe(false);
    // Even if the source starts delivering again, the disposed session must not react.
    await s.gps.start();
    const before = seen.length;
    const state = s.session.tracker.state;
    s.gps.push(fixAt(-45, 0, 0, { spd: 30 }));
    s.gps.push(fixAt(-15, 0, 1000, { spd: 30 }));
    expect(seen.length).toBe(before);
    expect(s.session.tracker.state).toBe(state);
  });
});
