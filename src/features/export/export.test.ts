// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { strToU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE_T, ll, straightGeometry } from '../../../tests/harness';
import { type LapTimerDb, openDb } from '../../data/db';
import { createRoutesRepo } from '../../data/routesRepo';
import { createRunsRepo } from '../../data/runsRepo';
import { createSettingsRepo } from '../../data/settingsRepo';
import type { Route, Run, Trace } from '../../data/types';
import type { RunResult } from '../../engine/tracker';
import { parseGpx } from '../routes/gpx';
import {
  BACKUP_FORMAT,
  backupFileName,
  createBackup,
  decodeBackup,
  encodeBackup,
  restoreBackup,
} from './backup';
import { historyToCsv, routeToGpx, runToCsv, runToGpx, safeFileName } from './exporters';

let db: LapTimerDb;
let name: string;
let seq = 0;
const deps = { now: () => BASE_T, id: () => `id-${++seq}` };

beforeEach(async () => {
  name = `export-${Math.random()}`;
  db = openDb(name);
  await db.open();
  seq = 0;
});
afterEach(async () => {
  db.close();
  await Dexie.delete(name);
});

function result(o: Partial<RunResult> = {}): RunResult {
  const trace = [0, 250, 500, 750, 1000].map((x, i) => {
    const [lon, lat] = ll(x);
    return { t: BASE_T + i * 10_000, lat, lon, acc: 4, spd: 25, s: x };
  });
  return {
    lapNumber: 1,
    startMode: 'standing',
    startTime: BASE_T,
    totalMs: 40_000,
    intervalM: 500,
    sectorMs: [20_000, 20_000],
    sectorFlags: ['ok', 'ok'],
    valid: true,
    profile: { s: [0, 1000], t: [0, 40_000] },
    trace: [{ t: BASE_T - 1000, lat: 1, lon: 1, acc: 80, rej: 'accuracy' }, ...trace],
    ...o,
  };
}

async function seed(): Promise<{ route: Route; run: Run; trace: Trace }> {
  const route = await createRoutesRepo(db, deps).create({
    name: 'Hill "climb", <east>',
    type: 'stage',
    geometry: straightGeometry(1000),
    source: 'drawn',
    intervalM: 500,
  });
  const runs = createRunsRepo(db, deps);
  const session = await runs.startSession(route.id, 'Dry');
  const run = await runs.save(result(), route.id, session.id);
  await runs.setReferenceChoice(route.id, 'standing', 'run', run.id);
  const trace = (await runs.getTrace(run.traceId)) as Trace;
  return { route, run, trace };
}

describe('GPX export', () => {
  it('a run trace round-trips through the GPX importer, without rejected fixes', async () => {
    const { route, run, trace } = await seed();
    const text = runToGpx(run, trace, route.name);
    expect(text).toContain('<time>');
    expect(text).toContain('Hill &quot;climb&quot;, &lt;east&gt;');
    const parsed = parseGpx(text);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]?.lengthM).toBeCloseTo(1000, 0);
  });

  it('a route round-trips through the GPX importer', async () => {
    const { route } = await seed();
    const parsed = parseGpx(routeToGpx(route));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.candidates[0]?.name).toBe(route.name);
    expect(parsed.candidates[0]?.lengthM).toBeCloseTo(route.lengthM, 0);
  });
});

describe('CSV export', () => {
  it('lists every fix of a run, rejected ones marked', async () => {
    const { run, trace } = await seed();
    const lines = runToCsv(run, trace).trim().split('\n');
    expect(lines[0]).toBe('time_s,lat,lon,accuracy_m,speed_mps,distance_m,rejected');
    expect(lines).toHaveLength(7);
    expect(lines[1]).toMatch(/^-1\.000,1\.0000000,1\.0000000,80,,,accuracy$/);
    expect(lines[2]).toMatch(/^0\.000,.*,4,25\.00,0,$/);
  });

  it('lists the history with sector times', async () => {
    const { route, run } = await seed();
    const slow: Run = { ...run, id: 'x', totalMs: 41_500, valid: false, invalidReason: 'gps-gap' };
    const lines = historyToCsv(route, [run, slow]).trim().split('\n');
    expect(lines[0]).toBe(
      'start,start_mode,lap,total_s,valid,invalid_reason,jump_start,interval_m,s1_to_500m,s2_to_1000m',
    );
    expect(lines[1]).toBe(
      `${new Date(BASE_T).toISOString()},standing,1,40.000,yes,,,500,20.000,20.000`,
    );
    expect(lines[2]).toContain(',41.500,no,gps-gap,');
  });

  it('makes safe file names', () => {
    expect(safeFileName('Hill: "climb" / 2')).toBe('Hill_ _climb_ _ 2');
    expect(safeFileName('  ')).toBe('export');
  });
});

describe('backup', () => {
  it('round-trips all data through a gzip file into an empty database', async () => {
    await seed();
    await createSettingsRepo(db).update({ units: 'imperial', orsApiKey: 'secret' });
    const backup = await createBackup(db, BASE_T);
    expect(backup.settings).not.toHaveProperty('orsApiKey'); // never written to the file
    const bytes = encodeBackup(backup);
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);

    const other = openDb(`${name}-restore`);
    await other.open();
    try {
      await createSettingsRepo(other).update({ orsApiKey: 'mine' });
      const decoded = decodeBackup(bytes);
      if (!decoded.ok) throw new Error(decoded.error);
      expect(await restoreBackup(other, decoded.backup, 'replace')).toEqual({
        routes: 1,
        runs: 1,
        gpsLogs: 0,
      });
      expect(await other.routes.toArray()).toEqual(await db.routes.toArray());
      expect(await other.runs.toArray()).toEqual(await db.runs.toArray());
      expect(await other.traces.toArray()).toEqual(await db.traces.toArray());
      expect(await other.sessions.toArray()).toEqual(await db.sessions.toArray());
      expect(await other.referenceChoices.count()).toBe(1);
      const settings = await createSettingsRepo(other).get();
      expect(settings).toMatchObject({ units: 'imperial', orsApiKey: 'mine' });
    } finally {
      other.close();
      await Dexie.delete(`${name}-restore`);
    }
  });

  it('merge keeps existing data; replace removes it', async () => {
    const { route } = await seed();
    const backup = await createBackup(db);
    await createRoutesRepo(db, deps).create({
      name: 'Other',
      type: 'stage',
      geometry: straightGeometry(500),
      source: 'drawn',
    });
    await restoreBackup(db, backup, 'merge');
    expect(await db.routes.count()).toBe(2);
    await restoreBackup(db, backup, 'replace');
    expect((await db.routes.toArray()).map((r) => r.id)).toEqual([route.id]);
  });

  it('accepts plain JSON and rejects anything else with a readable error', async () => {
    await seed();
    const backup = await createBackup(db);
    expect(decodeBackup(strToU8(JSON.stringify(backup))).ok).toBe(true);
    expect(decodeBackup(strToU8('hello'))).toEqual({
      ok: false,
      error: 'This is not a Lap Timer backup (not JSON).',
    });
    expect(decodeBackup(strToU8('{"format":"other"}'))).toMatchObject({ ok: false });
    expect(decodeBackup(new Uint8Array([0x1f, 0x8b, 1, 2, 3]))).toMatchObject({
      ok: false,
      error: expect.stringContaining('damaged'),
    });
    const newer = { ...backup, version: 99 };
    expect(decodeBackup(strToU8(JSON.stringify(newer)))).toMatchObject({
      error: expect.stringContaining('newer version'),
    });
    const broken = { ...backup, runs: [{ ...backup.runs[0], totalMs: 'fast' }] };
    const r = decodeBackup(strToU8(JSON.stringify(broken)));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('runs.0.totalMs') });
    expect(backup.format).toBe(BACKUP_FORMAT);
  });

  it('names the file by date', () => {
    expect(backupFileName(Date.UTC(2026, 9, 13))).toBe('laptimer-backup-2026-10-13.json.gz');
  });
});
