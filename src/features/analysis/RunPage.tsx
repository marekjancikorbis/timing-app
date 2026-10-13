import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { routesRepo, runsRepo } from '../../app/services';
import { downloadFile } from '../../ui/download';
import { runToCsv, runToGpx, safeFileName } from '../export/exporters';
import { defaultReference } from './analysis';
import { RunView } from './RunView';

/**
 * Thin shell for one run. `vs` picks the run to compare with: a run id, 'none', or (unset) the
 * default reference. Comparing two runs is this page with `vs` set.
 */
export function RunPage({ runId, vs }: { runId: string; vs?: string }) {
  const navigate = useNavigate();
  const data = useLiveQuery(async () => {
    const run = await runsRepo.get(runId);
    const route = run && (await routesRepo.get(run.routeId));
    if (!run || !route) return 'missing' as const;
    const candidates = (await runsRepo.listByRoute(route.id)).reverse();
    const refRun =
      vs === 'none'
        ? undefined
        : vs
          ? candidates.find((c) => c.id === vs)
          : defaultReference(run, candidates);
    const [trace, refTrace, choice] = await Promise.all([
      runsRepo.getTrace(run.traceId),
      refRun ? runsRepo.getTrace(refRun.traceId) : undefined,
      runsRepo.referenceChoice(route.id, run.startMode),
    ]);
    return {
      route,
      pinned: choice.kind === 'run' && choice.runId === run.id,
      candidates,
      current: { run, trace },
      reference: refRun ? { run: refRun, trace: refTrace } : undefined,
    };
  }, [runId, vs]);

  if (data === undefined) return <p className="p-4 text-neutral-400">Loading…</p>;
  if (data === 'missing') {
    return (
      <div className="p-4">
        <p>This run no longer exists.</p>
        <Link to="/" className="text-amber-400 underline">
          Back to routes
        </Link>
      </div>
    );
  }

  const { route, pinned } = data;
  const { run, trace } = data.current;
  const fileBase = safeFileName(
    `${route.name} ${new Date(run.startTime).toISOString().slice(0, 16)}`,
  );
  const btn = 'rounded border border-neutral-700 px-3 py-2 hover:bg-neutral-800';
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-lg text-neutral-400">{route.name}</h1>
        <Link
          to="/routes/$routeId/history"
          params={{ routeId: route.id }}
          className="rounded border border-neutral-700 px-3 py-2 hover:bg-neutral-800"
        >
          History
        </Link>
      </header>
      <RunView
        route={route}
        current={data.current}
        reference={data.reference}
        candidates={data.candidates}
        actions={
          <div className="flex flex-wrap gap-2">
            {pinned ? (
              <button
                type="button"
                onClick={() => void runsRepo.setReferenceChoice(route.id, run.startMode, 'best')}
                className="rounded border border-amber-400 px-3 py-2 text-amber-400"
              >
                Pinned as live reference · unpin
              </button>
            ) : (
              <button
                type="button"
                onClick={() =>
                  void runsRepo.setReferenceChoice(route.id, run.startMode, 'run', run.id)
                }
                className="rounded border border-neutral-700 px-3 py-2 hover:bg-neutral-800"
              >
                Pin as live reference
              </button>
            )}
            {trace && (
              <>
                <button
                  type="button"
                  className={btn}
                  onClick={() =>
                    downloadFile(
                      `${fileBase}.gpx`,
                      runToGpx(run, trace, route.name),
                      'application/gpx+xml',
                    )
                  }
                >
                  Export GPX
                </button>
                <button
                  type="button"
                  className={btn}
                  onClick={() => downloadFile(`${fileBase}.csv`, runToCsv(run, trace), 'text/csv')}
                >
                  Export CSV
                </button>
              </>
            )}
          </div>
        }
        onPickReference={(id) =>
          void navigate({
            to: '/runs/$runId',
            params: { runId },
            search: { vs: id ?? 'none' },
            replace: true,
          })
        }
      />
    </div>
  );
}
