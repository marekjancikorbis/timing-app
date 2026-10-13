// Route preprocessing (§4.2): resampling, cumulative distance, checkpoints, gates, projection.

import {
  bearingDeg,
  createProjection,
  dist,
  type LonLat,
  offset,
  type Projection,
  projectOnSegment,
  type Vec2,
} from './geo';

export type RouteType = 'circuit' | 'stage';

export const INTERVAL_MIN_M = 100;
export const INTERVAL_MAX_M = 1000;
export const INTERVAL_STEP_M = 50;
export const DEFAULT_INTERVAL_M = 100;
export const DEFAULT_GATE_WIDTH_M = 40;
export const RESAMPLE_STEP_M = 5;
export const LEAD_IN_M = 200;
export const LEAD_OUT_M = 200;

/** Gate as stored in the data model (§4.9). */
export interface Gate {
  a: LonLat;
  b: LonLat;
  bearingDeg: number;
}

/** Gate in local metres, with its position along the route. */
export interface PreparedGate {
  a: Vec2;
  b: Vec2;
  bearingDeg: number;
  s: number;
}

export interface RouteInput {
  type: RouteType;
  geometry: LonLat[];
  intervalM?: number;
  gateWidthM?: number;
}

export interface PreparedRoute {
  type: RouteType;
  proj: Projection;
  /** Route vertices in local metres, including the stage lead-in/lead-out. */
  pts: Vec2[];
  /** Distance along the route for each vertex. The start line is s = 0, so lead-in values are negative. */
  cum: number[];
  /** Start line → finish line (stage) or one lap (circuit). */
  lengthM: number;
  intervalM: number;
  /** Sector end distances, ascending; the last one is always `lengthM`. */
  checkpoints: number[];
  startGate: PreparedGate;
  /** For a circuit this is the start gate at s = lengthM. */
  finishGate: PreparedGate;
  /** Lowest / highest s that projection can return. */
  sMin: number;
  sMax: number;
}

export function clampInterval(intervalM: number): number {
  const stepped = Math.round(intervalM / INTERVAL_STEP_M) * INTERVAL_STEP_M;
  return Math.min(INTERVAL_MAX_M, Math.max(INTERVAL_MIN_M, stepped));
}

/**
 * Sector end distances for a route of `lengthM` split every `intervalM` metres.
 * Remainder rule: a final sector shorter than `intervalM * mergeBelow` is merged into the previous one.
 * If `intervalM >= lengthM` there is a single sector.
 */
export function computeCheckpoints(lengthM: number, intervalM: number, mergeBelow = 0.5): number[] {
  if (!(lengthM > 0)) return [];
  const out: number[] = [];
  for (let d = intervalM; d < lengthM - 1e-9; d += intervalM) out.push(d);
  const lastFull = out.length ? (out[out.length - 1] as number) : 0;
  if (out.length && lengthM - lastFull < intervalM * mergeBelow) out.pop();
  out.push(lengthM);
  return out;
}

/** Sector lengths from checkpoint distances. */
export function sectorLengths(checkpoints: readonly number[]): number[] {
  return checkpoints.map((d, i) => d - (i === 0 ? 0 : (checkpoints[i - 1] as number)));
}

/** Resample a polyline to points spaced `step` metres apart (the last point is always kept). */
export function resample(points: readonly Vec2[], step = RESAMPLE_STEP_M): Vec2[] {
  if (points.length < 2) return points.map((p) => ({ ...p }));
  const first = points[0] as Vec2;
  const out: Vec2[] = [{ ...first }];
  let carry = 0; // distance travelled since the last emitted point
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Vec2;
    const b = points[i] as Vec2;
    const segLen = dist(a, b);
    let pos = step - carry;
    while (pos <= segLen) {
      const f = pos / segLen;
      out.push({ x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) });
      pos += step;
    }
    carry = segLen - (pos - step);
  }
  const last = points[points.length - 1] as Vec2;
  const tail = out[out.length - 1] as Vec2;
  if (dist(tail, last) > step * 0.2) out.push({ ...last });
  else out[out.length - 1] = { ...last };
  return out;
}

function cumulative(pts: readonly Vec2[], start: number): number[] {
  const cum = [start];
  for (let i = 1; i < pts.length; i++) {
    cum.push((cum[i - 1] as number) + dist(pts[i - 1] as Vec2, pts[i] as Vec2));
  }
  return cum;
}

export function prepareRoute(input: RouteInput): PreparedRoute {
  const first = input.geometry[0];
  if (!first || input.geometry.length < 2) throw new Error('Route needs at least two points');
  const proj = createProjection(first[0], first[1]);
  let raw = input.geometry.map(([lon, lat]) => proj.toXY(lon, lat));
  if (input.type === 'circuit' && dist(raw[0] as Vec2, raw[raw.length - 1] as Vec2) > 1) {
    raw = [...raw, { ...(raw[0] as Vec2) }]; // close the loop
  }
  const core = resample(raw);
  const coreCum = cumulative(core, 0);
  const lengthM = coreCum[coreCum.length - 1] as number;
  if (lengthM < 10) throw new Error('Route is too short');

  let pts = core;
  let cum = coreCum;
  if (input.type === 'stage') {
    // Virtual straight lead-in before the start and lead-out after the finish.
    const p0 = core[0] as Vec2;
    const p1 = pointAlong(core, coreCum, Math.min(10, lengthM));
    const pn = core[core.length - 1] as Vec2;
    const pn1 = pointAlong(core, coreCum, Math.max(0, lengthM - 10));
    const leadIn = offset(p0, bearingDeg(p1, p0), LEAD_IN_M);
    const leadOut = offset(pn, bearingDeg(pn1, pn), LEAD_OUT_M);
    pts = [leadIn, ...core, leadOut];
    cum = [-LEAD_IN_M, ...coreCum, lengthM + LEAD_OUT_M];
  }

  const intervalM = clampInterval(input.intervalM ?? DEFAULT_INTERVAL_M);
  const gateWidthM = input.gateWidthM ?? DEFAULT_GATE_WIDTH_M;
  const partial = { type: input.type, pts, cum, lengthM };
  const startGate = makeGate(partial, 0, gateWidthM);
  const finishGate = makeGate(partial, lengthM, gateWidthM);

  return {
    type: input.type,
    proj,
    pts,
    cum,
    lengthM,
    intervalM,
    checkpoints: computeCheckpoints(lengthM, intervalM),
    startGate,
    finishGate,
    sMin: cum[0] as number,
    sMax: cum[cum.length - 1] as number,
  };
}

/** Same route with a different sector interval (cheap: geometry is reused). */
export function withInterval(route: PreparedRoute, intervalM: number): PreparedRoute {
  const clamped = clampInterval(intervalM);
  return { ...route, intervalM: clamped, checkpoints: computeCheckpoints(route.lengthM, clamped) };
}

/** Index of the last vertex with cum[i] <= s (clamped to a valid segment start). */
function segmentIndex(cum: readonly number[], s: number): number {
  let lo = 0;
  let hi = cum.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((cum[mid] as number) <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function pointAlong(pts: readonly Vec2[], cum: readonly number[], s: number): Vec2 {
  const i = segmentIndex(cum, s);
  const a = pts[i] as Vec2;
  const b = (pts[i + 1] ?? a) as Vec2;
  const c0 = cum[i] as number;
  const len = (cum[i + 1] ?? c0) - c0;
  const f = len > 0 ? Math.min(1, Math.max(0, (s - c0) / len)) : 0;
  return { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) };
}

type RouteShape = Pick<PreparedRoute, 'type' | 'pts' | 'cum' | 'lengthM'>;

/** Point at distance s along the route. On a circuit, s wraps around the lap. */
export function pointAt(route: RouteShape, s: number): Vec2 {
  const ss = route.type === 'circuit' ? ((s % route.lengthM) + route.lengthM) % route.lengthM : s;
  return pointAlong(route.pts, route.cum, ss);
}

/** Direction of travel at distance s, from points 10 m either side. */
export function bearingAt(route: RouteShape, s: number): number {
  return bearingDeg(pointAt(route, s - 10), pointAt(route, s + 10));
}

function makeGate(route: RouteShape, s: number, widthM: number): PreparedGate {
  const c = pointAt(route, s);
  const brg = bearingAt(route, s);
  return {
    a: offset(c, brg - 90, widthM / 2),
    b: offset(c, brg + 90, widthM / 2),
    bearingDeg: brg,
    s,
  };
}

export function gateToLonLat(route: PreparedRoute, g: PreparedGate): Gate {
  return { a: route.proj.toLonLat(g.a), b: route.proj.toLonLat(g.b), bearingDeg: g.bearingDeg };
}

export interface Projected {
  /** Distance along the route. */
  s: number;
  /** Perpendicular distance from the route line in metres. */
  d: number;
}

/**
 * Project p onto the part of the route with sLo <= s <= sHi (§4.3 B, windowed projection).
 * Restricting the window keeps the result on the right stretch at hairpins and parallel straights.
 */
export function projectWindow(route: PreparedRoute, p: Vec2, sLo: number, sHi: number): Projected {
  const { pts, cum } = route;
  const lo = Math.max(sLo, route.sMin);
  const hi = Math.min(sHi, route.sMax);
  let best: Projected = { s: lo, d: Number.POSITIVE_INFINITY };
  let bestD2 = Number.POSITIVE_INFINITY;
  for (let i = segmentIndex(cum, lo); i < pts.length - 1 && (cum[i] as number) <= hi; i++) {
    const c0 = cum[i] as number;
    const len = (cum[i + 1] as number) - c0;
    const a = pts[i] as Vec2;
    const b = pts[i + 1] as Vec2;
    let { t } = projectOnSegment(p, a, b);
    // Keep the foot point inside the window; the distance is measured to that clamped point.
    if (len > 0) t = Math.min((hi - c0) / len, Math.max((lo - c0) / len, t));
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = a.x + t * (b.x - a.x) - p.x;
    const dy = a.y + t * (b.y - a.y) - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = { s: c0 + t * len, d: Math.sqrt(d2) };
    }
  }
  return best;
}

/** Project onto the whole route. */
export function projectGlobal(route: PreparedRoute, p: Vec2): Projected {
  return projectWindow(route, p, route.sMin, route.sMax);
}
