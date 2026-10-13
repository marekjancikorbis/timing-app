import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { routesRepo, runsRepo } from '../../app/services';
import { downloadFile } from '../../ui/download';
import { historyToCsv, routeToGpx, safeFileName } from '../export/exporters';
import { HistoryView } from './HistoryView';

/** Thin shell: loads the route's runs and sessions live from Dexie. */
export function HistoryPage({ routeId }: { routeId: string }) {
  const navigate = useNavigate();
  const data = useLiveQuery(async () => {
    const route = await routesRepo.get(routeId);
    if (!route) return 'missing' as const;
    const [runs, sessions, flying, standing] = await Promise.all([
      runsRepo.listByRoute(routeId),
      runsRepo.sessions(routeId),
      runsRepo.referenceChoice(routeId, 'flying'),
      runsRepo.referenceChoice(routeId, 'standing'),
    ]);
    // A pinned run is the reference; otherwise the view uses the best run.
    const pinned = (c: { kind: string; runId?: string }) =>
      c.kind === 'run' ? runs.find((r) => r.id === c.runId) : undefined;
    return {
      route,
      runs,
      sessions,
      referenceKind: { flying: flying.kind, standing: standing.kind },
      reference: { flying: pinned(flying), standing: pinned(standing) },
    };
  }, [routeId]);

  if (data === undefined) return <p className="p-4 text-neutral-400">Loading…</p>;
  if (data === 'missing') {
    return (
      <div className="p-4">
        <p>This route no longer exists.</p>
        <Link to="/" className="text-amber-400 underline">
          Back to routes
        </Link>
      </div>
    );
  }

  const { route, runs, sessions, reference, referenceKind } = data;
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-semibold">{route.name}: history</h1>
        <Link
          to="/drive/$routeId"
          params={{ routeId }}
          className="rounded bg-amber-400 px-3 py-2 font-medium text-neutral-950"
        >
          Drive
        </Link>
        <Link
          to="/routes/$routeId"
          params={{ routeId }}
          className="rounded border border-neutral-700 px-3 py-2 hover:bg-neutral-800"
        >
          Edit route
        </Link>
        <button
          type="button"
          onClick={() =>
            downloadFile(
              `${safeFileName(route.name)} history.csv`,
              historyToCsv(route, runs),
              'text/csv',
            )
          }
          className="rounded border border-neutral-700 px-3 py-2 hover:bg-neutral-800"
        >
          Export CSV
        </button>
        <button
          type="button"
          onClick={() =>
            downloadFile(
              `${safeFileName(route.name)}.gpx`,
              routeToGpx(route),
              'application/gpx+xml',
            )
          }
          className="rounded border border-neutral-700 px-3 py-2 hover:bg-neutral-800"
        >
          Route GPX
        </button>
      </header>
      <HistoryView
        route={route}
        runs={runs}
        sessions={sessions}
        reference={reference}
        referenceKind={referenceKind}
        onReferenceKind={(mode, kind) => void runsRepo.setReferenceChoice(routeId, mode, kind)}
        onOpenRun={(id) => void navigate({ to: '/runs/$runId', params: { runId: id } })}
        onCompare={(a, b) =>
          void navigate({ to: '/runs/$runId', params: { runId: a }, search: { vs: b } })
        }
        onDeleteRun={(id) => void runsRepo.remove(id)}
        onSessionNotes={(id, notes) => void runsRepo.setSessionNotes(id, notes)}
      />
    </div>
  );
}
