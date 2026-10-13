import type { Fix } from '../engine/filters';
import type { LapTimerDb } from './db';
import type { RepoDeps } from './routesRepo';
import type { GpsLog } from './types';

/** Phase 0 logs. Fixes are appended in batches so a crash loses at most one batch. */
export function createGpsLogsRepo(db: LapTimerDb, deps: RepoDeps = {}) {
  const now = deps.now ?? Date.now;
  const newId = deps.id ?? (() => crypto.randomUUID());

  return {
    async create(name: string): Promise<GpsLog> {
      const t = now();
      const log: GpsLog = { id: newId(), name, startedAt: t, updatedAt: t, fixes: [] };
      await db.gpsLogs.add(log);
      return log;
    },

    async append(id: string, fixes: readonly Fix[]): Promise<void> {
      if (fixes.length === 0) return;
      await db.transaction('rw', db.gpsLogs, async () => {
        const log = await db.gpsLogs.get(id);
        if (!log) throw new Error(`GPS log ${id} not found`);
        await db.gpsLogs.update(id, { fixes: [...log.fixes, ...fixes], updatedAt: now() });
      });
    },

    get: (id: string) => db.gpsLogs.get(id),

    /** Newest first. */
    list: () => db.gpsLogs.orderBy('startedAt').reverse().toArray(),

    async rename(id: string, name: string): Promise<void> {
      await db.gpsLogs.update(id, { name: name.trim() || 'Untitled log' });
    },

    remove: (id: string) => db.gpsLogs.delete(id),
  };
}
