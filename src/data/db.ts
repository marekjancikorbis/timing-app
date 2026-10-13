// Dexie schema (§4.9). IndexedDB is the source of truth on the device.

import Dexie, { type EntityTable } from 'dexie';
import type { GpsLog, Route, Run, Session, Settings, Trace } from './types';

export interface SettingsRow extends Settings {
  key: 'app';
}

export type LapTimerDb = Dexie & {
  routes: EntityTable<Route, 'id'>;
  sessions: EntityTable<Session, 'id'>;
  runs: EntityTable<Run, 'id'>;
  traces: EntityTable<Trace, 'id'>;
  settings: EntityTable<SettingsRow, 'key'>;
  gpsLogs: EntityTable<GpsLog, 'id'>;
};

/**
 * Schema versions, oldest first. Never edit a shipped version: add a new one with an `upgrade`
 * that converts existing rows (see `db.test.ts` for how each step is tested).
 */
export const SCHEMA_VERSIONS: { version: number; stores: Record<string, string> }[] = [
  {
    version: 1,
    stores: {
      routes: 'id, updatedAt',
      sessions: 'id, routeId, startedAt',
      runs: 'id, sessionId, routeId, [routeId+startMode+totalMs], [routeId+startTime]',
      traces: 'id',
      settings: 'key',
      gpsLogs: 'id, startedAt',
    },
  },
];

export const DB_NAME = 'laptimer';

export function openDb(name = DB_NAME): LapTimerDb {
  const db = new Dexie(name) as LapTimerDb;
  for (const v of SCHEMA_VERSIONS) db.version(v.version).stores(v.stores);
  return db;
}

let shared: LapTimerDb | null = null;

/** The app's database (opened lazily so tests can use their own). */
export function getDb(): LapTimerDb {
  shared ??= openDb();
  return shared;
}

/** Ask the browser not to evict our data (R10). Returns whether storage is persistent. */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
