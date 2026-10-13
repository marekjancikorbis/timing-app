import Dexie from 'dexie';
import type { RunResult } from '../engine/tracker';
import type { StartMode } from '../engine/types';
import type { LapTimerDb } from './db';
import type { RepoDeps } from './routesRepo';
import type { Run, Session, Trace } from './types';

export interface SectorUpdate {
  id: string;
  intervalM: number;
  sectorMs: number[];
}

export function createRunsRepo(db: LapTimerDb, deps: RepoDeps = {}) {
  const now = deps.now ?? Date.now;
  const newId = deps.id ?? (() => crypto.randomUUID());

  return {
    async startSession(routeId: string, notes?: string): Promise<Session> {
      const session: Session = { id: newId(), routeId, startedAt: now() };
      if (notes) session.notes = notes;
      await db.sessions.add(session);
      return session;
    },

    async setSessionNotes(id: string, notes: string): Promise<void> {
      await db.sessions.update(id, { notes });
    },

    sessions: (routeId: string) => db.sessions.where('routeId').equals(routeId).sortBy('startedAt'),

    /** Store a finished run/lap with its trace and profile, atomically. */
    async save(result: RunResult, routeId: string, sessionId: string): Promise<Run> {
      const traceId = newId();
      const { profile, trace: points, ...fields } = result;
      const run: Run = { ...fields, id: newId(), routeId, sessionId, traceId };
      const trace: Trace = { id: traceId, points, profile };
      await db.transaction('rw', db.runs, db.traces, async () => {
        await db.traces.add(trace);
        await db.runs.add(run);
      });
      return run;
    },

    get: (id: string) => db.runs.get(id),

    getTrace: (traceId: string) => db.traces.get(traceId),

    /** History of a route, oldest first. */
    listByRoute: (routeId: string) =>
      db.runs
        .where('[routeId+startTime]')
        .between([routeId, Dexie.minKey], [routeId, Dexie.maxKey])
        .toArray(),

    /** Fastest valid run for one start mode, via the compound index. */
    async best(
      routeId: string,
      mode: StartMode,
      excludeJumpStarts = true,
    ): Promise<Run | undefined> {
      return db.runs
        .where('[routeId+startMode+totalMs]')
        .between([routeId, mode, Dexie.minKey], [routeId, mode, Dexie.maxKey])
        .filter((r) => r.valid && !(excludeJumpStarts && r.jumpStart))
        .first();
    },

    /** Write recomputed sector times after an interval change. */
    async applySectors(updates: readonly SectorUpdate[]): Promise<void> {
      await db.transaction('rw', db.runs, async () => {
        for (const u of updates) {
          await db.runs.update(u.id, { intervalM: u.intervalM, sectorMs: u.sectorMs });
        }
      });
    },

    async remove(id: string): Promise<void> {
      await db.transaction('rw', db.runs, db.traces, async () => {
        const run = await db.runs.get(id);
        if (!run) return;
        await db.traces.delete(run.traceId);
        await db.runs.delete(id);
      });
    },
  };
}

export type RunsRepo = ReturnType<typeof createRunsRepo>;
