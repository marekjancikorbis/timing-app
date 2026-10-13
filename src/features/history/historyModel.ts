// History of a route (§3.2 MVP 8, Phase 4): runs grouped by session and start mode, the best run,
// best sectors and the theoretical best. Pure, so it is unit-tested without a database.

import type { Run, Session } from '../../data/types';
import { bestRun, bestSectors, type SectorColor, sectorColor } from '../../engine/delta';
import type { StartMode } from '../../engine/types';

export interface ModeSummary {
  mode: StartMode;
  runCount: number;
  validCount: number;
  best?: Run;
  /** Best time per sector over valid runs (jump starts excluded). */
  bestSectors: number[];
  /** Sum of `bestSectors`, when every sector has a time. */
  theoreticalBestMs?: number;
}

export interface SessionGroup {
  session: Session;
  /** This session's runs of one start mode, in driving order. */
  runs: Run[];
  best?: Run;
}

/**
 * Only runs whose sectors were computed for the route's current interval can be compared sector by
 * sector. After an interval change they are recomputed (§4.2), so this is normally all of them.
 */
export function comparable(runs: readonly Run[], intervalM: number): Run[] {
  return runs.filter((r) => r.intervalM === intervalM);
}

export function summarize(runs: readonly Run[], mode: StartMode, intervalM: number): ModeSummary {
  const ofMode = runs.filter((r) => r.startMode === mode);
  const same = comparable(ofMode, intervalM);
  const sectors = bestSectors(same, mode);
  const sectorCount = Math.max(0, ...same.map((r) => r.sectorMs.length));
  const complete =
    sectors.length > 0 &&
    sectors.length === sectorCount &&
    Array.from(sectors).every(Number.isFinite);
  const summary: ModeSummary = {
    mode,
    runCount: ofMode.length,
    validCount: ofMode.filter((r) => r.valid).length,
    bestSectors: sectors,
  };
  const best = bestRun(ofMode, mode);
  if (best) summary.best = best;
  if (complete) summary.theoreticalBestMs = sectors.reduce((a, b) => a + b, 0);
  return summary;
}

/** Sessions newest first; each with its runs of one start mode. Sessions without any are left out. */
export function groupBySession(
  runs: readonly Run[],
  sessions: readonly Session[],
  mode: StartMode,
): SessionGroup[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const groups = new Map<string, SessionGroup>();
  const ordered = [...runs].sort((a, b) => a.startTime - b.startTime);
  for (const r of ordered) {
    if (r.startMode !== mode) continue;
    let g = groups.get(r.sessionId);
    if (!g) {
      // A run whose session row is missing (e.g. a partial restore) still shows up.
      const session = byId.get(r.sessionId) ?? {
        id: r.sessionId,
        routeId: r.routeId,
        startedAt: r.startTime,
      };
      g = { session, runs: [] };
      groups.set(r.sessionId, g);
    }
    g.runs.push(r);
  }
  const list = [...groups.values()];
  for (const g of list) {
    const best = bestRun(g.runs, mode);
    if (best) g.best = best;
  }
  return list.sort((a, b) => b.session.startedAt - a.session.startedAt);
}

export interface SectorCellView {
  ms: number;
  color: SectorColor;
  estimated: boolean;
}

/**
 * Colours for a run's sectors in the history table: purple = the best of all runs, green/red =
 * faster/slower than the reference run. Runs from another interval get no colours.
 */
export function sectorCells(
  run: Run,
  reference: Run | undefined,
  best: readonly number[],
  intervalM: number,
): SectorCellView[] {
  const sameInterval = run.intervalM === intervalM;
  const ref = reference && reference.intervalM === intervalM ? reference : undefined;
  return run.sectorMs.map((ms, i) => {
    const b = best[i];
    let color: SectorColor = 'neutral';
    if (sameInterval && b !== undefined) {
      // The reference can't be faster or slower than itself.
      color =
        ref?.id === run.id
          ? ms <= b
            ? 'purple'
            : 'neutral'
          : sectorColor(ms, ref?.sectorMs[i], b);
    }
    return { ms, color, estimated: run.sectorFlags[i] === 'estimated' };
  });
}

/** Short label for why a run doesn't count. */
export const INVALID_LABEL: Record<NonNullable<Run['invalidReason']>, string> = {
  'off-route': 'left the route',
  'gps-gap': 'GPS dropped out',
  'user-abort': 'stopped',
  'jump-start': 'jump start',
};

export function runStatus(run: Run): string {
  const parts: string[] = [];
  if (!run.valid) parts.push(INVALID_LABEL[run.invalidReason ?? 'user-abort']);
  else if (run.jumpStart) parts.push('jump start');
  if (run.sectorFlags.includes('estimated')) parts.push('estimated sectors');
  return parts.join(' · ');
}
