import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ll, straightGeometry } from '../../tests/harness';
import type { Fix } from '../engine/filters';
import type { RunResult } from '../engine/tracker';
import { ovalCircuit } from '../gps/simulator';
import { type LapTimerDb, openDb, SCHEMA_VERSIONS } from './db';
import { createGpsLogsRepo } from './gpsLogsRepo';
import { prepareStored, type RouteDraft, routeFromDraft } from './routeModel';
import { createRoutesRepo } from './routesRepo';
import { createRunsRepo } from './runsRepo';
import { createSettingsRepo } from './settingsRepo';
import { DEFAULT_SETTINGS } from './types';

let db: LapTimerDb;
let name: string;
let clock = 1000;
let seq = 0;
const deps = { now: () => clock, id: () => `id-${++seq}` };

beforeEach(async () => {
  name = `test-${Math.random()}`;
  db = openDb(name);
  await db.open();
  clock = 1000;
  seq = 0;
});

afterEach(async () => {
  db.close();
  await Dexie.delete(name);
});

const stageDraft: RouteDraft = {
  name: 'Hill climb',
  type: 'stage',
  geometry: straightGeometry(2000),
  source: 'drawn',
  intervalM: 500,
};

function result(o: Partial<RunResult> = {}): RunResult {
  return {
    lapNumber: 1,
    startMode: 'flying',
    startTime: 5000,
    totalMs: 60_000,
    intervalM: 500,
    sectorMs: [15_000, 15_000, 15_000, 15_000],
    sectorFlags: ['ok', 'ok', 'ok', 'ok'],
    valid: true,
    profile: { s: [0, 2000], t: [0, 60_000] },
    trace: [{ t: 5000, lat: 50, lon: 14, acc: 4, s: 0 }],
    ...o,
  };
}

describe('routeFromDraft', () => {
  it('derives length, gates and per-type defaults', () => {
    const stage = routeFromDraft(stageDraft, 'r1', 10);
    expect(stage.lengthM).toBeCloseTo(2000, 0);
    expect(stage.finishGate).toBeDefined();
    expect(stage.defaultStartMode).toBe('standing');
    expect(stage.defaultCountdownS).toBe(5);
    expect(stage.gateWidthM).toBe(40);

    const circuit = routeFromDraft(
      { ...stageDraft, type: 'circuit', geometry: ovalCircuit(300, 80) },
      'r2',
      10,
    );
    expect(circuit.finishGate).toBeUndefined();
    expect(circuit.defaultStartMode).toBe('flying');
  });

  it('clamps the interval and countdown, trims the name, and rejects bad input', () => {
    const r = routeFromDraft(
      { ...stageDraft, name: '  Pass  ', intervalM: 5000, defaultCountdownS: 20 },
      'x',
      1,
    );
    expect(r).toMatchObject({ name: 'Pass', intervalM: 1000, defaultCountdownS: 10 });
    expect(() => routeFromDraft({ ...stageDraft, name: '  ' }, 'x', 1)).toThrow(/name/);
    expect(() => routeFromDraft({ ...stageDraft, geometry: [ll(0)] }, 'x', 1)).toThrow(
      /two points/,
    );
  });

  it('round-trips into the engine with the same checkpoints', () => {
    const prepared = prepareStored(routeFromDraft(stageDraft, 'r1', 10));
    expect(prepared.checkpoints.map(Math.round)).toEqual([500, 1000, 1500, 2000]);
  });
});

describe('routes repository', () => {
  it('creates, lists newest first, renames and updates', async () => {
    const repo = createRoutesRepo(db, deps);
    const a = await repo.create(stageDraft);
    clock = 2000;
    const b = await repo.create({ ...stageDraft, name: 'Second' });
    expect((await repo.list()).map((r) => r.name)).toEqual(['Second', 'Hill climb']);

    clock = 3000;
    const renamed = await repo.rename(a.id, 'Hill climb (dry)');
    expect(renamed).toMatchObject({ name: 'Hill climb (dry)', createdAt: 1000, updatedAt: 3000 });
    expect((await repo.list())[0]?.id).toBe(a.id);

    const { route, intervalChanged } = await repo.update(b.id, { intervalM: 250 });
    expect(intervalChanged).toBe(true);
    expect(route.intervalM).toBe(250);
    expect((await repo.update(b.id, { gateWidthM: 30 })).intervalChanged).toBe(false);
    expect((await repo.get(b.id))?.gateWidthM).toBe(30);
  });

  it('rebuilds gates and length when the geometry changes', async () => {
    const repo = createRoutesRepo(db, deps);
    const r = await repo.create(stageDraft);
    const { route } = await repo.update(r.id, { geometry: straightGeometry(1200) });
    expect(route.lengthM).toBeCloseTo(1200, 0);
    expect(route.finishGate?.a[0]).not.toBeCloseTo(r.finishGate?.a[0] as number, 6);
  });

  it('throws for unknown routes', async () => {
    const repo = createRoutesRepo(db, deps);
    await expect(repo.rename('nope', 'x')).rejects.toThrow(/not found/);
  });

  it('deletes a route with its sessions, runs and traces, and nothing else', async () => {
    const routes = createRoutesRepo(db, deps);
    const runs = createRunsRepo(db, deps);
    const keep = await routes.create({ ...stageDraft, name: 'Keep' });
    const drop = await routes.create(stageDraft);
    const s1 = await runs.startSession(drop.id);
    const s2 = await runs.startSession(keep.id);
    await runs.save(result(), drop.id, s1.id);
    const kept = await runs.save(result(), keep.id, s2.id);

    await routes.remove(drop.id);
    expect(await routes.get(drop.id)).toBeUndefined();
    expect(await db.runs.count()).toBe(1);
    expect(await db.traces.count()).toBe(1);
    expect(await db.sessions.count()).toBe(1);
    expect(await runs.getTrace(kept.traceId)).toBeDefined();
  });
});

describe('runs repository', () => {
  it('stores a run without its trace, and the trace with the profile', async () => {
    const repo = createRunsRepo(db, deps);
    const session = await repo.startSession('route-1', 'Dry, 18 °C');
    const run = await repo.save(result({ jumpStart: false, countdownS: 5 }), 'route-1', session.id);
    const stored = await repo.get(run.id);
    expect(stored).toMatchObject({
      routeId: 'route-1',
      sessionId: session.id,
      totalMs: 60_000,
      countdownS: 5,
    });
    expect(stored).not.toHaveProperty('trace');
    expect(stored).not.toHaveProperty('profile');
    const trace = await repo.getTrace(run.traceId);
    expect(trace?.profile).toEqual({ s: [0, 2000], t: [0, 60_000] });
    expect(trace?.points).toHaveLength(1);
    expect((await repo.sessions('route-1'))[0]?.notes).toBe('Dry, 18 °C');
    await repo.setSessionNotes(session.id, 'Wet');
    expect((await repo.sessions('route-1'))[0]?.notes).toBe('Wet');
  });

  it('lists history in time order and finds the best valid run per start mode', async () => {
    const repo = createRunsRepo(db, deps);
    const s = await repo.startSession('r');
    await repo.save(result({ startTime: 300, totalMs: 59_000 }), 'r', s.id);
    await repo.save(
      result({ startTime: 100, totalMs: 55_000, valid: false, invalidReason: 'off-route' }),
      'r',
      s.id,
    );
    await repo.save(result({ startTime: 200, totalMs: 58_000, startMode: 'standing' }), 'r', s.id);
    await repo.save(
      result({ startTime: 400, totalMs: 57_000, startMode: 'standing', jumpStart: true }),
      'r',
      s.id,
    );
    await repo.save(result({ startTime: 50, totalMs: 1000 }), 'other-route', s.id);

    expect((await repo.listByRoute('r')).map((x) => x.startTime)).toEqual([100, 200, 300, 400]);
    expect((await repo.best('r', 'flying'))?.totalMs).toBe(59_000); // invalid 55 s skipped
    expect((await repo.best('r', 'standing'))?.totalMs).toBe(58_000); // jump start skipped
    expect((await repo.best('r', 'standing', false))?.totalMs).toBe(57_000);
    expect(await repo.best('nothing', 'flying')).toBeUndefined();
  });

  it('applies recomputed sectors and deletes a run with its trace', async () => {
    const repo = createRunsRepo(db, deps);
    const s = await repo.startSession('r');
    const run = await repo.save(result(), 'r', s.id);
    await repo.applySectors([{ id: run.id, intervalM: 1000, sectorMs: [30_000, 30_000] }]);
    expect(await repo.get(run.id)).toMatchObject({ intervalM: 1000, sectorMs: [30_000, 30_000] });
    await repo.remove(run.id);
    expect(await repo.get(run.id)).toBeUndefined();
    expect(await db.traces.count()).toBe(0);
    await repo.remove('missing'); // no-op
  });
});

describe('settings repository', () => {
  it('returns defaults, then persists partial updates', async () => {
    const repo = createSettingsRepo(db);
    expect(await repo.get()).toEqual(DEFAULT_SETTINGS);
    await repo.update({ theme: 'sunlight' });
    expect(await repo.get()).toEqual({ ...DEFAULT_SETTINGS, theme: 'sunlight' });
  });

  it('fills settings added after a row was stored', async () => {
    await db.settings.put({ key: 'app', units: 'imperial' } as never);
    expect(await createSettingsRepo(db).get()).toEqual({ ...DEFAULT_SETTINGS, units: 'imperial' });
  });
});

describe('GPS logs repository', () => {
  const fix = (t: number): Fix => ({ t, lat: 50, lon: 14, acc: 5 });

  it('creates, appends in batches, lists newest first, renames and deletes', async () => {
    const repo = createGpsLogsRepo(db, deps);
    const a = await repo.create('Morning loop');
    clock = 5000;
    const b = await repo.create('Parked');
    await repo.append(a.id, [fix(1), fix(2)]);
    await repo.append(a.id, [fix(3)]);
    await repo.append(a.id, []);
    expect((await repo.get(a.id))?.fixes.map((f) => f.t)).toEqual([1, 2, 3]);
    expect((await repo.list()).map((l) => l.id)).toEqual([b.id, a.id]);
    await repo.rename(b.id, '  ');
    expect((await repo.get(b.id))?.name).toBe('Untitled log');
    await repo.remove(a.id);
    expect(await repo.get(a.id)).toBeUndefined();
    await expect(repo.append('missing', [fix(1)])).rejects.toThrow(/not found/);
  });
});

describe('production defaults (no injected clock or ids)', () => {
  it('repositories use random UUIDs and the current time', async () => {
    const before = Date.now();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const route = await createRoutesRepo(db).create(stageDraft);
    const runs = createRunsRepo(db);
    const session = await runs.startSession(route.id);
    const run = await runs.save(result(), route.id, session.id);
    const log = await createGpsLogsRepo(db).create('log');
    for (const id of [route.id, session.id, run.id, run.traceId, log.id]) expect(id).toMatch(uuid);
    expect(new Set([route.id, session.id, run.id, run.traceId, log.id]).size).toBe(5);
    for (const t of [route.createdAt, session.startedAt, log.startedAt]) {
      expect(t).toBeGreaterThanOrEqual(before);
      expect(t).toBeLessThanOrEqual(Date.now());
    }
  });

  it('a draft without an interval gets the 100 m default', () => {
    const { intervalM: _omit, ...draft } = stageDraft;
    expect(routeFromDraft(draft, 'x', 1).intervalM).toBe(100);
  });
});

describe('schema versioning', () => {
  it('versions are strictly increasing and the latest is what opens', () => {
    const versions = SCHEMA_VERSIONS.map((v) => v.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(db.verno).toBe(versions.at(-1));
  });

  it('creates the planned indexes (§4.9)', () => {
    const runs = db.table('runs').schema;
    expect(runs.idxByName['[routeId+startMode+totalMs]']).toBeDefined();
    expect(runs.idxByName['[routeId+startTime]']).toBeDefined();
    expect(runs.idxByName.sessionId).toBeDefined();
    expect(db.table('routes').schema.idxByName.updatedAt).toBeDefined();
  });

  it('keeps data across a reopen', async () => {
    await createRoutesRepo(db, deps).create(stageDraft);
    db.close();
    const again = openDb(name);
    expect(await again.routes.count()).toBe(1);
    again.close();
  });

  it('runs upgrade steps on data from the previous version (pattern for future migrations)', async () => {
    await createRoutesRepo(db, deps).create(stageDraft);
    db.close();
    // A hypothetical next version that adds an index and backfills a field.
    const latest = SCHEMA_VERSIONS.at(-1) as (typeof SCHEMA_VERSIONS)[number];
    const next = new Dexie(name) as LapTimerDb;
    for (const v of SCHEMA_VERSIONS) next.version(v.version).stores(v.stores);
    next
      .version(latest.version + 1)
      .stores({ ...latest.stores, routes: 'id, updatedAt, type' })
      .upgrade((tx) =>
        tx
          .table('routes')
          .toCollection()
          .modify((r: { notes?: string }) => {
            r.notes = 'migrated';
          }),
      );
    const [route] = await next.table('routes').where('type').equals('stage').toArray();
    expect(route?.notes).toBe('migrated');
    next.close();
  });
});
