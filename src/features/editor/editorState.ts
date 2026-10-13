// Route editor state (§5). A pure reducer: the map, Terra Draw and the form only dispatch actions.

import { defaultStartModeFor, type RouteDraft } from '../../data/routeModel';
import type { Route, RouteSource } from '../../data/types';
import { clampCountdown, DEFAULT_COUNTDOWN_S } from '../../engine/countdown';
import type { LonLat } from '../../engine/geo';
import {
  clampInterval,
  DEFAULT_GATE_WIDTH_M,
  DEFAULT_INTERVAL_M,
  type RouteType,
} from '../../engine/route';
import type { StartMode } from '../../engine/types';
import type { GpxCandidate } from '../routes/gpx';
import { buildPreview, type PreviewResult } from './preview';

/** How new clicks on the map are used. */
export type DrawMode = 'draw' | 'snap';

export interface EditorState {
  routeId: string | null;
  name: string;
  type: RouteType;
  source: RouteSource;
  /** The route line as edited (Terra Draw vertices, snapped road, import or recording). */
  geometry: LonLat[];
  mode: DrawMode;
  /** Snap mode: the points the user placed; the road between them comes from the snap service. */
  waypoints: LonLat[];
  snapping: boolean;
  intervalM: number;
  gateWidthM: number;
  defaultStartMode: StartMode;
  /** Once the user picks a start mode, changing the route type no longer overrides it. */
  startModeChosen: boolean;
  defaultCountdownS: number;
  error: string | null;
  /** Unsaved changes. */
  dirty: boolean;
}

export type EditorAction =
  | { type: 'load'; route: Route }
  | { type: 'setName'; name: string }
  | { type: 'setRouteType'; routeType: RouteType }
  | { type: 'setMode'; mode: DrawMode }
  | { type: 'setGeometry'; geometry: LonLat[] }
  | { type: 'addWaypoint'; point: LonLat }
  | { type: 'moveWaypoint'; index: number; point: LonLat }
  | { type: 'removeWaypoint'; index: number }
  | { type: 'snapStarted' }
  | { type: 'snapSucceeded'; geometry: LonLat[] }
  | { type: 'snapFailed'; error: string }
  | { type: 'importGpx'; candidate: GpxCandidate }
  | { type: 'importRecording'; geometry: LonLat[]; routeType: RouteType }
  | { type: 'reverse' }
  | { type: 'clear' }
  | { type: 'setInterval'; intervalM: number }
  | { type: 'setGateWidth'; gateWidthM: number }
  | { type: 'setStartMode'; mode: StartMode }
  | { type: 'setCountdown'; seconds: number }
  | { type: 'saved'; route: Route }
  | { type: 'dismissError' };

export const GATE_WIDTH_RANGE = { min: 10, max: 100 };

export function initialEditorState(type: RouteType = 'stage'): EditorState {
  return {
    routeId: null,
    name: '',
    type,
    source: 'drawn',
    geometry: [],
    mode: 'draw',
    waypoints: [],
    snapping: false,
    intervalM: DEFAULT_INTERVAL_M,
    gateWidthM: DEFAULT_GATE_WIDTH_M,
    defaultStartMode: defaultStartModeFor(type),
    startModeChosen: false,
    defaultCountdownS: DEFAULT_COUNTDOWN_S,
    error: null,
    dirty: false,
  };
}

const edited = (s: EditorState, patch: Partial<EditorState>): EditorState => ({
  ...s,
  ...patch,
  dirty: true,
});

export function editorReducer(s: EditorState, a: EditorAction): EditorState {
  switch (a.type) {
    case 'load':
      return {
        ...initialEditorState(a.route.type),
        routeId: a.route.id,
        name: a.route.name,
        source: a.route.source,
        geometry: a.route.geometry,
        intervalM: a.route.intervalM,
        gateWidthM: a.route.gateWidthM,
        defaultStartMode: a.route.defaultStartMode,
        startModeChosen: true,
        defaultCountdownS: a.route.defaultCountdownS,
      };
    case 'setName':
      return edited(s, { name: a.name });
    case 'setRouteType':
      return edited(s, {
        type: a.routeType,
        defaultStartMode: s.startModeChosen ? s.defaultStartMode : defaultStartModeFor(a.routeType),
      });
    case 'setMode':
      // Entering snap mode starts from the current line's ends, so an existing route can be re-snapped.
      return {
        ...s,
        mode: a.mode,
        waypoints:
          a.mode === 'snap' && s.waypoints.length === 0 && s.geometry.length >= 2
            ? [s.geometry[0] as LonLat, s.geometry.at(-1) as LonLat]
            : s.waypoints,
      };
    case 'setGeometry':
      // A hand edit of a snapped/imported line keeps its source: it is still mostly that line.
      return edited(s, { geometry: a.geometry, source: s.geometry.length ? s.source : 'drawn' });
    case 'addWaypoint':
      return edited(s, { waypoints: [...s.waypoints, a.point] });
    case 'moveWaypoint':
      if (a.index < 0 || a.index >= s.waypoints.length) return s;
      return edited(s, { waypoints: s.waypoints.map((p, i) => (i === a.index ? a.point : p)) });
    case 'removeWaypoint':
      if (a.index < 0 || a.index >= s.waypoints.length) return s;
      return edited(s, { waypoints: s.waypoints.filter((_, i) => i !== a.index) });
    case 'snapStarted':
      return { ...s, snapping: true, error: null };
    case 'snapSucceeded':
      return edited(s, { snapping: false, geometry: a.geometry, source: 'snapped' });
    case 'snapFailed':
      return { ...s, snapping: false, error: a.error };
    case 'importGpx':
      return edited(s, {
        geometry: a.candidate.geometry,
        source: 'gpx',
        type: a.candidate.suggestedType,
        name: s.name || a.candidate.name,
        waypoints: [],
        mode: 'draw',
        defaultStartMode: s.startModeChosen
          ? s.defaultStartMode
          : defaultStartModeFor(a.candidate.suggestedType),
      });
    case 'importRecording':
      return edited(s, {
        geometry: a.geometry,
        source: 'recorded',
        type: a.routeType,
        waypoints: [],
        mode: 'draw',
        defaultStartMode: s.startModeChosen ? s.defaultStartMode : defaultStartModeFor(a.routeType),
      });
    case 'reverse':
      // Driving direction decides which end is the start and how the gates face.
      return edited(s, {
        geometry: [...s.geometry].reverse(),
        waypoints: [...s.waypoints].reverse(),
      });
    case 'clear':
      return edited(s, { geometry: [], waypoints: [], source: 'drawn' });
    case 'setInterval':
      return edited(s, { intervalM: clampInterval(a.intervalM) });
    case 'setGateWidth':
      return edited(s, {
        gateWidthM: Math.min(
          GATE_WIDTH_RANGE.max,
          Math.max(GATE_WIDTH_RANGE.min, Math.round(a.gateWidthM)),
        ),
      });
    case 'setStartMode':
      return edited(s, { defaultStartMode: a.mode, startModeChosen: true });
    case 'setCountdown':
      return edited(s, { defaultCountdownS: clampCountdown(a.seconds) });
    case 'saved':
      return { ...s, routeId: a.route.id, name: a.route.name, dirty: false, error: null };
    case 'dismissError':
      return { ...s, error: null };
  }
}

export function editorPreview(s: EditorState): PreviewResult {
  return buildPreview({
    type: s.type,
    geometry: s.geometry,
    intervalM: s.intervalM,
    gateWidthM: s.gateWidthM,
  });
}

/** Why the route can't be saved yet, or null if it can. */
export function saveBlocker(s: EditorState): string | null {
  if (s.geometry.length < 2) return 'Draw, snap, record or import the route first.';
  const preview = editorPreview(s);
  if (!preview.ok) return preview.error;
  if (!s.name.trim()) return 'Give the route a name.';
  if (s.snapping) return 'Wait for snapping to finish.';
  return null;
}

export function editorToDraft(s: EditorState): RouteDraft {
  return {
    name: s.name,
    type: s.type,
    geometry: s.geometry,
    source: s.source,
    intervalM: s.intervalM,
    gateWidthM: s.gateWidthM,
    defaultStartMode: s.defaultStartMode,
    defaultCountdownS: s.defaultCountdownS,
  };
}
