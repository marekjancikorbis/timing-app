import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { usePending } from '../../app/pending';
import { routesRepo, settingsRepo } from '../../app/services';
import { GpxImport } from './GpxImport';
import { RouteList } from './RouteList';

export function RoutesPage() {
  const routes = useLiveQuery(() => routesRepo.list(), []);
  const settings = useLiveQuery(() => settingsRepo.get(), []);
  const navigate = useNavigate();
  const setPending = usePending((s) => s.set);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-semibold">Routes</h1>
        <Link
          to="/routes/new"
          className="rounded bg-amber-400 px-3 py-2 font-medium text-neutral-950"
        >
          New route
        </Link>
        <Link
          to="/record"
          className="rounded border border-neutral-700 px-3 py-2 hover:bg-neutral-800"
        >
          Record by driving
        </Link>
        <GpxImport
          onPick={(candidate) => {
            setPending({ type: 'importGpx', candidate });
            void navigate({ to: '/routes/new' });
          }}
        />
      </header>
      {routes === undefined ? (
        <p className="text-neutral-400">Loading…</p>
      ) : (
        <RouteList
          routes={routes}
          units={settings?.units}
          onOpen={(id) => void navigate({ to: '/routes/$routeId', params: { routeId: id } })}
          onRename={(id, name) => void routesRepo.rename(id, name)}
          onDelete={(id) => void routesRepo.remove(id)}
          onDrive={(id) => void navigate({ to: '/drive/$routeId', params: { routeId: id } })}
        />
      )}
    </div>
  );
}
