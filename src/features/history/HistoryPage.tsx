import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { routesRepo, runsRepo } from '../../app/services';
import { HistoryView } from './HistoryView';

/** Thin shell: loads the route's runs and sessions live from Dexie. */
export function HistoryPage({ routeId }: { routeId: string }) {
  const data = useLiveQuery(async () => {
    const route = await routesRepo.get(routeId);
    if (!route) return 'missing' as const;
    const [runs, sessions] = await Promise.all([
      runsRepo.listByRoute(routeId),
      runsRepo.sessions(routeId),
    ]);
    return { route, runs, sessions };
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

  const { route, runs, sessions } = data;
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
      </header>
      <HistoryView
        route={route}
        runs={runs}
        sessions={sessions}
        onDeleteRun={(id) => void runsRepo.remove(id)}
        onSessionNotes={(id, notes) => void runsRepo.setSessionNotes(id, notes)}
      />
    </div>
  );
}
