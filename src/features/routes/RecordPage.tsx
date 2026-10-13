import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { usePending } from '../../app/pending';
import type { RouteType } from '../../engine/route';
import { BrowserGps } from '../../gps/browserGps';
import type { GpsStatus } from '../../gps/GpsSource';
import { formatDistance } from '../editor/preview';
import { type RecorderStatus, RouteRecorder } from './recorder';

/** Drive the route once with the phone mounted; the recording becomes the route line. */
export function RecordPage() {
  const navigate = useNavigate();
  const setPending = usePending((s) => s.set);
  const gps = useRef<BrowserGps | null>(null);
  const recorder = useRef(new RouteRecorder());
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState<RecorderStatus>(recorder.current.status());
  const [gpsStatus, setGpsStatus] = useState<{ status: GpsStatus; message?: string }>({
    status: 'idle',
  });
  const [lastAcc, setLastAcc] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => gps.current?.stop(), []);

  const start = async () => {
    recorder.current = new RouteRecorder();
    setStatus(recorder.current.status());
    setError(null);
    const source = new BrowserGps();
    gps.current = source;
    source.onStatus((status, message) => setGpsStatus({ status, message }));
    source.subscribe((fix) => {
      recorder.current.push(fix);
      setLastAcc(fix.acc);
      setStatus(recorder.current.status());
    });
    await source.start();
    setRecording(true);
  };

  const stop = () => {
    gps.current?.stop();
    gps.current = null;
    setRecording(false);
  };

  const finish = (type: RouteType | 'auto') => {
    const r = recorder.current.finish(type);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    stop();
    setPending({ type: 'importRecording', geometry: r.geometry, routeType: r.type });
    void navigate({ to: '/routes/new' });
  };

  return (
    <div className="mx-auto max-w-xl space-y-5 p-4">
      <Link to="/" className="text-sm text-neutral-400 hover:text-neutral-200">
        ← Routes
      </Link>
      <h1 className="text-2xl font-semibold">Record a route</h1>
      <p className="text-sm text-neutral-400">
        Start recording, then drive the route: one full lap for a circuit (back past where you
        started), or the stage from start to finish. Keep the screen on. You can edit the line
        afterwards.
      </p>

      <dl className="grid grid-cols-2 gap-3 text-lg">
        <div>
          <dt className="text-xs text-neutral-400">Distance</dt>
          <dd data-testid="rec-length">{formatDistance(status.lengthM)}</dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-400">Back to start</dt>
          <dd>{status.points ? formatDistance(status.distanceToStartM) : '–'}</dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-400">GPS</dt>
          <dd>
            {gpsStatus.status}
            {lastAcc !== null && ` · ±${lastAcc.toFixed(0)} m`}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-neutral-400">Lap</dt>
          <dd>{status.lapClosed ? 'closed ✓' : 'open'}</dd>
        </div>
      </dl>
      {gpsStatus.message && <p className="text-sm text-red-400">{gpsStatus.message}</p>}
      {status.rejected > 0 && (
        <p className="text-xs text-neutral-400">{status.rejected} inaccurate fixes ignored</p>
      )}

      <div className="flex flex-wrap gap-2">
        {!recording ? (
          <button
            type="button"
            onClick={() => void start()}
            className="rounded bg-red-600 text-white px-4 py-2 font-medium"
          >
            {status.points ? 'Start over' : 'Start recording'}
          </button>
        ) : (
          <button
            type="button"
            onClick={stop}
            className="rounded border border-neutral-700 px-4 py-2"
          >
            Pause
          </button>
        )}
        <button
          type="button"
          disabled={status.points < 2}
          onClick={() => finish('auto')}
          className="rounded bg-amber-400 px-4 py-2 font-medium text-black disabled:opacity-40"
        >
          Use as {status.lapClosed ? 'circuit' : 'stage'}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
