import { type Remote, wrap } from 'comlink';
import type { LapTimerDb } from '../data/db';
import { createRunsRepo } from '../data/runsRepo';
import { handleRecompute, type RecomputeRequest, type RecomputeResult } from './recompute';
import type { RecomputeWorkerApi } from './recompute.worker';

export type RecomputeRunner = (
  req: RecomputeRequest,
) => Promise<RecomputeResult[]> | RecomputeResult[];

/** Runs the recompute on the calling thread (tests, or browsers without module workers). */
export const inlineRunner: RecomputeRunner = handleRecompute;

let worker: Remote<RecomputeWorkerApi> | null = null;

/** Runs the recompute in a shared Web Worker. */
export const workerRunner: RecomputeRunner = (req) => {
  worker ??= wrap<RecomputeWorkerApi>(
    new Worker(new URL('./recompute.worker.ts', import.meta.url), { type: 'module' }),
  );
  return worker.recompute(req);
};

/**
 * After a route's interval changes: recompute every stored run of the route from its trace
 * profile and write the new sector times. Returns how many runs were updated.
 */
export async function recomputeRoute(
  db: LapTimerDb,
  routeId: string,
  runner: RecomputeRunner = typeof Worker !== 'undefined' ? workerRunner : inlineRunner,
): Promise<number> {
  const route = await db.routes.get(routeId);
  if (!route) throw new Error(`Route ${routeId} not found`);
  const runs = await db.runs.where('routeId').equals(routeId).toArray();
  const stale = runs.filter((r) => r.intervalM !== route.intervalM);
  if (stale.length === 0) return 0;
  const traces = await db.traces.bulkGet(stale.map((r) => r.traceId));
  const withProfiles = stale.flatMap((r, i) => {
    const t = traces[i];
    return t ? [{ id: r.id, profile: t.profile }] : [];
  });
  const results = await runner({
    lengthM: route.lengthM,
    intervalM: route.intervalM,
    runs: withProfiles,
  });
  await createRunsRepo(db).applySectors(results);
  return results.length;
}
