// Pure glue between the editor's line and Terra Draw's GeoJSON store.

import type { LonLat } from '../../engine/geo';

export type FeatureId = string | number;

export interface LineFeature {
  id: FeatureId;
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: LonLat[] };
  properties: { mode: 'linestring' };
}

/**
 * The route line as a Terra Draw feature (editable by its select mode). The id must come from
 * `draw.getFeatureId()`: Terra Draw rejects ids that don't match its id strategy (UUID v4).
 */
export function lineFeature(geometry: readonly LonLat[], id: FeatureId): LineFeature {
  return {
    id,
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: geometry.map(([lon, lat]) => [lon, lat]) },
    properties: { mode: 'linestring' },
  };
}

interface SnapshotFeature {
  id?: FeatureId;
  geometry: { type: string; coordinates: unknown };
}

/**
 * The route line out of a Terra Draw snapshot: the feature with `preferId` if present, otherwise
 * the most recently drawn line. Null when there is no usable line yet.
 */
export function lineFromSnapshot(
  features: readonly SnapshotFeature[],
  preferId?: FeatureId | null,
): { id: FeatureId | undefined; geometry: LonLat[] } | null {
  const lines = features.filter((f) => f.geometry.type === 'LineString');
  const ours =
    (preferId != null ? lines.find((f) => f.id === preferId) : undefined) ?? lines.at(-1);
  if (!ours) return null;
  const coords = (ours.geometry.coordinates as unknown[]).filter(
    (c): c is number[] =>
      Array.isArray(c) &&
      c.length >= 2 &&
      c.every((n) => typeof n === 'number' && Number.isFinite(n)),
  );
  if (coords.length < 2) return null;
  return { id: ours.id, geometry: coords.map((c): LonLat => [c[0] as number, c[1] as number]) };
}

/** Same vertices (to a few millimetres): avoids pushing a line back into the map that came from it. */
export function sameLine(a: readonly LonLat[], b: readonly LonLat[], eps = 1e-8): boolean {
  return (
    a.length === b.length &&
    a.every(
      (p, i) =>
        Math.abs(p[0] - (b[i] as LonLat)[0]) <= eps && Math.abs(p[1] - (b[i] as LonLat)[1]) <= eps,
    )
  );
}

/** [west, south, east, north] around some points, padded, or null when there are none. */
export function boundsOf(
  points: readonly LonLat[],
  padDeg = 0.002,
): [number, number, number, number] | null {
  if (points.length === 0) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lon, lat] of points) {
    w = Math.min(w, lon);
    e = Math.max(e, lon);
    s = Math.min(s, lat);
    n = Math.max(n, lat);
  }
  return [w - padDeg, s - padDeg, e + padDeg, n + padDeg];
}
