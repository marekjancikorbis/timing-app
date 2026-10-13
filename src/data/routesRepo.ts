import type { LapTimerDb } from './db';
import { draftFromRoute, type RouteDraft, routeFromDraft } from './routeModel';
import type { Route } from './types';

export interface RepoDeps {
  now?: () => number;
  id?: () => string;
}

export function createRoutesRepo(db: LapTimerDb, deps: RepoDeps = {}) {
  const now = deps.now ?? Date.now;
  const newId = deps.id ?? (() => crypto.randomUUID());

  async function mustGet(id: string): Promise<Route> {
    const r = await db.routes.get(id);
    if (!r) throw new Error(`Route ${id} not found`);
    return r;
  }

  return {
    async create(draft: RouteDraft): Promise<Route> {
      const route = routeFromDraft(draft, newId(), now());
      await db.routes.add(route);
      return route;
    },

    get: (id: string) => db.routes.get(id),

    /** Most recently changed first. */
    list: () => db.routes.orderBy('updatedAt').reverse().toArray(),

    async rename(id: string, name: string): Promise<Route> {
      const r = await mustGet(id);
      const updated = routeFromDraft({ ...draftFromRoute(r), name }, r.id, now(), r.createdAt);
      await db.routes.put(updated);
      return updated;
    },

    /**
     * Change anything about a route. Derived fields (length, gates) are rebuilt.
     * `intervalChanged` tells the caller to recompute the stored runs (§4.2).
     */
    async update(
      id: string,
      patch: Partial<RouteDraft>,
    ): Promise<{ route: Route; intervalChanged: boolean }> {
      const r = await mustGet(id);
      const route = routeFromDraft({ ...draftFromRoute(r), ...patch }, r.id, now(), r.createdAt);
      await db.routes.put(route);
      return { route, intervalChanged: route.intervalM !== r.intervalM };
    },

    /** Deletes the route with all its sessions, runs and traces. */
    async remove(id: string): Promise<void> {
      const tables = [db.routes, db.sessions, db.runs, db.traces, db.referenceChoices];
      await db.transaction('rw', tables, async () => {
        const runs = await db.runs.where('routeId').equals(id).toArray();
        await db.traces.bulkDelete(runs.map((r) => r.traceId));
        await db.runs.where('routeId').equals(id).delete();
        await db.sessions.where('routeId').equals(id).delete();
        await db.referenceChoices.where('routeId').equals(id).delete();
        await db.routes.delete(id);
      });
    },
  };
}

export type RoutesRepo = ReturnType<typeof createRoutesRepo>;
