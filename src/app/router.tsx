import { createRootRoute, createRoute, createRouter, Link, Outlet } from '@tanstack/react-router';
import { EditorPage } from '../features/editor/EditorPage';
import { LoggerPage } from '../features/gps-logger/LoggerPage';
import { HistoryPage } from '../features/history/HistoryPage';
import { DrivePage } from '../features/live/DrivePage';
import { RecordPage } from '../features/routes/RecordPage';
import { RoutesPage } from '../features/routes/RoutesPage';
import { SettingsPage } from '../features/settings/SettingsPage';

const nav =
  'rounded px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800 [&.active]:bg-neutral-800 [&.active]:text-white';

function Layout() {
  return (
    <div className="flex h-full flex-col">
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
      </nav>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <Outlet />
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
const rest = [
  createRoute({ getParentRoute: () => rootRoute, path: '/record', component: RecordPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/logger', component: LoggerPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage }),
];

const routeTree = rootRoute.addChildren([...routes, editRoute, driveRoute, historyRoute, ...rest]);
export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
