import 'fake-indexeddb/auto';
import { expose, wrap } from 'comlink';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE_T, feed, makeTracker } from '../../tests/harness';
import { type LapTimerDb, openDb } from '../data/db';
import { prepareStored, routeFromDraft } from '../data/routeModel';
import { createRoutesRepo } from '../data/routesRepo';
import { createRunsRepo } from '../data/runsRepo';
import type { Route } from '../data/types';
import { sectorsFromProfile } from '../engine/delta';
import { withInterval } from '../engine/route';
import type { RunResult } from '../engine/tracker';
import { ovalCircuit, simulateDrive, windingStage } from '../gps/simulator';
import { handleRecompute, type RecomputeRequest } from './recompute';
import { inlineRunner, recomputeRoute } from './recomputeRoute';

/** Drive a stored route with the real tracker and return the runs. */
function drive(route: Route, seed: number): RunResult[] {
  const prepared = prepareStored(route);
  const d = makeTracker(prepared);
  d.tracker.arm('flying');
  feed(
    d,
    simulateDrive({
      route: prepared,
      start: { mode: 'flying' },
      laps: 2,
      speed: (s) => 22 * (1 + 0.3 * Math.sin(s / 200)),
      noiseM: 2,
      seed,
      startEpoch: BASE_T,
    }).fixes,
  );
  return d.runs();
}

const stage = routeFromDraft(
  { name: 'S', type: 'stage', geometry: windingStage(3000), source: 'drawn', intervalM: 500 },
  's',
  1,
);
const circuit = routeFromDraft(
  { name: 'C', type: 'circuit', geometry: ovalCircuit(500, 120), source: 'drawn', intervalM: 300 },
  'c',
  1,
);

describe('handleRecompute', () => {
  it.each([
    ['stage', stage],
    ['circuit', circuit],
  ] as const)(
    '%s: matches the main-thread recompute and a fresh run at the new interval',
    (_, route) => {
      const runs = drive(route, 4);
      expect(runs.length).toBeGreaterThan(0);
      for (const newInterval of [100, 250, 650, 1000]) {
        const out = handleRecompute({
          lengthM: route.lengthM,
          intervalM: newInterval,
          runs: runs.map((r, i) => ({ id: `r${i}`, profile: r.profile })),
        });
        // main thread: the engine route at the new interval
        const checkpoints = withInterval(prepareStored(route), newInterval).checkpoints;
        const fresh = drive({ ...route, intervalM: newInterval }, 4);
        out.forEach((u, i) => {
          const run = runs[i] as RunResult;
          expect(u).toEqual({
            id: `r${i}`,
            intervalM: newInterval,
            sectorMs: sectorsFromProfile(run.profile, checkpoints).sectorMs.map(Math.round),
          });
          const freshSectors = (fresh[i] as RunResult).sectorMs;
          expect(u.sectorMs).toHaveLength(freshSectors.length);
          u.sectorMs.forEach((ms, k) =>
            expect(Math.abs(ms - (freshSectors[k] as number))).toBeLessThanOrEqual(1),
          );
        });
      }
    },
  );

  it('clamps the interval like the editor does and handles no runs', () => {
    const [u] = handleRecompute({
      lengthM: 1000,
      intervalM: 30,
      runs: [{ id: 'a', profile: { s: [0, 1000], t: [0, 100_000] } }],
    });
    expect(u).toEqual({ id: 'a', intervalM: 100, sectorMs: Array(10).fill(10_000) });
    expect(handleRecompute({ lengthM: 1000, intervalM: 200, runs: [] })).toEqual([]);
  });

  it('gives the same answer across a Comlink message channel (structured clone, as in the worker)', async () => {
    const { port1, port2 } = new MessageChannel();
    expose({ recompute: handleRecompute }, port1);
    const remote = wrap<{ recompute: typeof handleRecompute }>(port2);
    const req: RecomputeRequest = {
      lengthM: stage.lengthM,
      intervalM: 250,
      runs: drive(stage, 7).map((r, i) => ({ id: String(i), profile: r.profile })),
    };
    expect(await remote.recompute(req)).toEqual(handleRecompute(req));
    port1.close();
    port2.close();
  });
});

describe('recomputeRoute (orchestration over IndexedDB)', () => {
  let db: LapTimerDb;
  let name: string;
  beforeEach(async () => {
    name = `recompute-${Math.random()}`;
    db = openDb(name);
    await db.open();
  });
  afterEach(async () => {
    db.close();
    await Dexie.delete(name);
  });

  it('rewrites stale runs after an interval change, and only those', async () => {
    const routes = createRoutesRepo(db);
    const runsRepo = createRunsRepo(db);
    const route = await routes.create({
      name: 'S',
      type: 'stage',
      geometry: windingStage(3000),
      source: 'drawn',
      intervalM: 500,
    });
    const session = await runsRepo.startSession(route.id);
    const saved = [];
    for (const r of [...drive(route, 1), ...drive(route, 2)])
      saved.push(await runsRepo.save(r, route.id, session.id));

    expect(await recomputeRoute(db, route.id, inlineRunner)).toBe(0); // nothing stale yet

    const { route: updated, intervalChanged } = await routes.update(route.id, { intervalM: 250 });
    expect(intervalChanged).toBe(true);
    expect(await recomputeRoute(db, route.id, inlineRunner)).toBe(saved.length);

    const checkpoints = prepareStored(updated).checkpoints;
    for (const s of saved) {
      const run = await runsRepo.get(s.id);
      const trace = await runsRepo.getTrace(s.traceId);
      expect(run?.intervalM).toBe(250);
      expect(run?.sectorMs).toEqual(
        sectorsFromProfile(trace!.profile, checkpoints).sectorMs.map(Math.round),
      );
      expect(run?.totalMs).toBe(s.totalMs); // totals never change
    }
    expect(await recomputeRoute(db, route.id, inlineRunner)).toBe(0); // idempotent
  });

  it('falls back to recomputing inline when there is no Worker (default runner)', async () => {
    expect(typeof Worker).toBe('undefined');
    const routes = createRoutesRepo(db);
    const runsRepo = createRunsRepo(db);
    const route = await routes.create({
      name: 'S',
      type: 'stage',
      geometry: windingStage(3000),
      source: 'drawn',
      intervalM: 500,
    });
    const session = await runsRepo.startSession(route.id);
    const saved = await runsRepo.save(drive(route, 6)[0] as RunResult, route.id, session.id);
    await routes.update(route.id, { intervalM: 750 });
    expect(await recomputeRoute(db, route.id)).toBe(1);
    expect((await runsRepo.get(saved.id))?.intervalM).toBe(750);
  });

  it('skips runs whose trace is missing and fails for an unknown route', async () => {
    const routes = createRoutesRepo(db);
    const runsRepo = createRunsRepo(db);
    const route = await routes.create({
      name: 'S',
      type: 'stage',
      geometry: windingStage(3000),
      source: 'drawn',
      intervalM: 500,
    });
    const session = await runsRepo.startSession(route.id);
    const [a, b] = drive(route, 3).concat(drive(route, 5));
    const ra = await runsRepo.save(a as RunResult, route.id, session.id);
    const rb = await runsRepo.save(b as RunResult, route.id, session.id);
    await db.traces.delete(rb.traceId);
    await routes.update(route.id, { intervalM: 1000 });
    expect(await recomputeRoute(db, route.id, inlineRunner)).toBe(1);
    expect((await runsRepo.get(ra.id))?.intervalM).toBe(1000);
    expect((await runsRepo.get(rb.id))?.intervalM).toBe(500);
    await expect(recomputeRoute(db, 'nope', inlineRunner)).rejects.toThrow(/not found/);
  });
});

describe('workerRunner (with a stand-in Worker)', () => {
  it('starts the module worker once and returns what the handler returns', async () => {
    const created: { url: string; type: string | undefined }[] = [];
    class FakeWorker {
      constructor(url: URL, opts?: WorkerOptions) {
        created.push({ url: String(url), type: opts?.type });
        const { port1, port2 } = new MessageChannel();
        expose({ recompute: handleRecompute }, port1);
        return port2 as unknown as FakeWorker;
      }
    }
    vi.stubGlobal('Worker', FakeWorker);
    try {
      const { workerRunner } = await import('./recomputeRoute');
      const req: RecomputeRequest = {
        lengthM: circuit.lengthM,
        intervalM: 400,
        runs: drive(circuit, 9).map((r, i) => ({ id: String(i), profile: r.profile })),
      };
      expect(await workerRunner(req)).toEqual(handleRecompute(req));
      expect(await workerRunner({ ...req, intervalM: 800 })).toEqual(
        handleRecompute({ ...req, intervalM: 800 }),
      );
      expect(created).toHaveLength(1); // reused
      expect(created[0]?.url).toMatch(/recompute\.worker\.ts$/);
      expect(created[0]?.type).toBe('module');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is the default runner when Worker exists', async () => {
    let started = 0;
    class CountingWorker {
      constructor() {
        started++;
        const { port1, port2 } = new MessageChannel();
        expose({ recompute: handleRecompute }, port1);
        return port2 as unknown as CountingWorker;
      }
    }
    vi.stubGlobal('Worker', CountingWorker);
    const dbName = `recompute-default-${Math.random()}`;
    const db = openDb(dbName);
    try {
      vi.resetModules(); // fresh module: no worker started yet
      const mod = await import('./recomputeRoute');
      const routes = createRoutesRepo(db);
      const runsRepo = createRunsRepo(db);
      const route = await routes.create({
        name: 'S',
        type: 'stage',
        geometry: windingStage(3000),
        source: 'drawn',
        intervalM: 500,
      });
      const session = await runsRepo.startSession(route.id);
      const saved = await runsRepo.save(drive(route, 8)[0] as RunResult, route.id, session.id);
      await routes.update(route.id, { intervalM: 300 });
      expect(await mod.recomputeRoute(db, route.id)).toBe(1);
      expect(started).toBe(1);
      expect((await runsRepo.get(saved.id))?.intervalM).toBe(300);
    } finally {
      vi.unstubAllGlobals();
      db.close();
      await Dexie.delete(dbName);
    }
  });
});
