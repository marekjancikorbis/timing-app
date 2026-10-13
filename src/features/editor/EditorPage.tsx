import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useReducer, useState } from 'react';
import { usePending } from '../../app/pending';
import { db, routesRepo, settingsRepo } from '../../app/services';
import { requestPersistentStorage } from '../../data/db';
import { COUNTDOWN_MAX_S, COUNTDOWN_MIN_S } from '../../engine/countdown';
import { recomputeRoute } from '../../workers/recomputeRoute';
import { MapView } from '../map/MapView';
import { GpxImport } from '../routes/GpxImport';
import {
  editorPreview,
  editorReducer,
  editorToDraft,
  GATE_WIDTH_RANGE,
  initialEditorState,
  saveBlocker,
} from './editorState';
import { IntervalSlider } from './IntervalSlider';
import { formatDistance, previewGeoJson, sectorSummary } from './preview';
import { snapToRoads } from './snap';

const btn =
  'rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:opacity-40';
const seg = (on: boolean) =>
  `px-3 py-1.5 text-sm ${on ? 'bg-amber-400 text-neutral-950' : 'bg-neutral-900 hover:bg-neutral-800'}`;

export function EditorPage({ routeId }: { routeId?: string }) {
  const [state, dispatch] = useReducer(editorReducer, undefined, () => initialEditorState());
  const settings = useLiveQuery(() => settingsRepo.get(), []);
  const navigate = useNavigate();
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);
  const units = settings?.units ?? 'metric';

  // Load a saved route, or apply a pending import / recording.
  useEffect(() => {
    if (routeId) {
      void routesRepo
        .get(routeId)
        .then((r) => (r ? dispatch({ type: 'load', route: r }) : setNotFound(true)));
    } else {
      const pending = usePending.getState().take();
      if (pending) dispatch(pending);
    }
  }, [routeId]);

  const preview = useMemo(() => editorPreview(state), [state]);
  const overlay = useMemo(
    () =>
      preview.ok
        ? previewGeoJson(
            {
              type: state.type,
              geometry: state.geometry,
              intervalM: state.intervalM,
              gateWidthM: state.gateWidthM,
            },
            preview.preview,
          )
        : null,
    [preview, state.type, state.geometry, state.intervalM, state.gateWidthM],
  );
  const blocker = saveBlocker(state);

  const snap = async () => {
    dispatch({ type: 'snapStarted' });
    const r = await snapToRoads(state.waypoints, settings?.orsApiKey);
    dispatch(
      r.ok
        ? { type: 'snapSucceeded', geometry: r.geometry }
        : { type: 'snapFailed', error: r.error },
    );
  };

  const save = async () => {
    setSaving(true);
    try {
      const draft = editorToDraft(state);
      if (state.routeId) {
        const { route, intervalChanged } = await routesRepo.update(state.routeId, draft);
        if (intervalChanged) await recomputeRoute(db, route.id);
        dispatch({ type: 'saved', route });
      } else {
        const route = await routesRepo.create(draft);
        dispatch({ type: 'saved', route });
        // Ask the browser not to evict our data (R10) once there is something worth keeping.
        // Chrome decides silently; nothing to show if it says no (Settings explains backups).
        requestPersistentStorage().catch(() => {});
        void navigate({ to: '/routes/$routeId', params: { routeId: route.id }, replace: true });
      }
    } catch (e) {
      dispatch({ type: 'snapFailed', error: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  if (notFound) {
    return (
      <div className="p-4">
        <p>This route no longer exists.</p>
        <Link to="/" className="text-amber-400 underline">
          Back to routes
        </Link>
      </div>
    );
  }

  const hint =
    state.mode === 'snap'
      ? 'Click the map to place the start, any via points, and the finish. Then snap to roads.'
      : state.geometry.length < 2
        ? 'Click to add points along the route; double-click to finish the line.'
        : 'Drag points to adjust the line; drag the small midpoints to add more.';

  return (
    <div className="flex h-full flex-col md:flex-row">
      <div className="h-[50vh] min-h-64 flex-1 md:h-full">
        <MapView
          geometry={state.geometry}
          overlay={overlay}
          waypoints={state.mode === 'snap' ? state.waypoints : []}
          interaction={state.mode}
          onGeometryChange={(geometry) => dispatch({ type: 'setGeometry', geometry })}
          onMapClick={(point) => dispatch({ type: 'addWaypoint', point })}
        />
      </div>
      <aside className="w-full space-y-5 overflow-y-auto p-4 md:w-96">
        <div className="flex items-center gap-2">
          <Link to="/" className="text-sm text-neutral-400 hover:text-neutral-200">
            ← Routes
          </Link>
          {state.dirty && <span className="ml-auto text-xs text-amber-400">Unsaved changes</span>}
          {state.routeId && !state.dirty && (
            <Link
              to="/drive/$routeId"
              params={{ routeId: state.routeId }}
              className="ml-auto rounded bg-amber-400 px-3 py-1 text-sm font-medium text-neutral-950"
            >
              Drive
            </Link>
          )}
        </div>

        <label className="block space-y-1">
          <span className="text-sm font-medium">Name</span>
          <input
            value={state.name}
            onChange={(e) => dispatch({ type: 'setName', name: e.target.value })}
            placeholder="e.g. Hill climb"
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5"
          />
        </label>

        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Type</legend>
          <div className="inline-flex overflow-hidden rounded border border-neutral-700">
            <button
              type="button"
              className={seg(state.type === 'stage')}
              aria-pressed={state.type === 'stage'}
              onClick={() => dispatch({ type: 'setRouteType', routeType: 'stage' })}
            >
              Stage (A → B)
            </button>
            <button
              type="button"
              className={seg(state.type === 'circuit')}
              aria-pressed={state.type === 'circuit'}
              onClick={() => dispatch({ type: 'setRouteType', routeType: 'circuit' })}
            >
              Circuit (laps)
            </button>
          </div>
        </fieldset>

        <section className="space-y-2">
          <h2 className="text-sm font-medium">Route line</h2>
          <div className="inline-flex overflow-hidden rounded border border-neutral-700">
            <button
              type="button"
              className={seg(state.mode === 'draw')}
              aria-pressed={state.mode === 'draw'}
              onClick={() => dispatch({ type: 'setMode', mode: 'draw' })}
            >
              Draw / edit
            </button>
            <button
              type="button"
              className={seg(state.mode === 'snap')}
              aria-pressed={state.mode === 'snap'}
              onClick={() => dispatch({ type: 'setMode', mode: 'snap' })}
            >
              Snap to roads
            </button>
          </div>
          <p className="text-xs text-neutral-400">{hint}</p>
          {state.mode === 'snap' && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={btn}
                disabled={state.waypoints.length < 2 || state.snapping}
                onClick={() => void snap()}
              >
                {state.snapping ? 'Snapping…' : `Snap ${state.waypoints.length} points`}
              </button>
              <button
                type="button"
                className={btn}
                disabled={state.waypoints.length === 0}
                onClick={() =>
                  dispatch({ type: 'removeWaypoint', index: state.waypoints.length - 1 })
                }
              >
                Undo point
              </button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={btn}
              disabled={state.geometry.length < 2}
              onClick={() => dispatch({ type: 'reverse' })}
            >
              Reverse direction
            </button>
            <button
              type="button"
              className={btn}
              disabled={state.geometry.length === 0 && state.waypoints.length === 0}
              onClick={() => dispatch({ type: 'clear' })}
            >
              Clear
            </button>
          </div>
          <GpxImport
            label="Import GPX file"
            onPick={(candidate) => dispatch({ type: 'importGpx', candidate })}
          />
          {preview.ok && (
            <p className="text-sm text-neutral-300" data-testid="route-length">
              Length {formatDistance(preview.preview.lengthM, units)} · source: {state.source}
            </p>
          )}
        </section>

        <IntervalSlider
          value={state.intervalM}
          onChange={(intervalM) => dispatch({ type: 'setInterval', intervalM })}
          summary={preview.ok ? sectorSummary(preview.preview, units) : undefined}
          warn={preview.ok && preview.preview.singleSector}
        />

        <label className="block space-y-1">
          <span className="text-sm font-medium">Gate width (start / finish line)</span>
          <span className="flex items-center gap-2">
            <input
              type="number"
              min={GATE_WIDTH_RANGE.min}
              max={GATE_WIDTH_RANGE.max}
              value={state.gateWidthM}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (e.target.value !== '' && Number.isFinite(n))
                  dispatch({ type: 'setGateWidth', gateWidthM: n });
              }}
              className="w-20 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-right"
            />
            <span className="text-sm text-neutral-400">m</span>
          </span>
        </label>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Default start</legend>
          <div className="inline-flex overflow-hidden rounded border border-neutral-700">
            <button
              type="button"
              className={seg(state.defaultStartMode === 'flying')}
              aria-pressed={state.defaultStartMode === 'flying'}
              onClick={() => dispatch({ type: 'setStartMode', mode: 'flying' })}
            >
              Flying
            </button>
            <button
              type="button"
              className={seg(state.defaultStartMode === 'standing')}
              aria-pressed={state.defaultStartMode === 'standing'}
              onClick={() => dispatch({ type: 'setStartMode', mode: 'standing' })}
            >
              Standing
            </button>
          </div>
          <label className="flex items-center gap-2 text-sm">
            Countdown
            <select
              value={state.defaultCountdownS}
              onChange={(e) => dispatch({ type: 'setCountdown', seconds: Number(e.target.value) })}
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
            >
              {Array.from(
                { length: COUNTDOWN_MAX_S - COUNTDOWN_MIN_S + 1 },
                (_, i) => COUNTDOWN_MIN_S + i,
              ).map((n) => (
                <option key={n} value={n}>
                  {n} s
                </option>
              ))}
            </select>
          </label>
        </fieldset>

        {state.error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded border border-red-700 bg-red-950 p-2 text-sm"
          >
            <span className="flex-1">{state.error}</span>
            <button
              type="button"
              onClick={() => dispatch({ type: 'dismissError' })}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        <div className="space-y-1">
          <button
            type="button"
            disabled={blocker !== null || saving || !state.dirty}
            onClick={() => void save()}
            className="w-full rounded bg-amber-400 px-3 py-2 font-medium text-neutral-950 disabled:opacity-40"
          >
            {saving ? 'Saving…' : state.routeId ? 'Save changes' : 'Save route'}
          </button>
          {blocker && <p className="text-xs text-neutral-400">{blocker}</p>}
        </div>
      </aside>
    </div>
  );
}
