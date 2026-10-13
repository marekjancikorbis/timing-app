// Planar geometry for the timing hot path (§4.1). No allocations beyond small result objects.

/** [lon, lat] in degrees, GeoJSON order. */
export type LonLat = [number, number];

/** Local planar coordinates in metres: x = east, y = north. */
export interface Vec2 {
  x: number;
  y: number;
}

const DEG = Math.PI / 180;

/** Metres per degree of latitude / longitude at latitude φ (WGS84 series, accurate to ~1 cm). */
export function metresPerDegree(latDeg: number): { lat: number; lon: number } {
  const p = latDeg * DEG;
  return {
    lat: 111_132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p),
    lon: 111_412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p),
  };
}

export interface Projection {
  lon0: number;
  lat0: number;
  toXY(lon: number, lat: number): Vec2;
  toLonLat(p: Vec2): LonLat;
}

/**
 * Equirectangular projection centred on (lon0, lat0). Accurate enough for routes under ~50 km.
 * Scale factors come from the latitude of the origin; the fixed 111 320 / 110 540 constants are
 * equator values and would make north–south distances ~0.6% short at mid-latitudes.
 */
export function createProjection(lon0: number, lat0: number): Projection {
  const m = metresPerDegree(lat0);
  const kx = m.lon;
  const ky = m.lat;
  return {
    lon0,
    lat0,
    toXY: (lon, lat) => ({ x: (lon - lon0) * kx, y: (lat - lat0) * ky }),
    toLonLat: (p) => [lon0 + p.x / kx, lat0 + p.y / ky],
  };
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Great-circle distance in metres. Used where no projection is set up yet (e.g. fix filtering). */
export function haversineM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass bearing from a to b in degrees [0, 360): 0 = north, 90 = east. */
export function bearingDeg(a: Vec2, b: Vec2): number {
  const deg = Math.atan2(b.x - a.x, b.y - a.y) / DEG;
  return deg < 0 ? deg + 360 : deg;
}

/** Smallest absolute difference between two bearings, in [0, 180]. */
export function angleDiffDeg(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/** Point at `distance` metres from p in the direction of `bearing` degrees. */
export function offset(p: Vec2, bearing: number, distance: number): Vec2 {
  return {
    x: p.x + Math.sin(bearing * DEG) * distance,
    y: p.y + Math.cos(bearing * DEG) * distance,
  };
}

/**
 * Intersection of segments p1→p2 and q1→q2.
 * Returns `t` (fraction along p) and `u` (fraction along q), both in [0, 1], or null.
 */
export function segmentIntersection(
  p1: Vec2,
  p2: Vec2,
  q1: Vec2,
  q2: Vec2,
): { t: number; u: number } | null {
  const rx = p2.x - p1.x;
  const ry = p2.y - p1.y;
  const sx = q2.x - q1.x;
  const sy = q2.y - q1.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null; // parallel or degenerate
  const qpx = q1.x - p1.x;
  const qpy = q1.y - p1.y;
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

/** Projection of p onto segment a→b. `t` is clamped to [0, 1]; `d2` is the squared distance. */
export function projectOnSegment(p: Vec2, a: Vec2, b: Vec2): { t: number; d2: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = a.x + t * dx - p.x;
  const cy = a.y + t * dy - p.y;
  return { t, d2: cx * cx + cy * cy };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}
