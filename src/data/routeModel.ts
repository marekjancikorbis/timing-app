// Pure conversions between editor drafts, stored routes and engine routes.

import { clampCountdown, DEFAULT_COUNTDOWN_S } from '../engine/countdown';
import type { LonLat } from '../engine/geo';
import {
  clampInterval,
  DEFAULT_GATE_WIDTH_M,
  DEFAULT_INTERVAL_M,
  gateToLonLat,
  type PreparedRoute,
  prepareRoute,
  type RouteType,
} from '../engine/route';
import type { StartMode } from '../engine/types';
import type { Route, RouteSource } from './types';

export interface RouteDraft {
  name: string;
  type: RouteType;
  geometry: LonLat[];
  source: RouteSource;
  intervalM?: number;
  gateWidthM?: number;
  defaultStartMode?: StartMode;
  defaultCountdownS?: number;
}

/** §4.9: flying for circuits, standing for stages. */
export function defaultStartModeFor(type: RouteType): StartMode {
  return type === 'circuit' ? 'flying' : 'standing';
}

/** Build a complete route record. Throws if the geometry is unusable (see `prepareRoute`). */
export function routeFromDraft(draft: RouteDraft, id: string, now: number, createdAt = now): Route {
  const name = draft.name.trim();
  if (!name) throw new Error('Route needs a name');
  const intervalM = clampInterval(draft.intervalM ?? DEFAULT_INTERVAL_M);
  const gateWidthM = draft.gateWidthM ?? DEFAULT_GATE_WIDTH_M;
  const prepared = prepareRoute({
    type: draft.type,
    geometry: draft.geometry,
    intervalM,
    gateWidthM,
  });
  const route: Route = {
    id,
    name,
    type: draft.type,
    geometry: draft.geometry.map(([lon, lat]) => [lon, lat]),
    lengthM: prepared.lengthM,
    intervalM,
    gateWidthM,
    startGate: gateToLonLat(prepared, prepared.startGate),
    defaultStartMode: draft.defaultStartMode ?? defaultStartModeFor(draft.type),
    defaultCountdownS: clampCountdown(draft.defaultCountdownS ?? DEFAULT_COUNTDOWN_S),
    source: draft.source,
    createdAt,
    updatedAt: now,
  };
  if (draft.type === 'stage') route.finishGate = gateToLonLat(prepared, prepared.finishGate);
  return route;
}

export function draftFromRoute(route: Route): RouteDraft {
  return {
    name: route.name,
    type: route.type,
    geometry: route.geometry,
    source: route.source,
    intervalM: route.intervalM,
    gateWidthM: route.gateWidthM,
    defaultStartMode: route.defaultStartMode,
    defaultCountdownS: route.defaultCountdownS,
  };
}

/** Engine form of a stored route. */
export function prepareStored(route: Route): PreparedRoute {
  return prepareRoute({
    type: route.type,
    geometry: route.geometry,
    intervalM: route.intervalM,
    gateWidthM: route.gateWidthM,
  });
}
