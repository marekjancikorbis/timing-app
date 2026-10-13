// Route editor preview (§5): checkpoint markers, gates and the "N sectors, last sector X m" line.
// Pure, so the map layer only has to draw what this returns.

import type { LonLat } from '../../engine/geo';
import {
  clampInterval,
  gateToLonLat,
  INTERVAL_MAX_M,
  INTERVAL_MIN_M,
  INTERVAL_STEP_M,
  pointAt,
  prepareRoute,
  type RouteType,
  sectorLengths,
} from '../../engine/route';

export interface PreviewInput {
  type: RouteType;
  geometry: LonLat[];
  intervalM: number;
  gateWidthM?: number;
}

export interface Preview {
  lengthM: number;
  intervalM: number;
  sectorCount: number;
  lastSectorM: number;
  /** Interval ≥ length: the whole route is one sector (§4.2 edge case). */
  singleSector: boolean;
  /** Intermediate checkpoints (the finish / lap line is a gate, not a marker). */
  checkpoints: { index: number; distanceM: number; position: LonLat }[];
  startGate: [LonLat, LonLat];
  /** Same line as the start on a circuit. */
  finishGate: [LonLat, LonLat];
}

export type PreviewResult = { ok: true; preview: Preview } | { ok: false; error: string };

export function buildPreview(input: PreviewInput): PreviewResult {
  let route: ReturnType<typeof prepareRoute>;
  try {
    route = prepareRoute({
      type: input.type,
      geometry: input.geometry,
      intervalM: input.intervalM,
      gateWidthM: input.gateWidthM,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const lens = sectorLengths(route.checkpoints);
  const start = gateToLonLat(route, route.startGate);
  const finish = gateToLonLat(route, route.finishGate);
  return {
    ok: true,
    preview: {
      lengthM: route.lengthM,
      intervalM: route.intervalM,
      sectorCount: lens.length,
      lastSectorM: lens.at(-1) as number,
      singleSector: lens.length === 1,
      checkpoints: route.checkpoints.slice(0, -1).map((d, index) => ({
        index,
        distanceM: d,
        position: route.proj.toLonLat(pointAt(route, d)),
      })),
      startGate: [start.a, start.b],
      finishGate: [finish.a, finish.b],
    },
  };
}

export function formatDistance(m: number, units: 'metric' | 'imperial' = 'metric'): string {
  if (units === 'imperial') {
    const mi = m / 1609.344;
    return mi >= 0.1 ? `${mi.toFixed(2)} mi` : `${Math.round(m * 3.28084)} ft`;
  }
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

/** "12 sectors, last sector 130 m" (§5), plus the single-sector warning. */
export function sectorSummary(p: Preview, units: 'metric' | 'imperial' = 'metric'): string {
  if (p.singleSector) {
    return `1 sector: the interval is as long as the route (${formatDistance(p.lengthM, units)})`;
  }
  return `${p.sectorCount} sectors, last sector ${formatDistance(p.lastSectorM, units)}`;
}

/** Slider steps (§3.1: 100–1000 m in 50 m steps). */
export const INTERVAL_SLIDER = { min: INTERVAL_MIN_M, max: INTERVAL_MAX_M, step: INTERVAL_STEP_M };

/** Parse what the user typed in the number box; undefined = not a usable number yet. */
export function parseIntervalInput(text: string): number | undefined {
  const n = Number(text.trim());
  if (!text.trim() || !Number.isFinite(n)) return undefined;
  return clampInterval(n);
}

type Feature = {
  type: 'Feature';
  properties: Record<string, string | number>;
  geometry: { type: 'Point'; coordinates: LonLat } | { type: 'LineString'; coordinates: LonLat[] };
};

/** Everything the map draws for the editor, as one GeoJSON FeatureCollection. */
export function previewGeoJson(input: PreviewInput, p: Preview) {
  const features: Feature[] = [
    {
      type: 'Feature',
      properties: { kind: 'route' },
      geometry: { type: 'LineString', coordinates: input.geometry },
    },
    {
      type: 'Feature',
      properties: { kind: 'start' },
      geometry: { type: 'LineString', coordinates: p.startGate },
    },
    ...p.checkpoints.map(
      (c): Feature => ({
        type: 'Feature',
        properties: {
          kind: 'checkpoint',
          label: String(c.index + 1),
          distanceM: Math.round(c.distanceM),
        },
        geometry: { type: 'Point', coordinates: c.position },
      }),
    ),
  ];
  if (input.type === 'stage') {
    features.push({
      type: 'Feature',
      properties: { kind: 'finish' },
      geometry: { type: 'LineString', coordinates: p.finishGate },
    });
  }
  return { type: 'FeatureCollection' as const, features };
}
