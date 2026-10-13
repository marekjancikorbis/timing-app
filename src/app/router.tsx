import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  useRouterState,
} from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { lazy, Suspense, useEffect, useState } from 'react';
import { LoggerPage } from '../features/gps-logger/LoggerPage';
import { HistoryPage } from '../features/history/HistoryPage';
import { DrivePage } from '../features/live/DrivePage';
import { isOnboarded, needsIosInstallHint, Onboarding } from '../features/onboarding/Onboarding';
import { RoutesPage } from '../features/routes/RoutesPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { InstallButton, PwaBanner } from '../ui/PwaBanner';
import { settingsRepo } from './services';
import { applyTheme } from './theme';

// Pages with the map (MapLibre) or charts (uPlot) load on demand, keeping the first load small.
// The service worker precaches every chunk, so they still open offline.
const EditorPage = lazy(() =>
  import('../features/editor/EditorPage').then((m) => ({ default: m.EditorPage })),
);
const RecordPage = lazy(() =>
  import('../features/routes/RecordPage').then((m) => ({ default: m.RecordPage })),
);
const RunPage = lazy(() =>
  import('../features/analysis/RunPage').then((m) => ({ default: m.RunPage })),
);

const nav =
  'rounded px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800 [&.active]:bg-neutral-800 [&.active]:text-neutral-50';

function Layout() {
  const driving = useRouterState({ select: (s) => s.location.pathname.startsWith('/drive/') });
  const theme = useLiveQuery(async () => (await settingsRepo.get()).theme, []);
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);
  const [onboarded, setOnboarded] = useState(isOnboarded);
  return (
    <div className="flex h-full flex-col">
      <PwaBanner quiet={driving} />
      <nav className="flex items-center gap-1 border-b border-neutral-800 px-3 py-2">
        <span className="mr-3 font-semibold text-amber-400">Lap Timer</span>
        <Link to="/" className={nav} activeOptions={{ exact: true }}>
          Routes
        </Link>
        <Link to="/logger" className={nav}>
          GPS logger
        </Link>
        <Link to="/settings" className={nav}>
          Settings
        </Link>
        <span className="ml-auto">
          <InstallButton />
        </span>
      </nav>
      <main className="min-h-0 flex-1 overflow-y-auto">
        {onboarded ? (
          <Suspense fallback={<p className="p-4 text-neutral-400">Loading…</p>}>
            <Outlet />
          </Suspense>
        ) : (
          <Onboarding onDone={() => setOnboarded(true)} iosHint={needsIosInstallHint()} />
        )}
      </main>
      <footer className="border-t border-neutral-800 px-3 py-1 text-[11px] text-neutral-500">
        For closed tracks and closed roads only. Don't look at the screen while driving.
      </footer>
    </div>
  );
}

const rootRoute = createRootRoute({ component: Layout });
const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: RoutesPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/routes/new',
    component: () => <EditorPage key="new" />,
  }),
];
const editRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/routes/$routeId',
  component: function EditRoute() {
    const { routeId } = editRoute.useParams();
    return <EditorPage key={routeId} routeId={routeId} />;
  },
});
const driveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/drive/$routeId',
  component: function Drive() {
    const { routeId } = driveRoute.useParams();
    return <DrivePage key={routeId} routeId={routeId} />;
  },
});
const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/routes/$routeId/history',
  component: function History() {
    const { routeId } = historyRoute.useParams();
    return <HistoryPage key={routeId} routeId={routeId} />;
  },
});
const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs/$runId',
  validateSearch: (search: Record<string, unknown>): { vs?: string } =>
    typeof search.vs === 'string' ? { vs: search.vs } : {},
  component: function RunDetail() {
    const { runId } = runRoute.useParams();
    const { vs } = runRoute.useSearch();
    return <RunPage key={runId} runId={runId} vs={vs} />;
  },
});
const rest = [
  createRoute({ getParentRoute: () => rootRoute, path: '/record', component: RecordPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/logger', component: LoggerPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage }),
];

const routeTree = rootRoute.addChildren([
  ...routes,
  editRoute,
  driveRoute,
  historyRoute,
  runRoute,
  ...rest,
]);
export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
