// Polyline helpers shared by GPX import and record-a-route.

import { createProjection, dist, type LonLat, projectOnSegment, type Vec2 } from '../../engine/geo';

/** Douglas–Peucker in metres: drops vertices closer than `toleranceM` to the simplified line. */
export function simplifyLine(points: readonly LonLat[], toleranceM: number): LonLat[] {
  const first = points[0];
  if (!first || points.length < 3) return points.map(([lon, lat]) => [lon, lat]);
  const proj = createProjection(first[0], first[1]);
  const xy = points.map(([lon, lat]) => proj.toXY(lon, lat));
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const tol2 = toleranceM * toleranceM;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    let worst = -1;
    let worstD2 = tol2;
    for (let i = a + 1; i < b; i++) {
      const { d2 } = projectOnSegment(xy[i] as Vec2, xy[a] as Vec2, xy[b] as Vec2);
      if (d2 > worstD2) {
        worstD2 = d2;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return points.filter((_, i) => keep[i]).map(([lon, lat]) => [lon, lat]);
}

/** Length of a [lon, lat] polyline in metres. */
export function lineLengthM(points: readonly LonLat[]): number {
  const first = points[0];
  if (!first) return 0;
  const proj = createProjection(first[0], first[1]);
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const [lon0, lat0] = points[i - 1] as LonLat;
    const [lon1, lat1] = points[i] as LonLat;
    total += dist(proj.toXY(lon0, lat0), proj.toXY(lon1, lat1));
  }
  return total;
}

/** Gap between the first and last point, metres. */
export function endGapM(points: readonly LonLat[]): number {
  const a = points[0];
  const b = points.at(-1);
  if (!a || !b) return 0;
  const proj = createProjection(a[0], a[1]);
  return dist(proj.toXY(a[0], a[1]), proj.toXY(b[0], b[1]));
}

/** A track that comes back to within `closeM` of its start (and isn't tiny) is a lap. */
export function looksClosed(points: readonly LonLat[], closeM = 30): boolean {
  return points.length > 3 && lineLengthM(points) > 200 && endGapM(points) <= closeM;
}

/** Drop consecutive duplicate vertices. */
export function dedupe(points: readonly LonLat[]): LonLat[] {
  return points.filter(
    (p, i) => i === 0 || p[0] !== points[i - 1]?.[0] || p[1] !== points[i - 1]?.[1],
  );
}
