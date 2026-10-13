import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { routesRepo, runsRepo, settingsRepo } from '../../app/services';
import type { Route } from '../../data/types';
import { systemClock } from '../../engine/clock';
import { unlockAudio } from '../../feedback/audio';
import { browserFeedback } from '../../feedback/browserFeedback';
import { BrowserGps } from '../../gps/browserGps';
import { testGpsFromUrl } from '../../gps/testGps';
import { DriveView } from './DriveView';
import { createTimingSession, type TimingSession } from './session';

/** Thin shell: builds a timing session with the device GPS and real feedback, then shows it. */
export function DrivePage({ routeId }: { routeId: string }) {
  const [loaded, setLoaded] = useState<{ route: Route; session: TimingSession } | 'missing' | null>(
    null,
  );

  useEffect(() => {
    let disposed = false;
    let session: TimingSession | null = null;
    void (async () => {
      const route = await routesRepo.get(routeId);
      if (!route) {
        if (!disposed) setLoaded('missing');
        return;
      }
      const settings = await settingsRepo.get();
      const s = await createTimingSession({
        route,
        gps: testGpsFromUrl() ?? new BrowserGps(),
        clock: systemClock,
        runsRepo,
        settings,
        feedback: browserFeedback,
      });
      if (disposed) {
        s.dispose();
        return;
      }
      session = s;
      setLoaded({ route, session: s });
    })();
    return () => {
      disposed = true;
      session?.dispose();
    };
  }, [routeId]);

  if (loaded === 'missing') {
    return (
      <div className="p-4">
        <p>This route no longer exists.</p>
        <Link to="/" className="text-amber-400 underline">
          Back to routes
        </Link>
      </div>
    );
  }
  if (!loaded) return <p className="p-4 text-neutral-400">Loading…</p>;
  return (
    <>
      <DriveView
        route={loaded.route}
        session={loaded.session}
        clock={systemClock}
        runsRepo={runsRepo}
        onStartTap={() => unlockAudio()}
      />
      <p className="mx-auto max-w-xl px-4 pb-4">
        <Link
          to="/routes/$routeId/history"
          params={{ routeId }}
          className="text-sm text-amber-400 underline"
        >
          Full history and analysis
        </Link>
      </p>
    </>
  );
}
