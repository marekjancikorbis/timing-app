// GPX import (§3.2 MVP 1). Tracks and routes become route candidates; the user picks one.
// Runs on the main thread: it needs DOMParser, which Web Workers don't have, and GPX files are small.

import { gpx } from '@tmcw/togeojson';
import { z } from 'zod';
import type { LonLat } from '../../engine/geo';
import type { RouteType } from '../../engine/route';
import { dedupe, lineLengthM, looksClosed, simplifyLine } from './simplify';

export interface GpxCandidate {
  name: string;
  kind: 'track' | 'route';
  geometry: LonLat[];
  lengthM: number;
  suggestedType: RouteType;
  /** Points in the file / after simplification. */
  pointsIn: number;
  droppedPoints: number;
}

export type GpxResult =
  | { ok: true; candidates: GpxCandidate[]; skipped: number }
  | { ok: false; error: string };

/** A GPX coordinate as togeojson emits it: [lon, lat, ele?, …]. */
const Coord = z
  .array(z.number())
  .min(2)
  .refine(
    ([lon, lat]) => Math.abs(lon as number) <= 180 && Math.abs(lat as number) <= 90,
    'out of range',
  );

/** Vertices closer than this to the simplified line are dropped (keeps editing manageable). */
const SIMPLIFY_M = 1;

export function parseGpx(text: string, parser: DOMParser = new DOMParser()): GpxResult {
  if (!text.trim()) return { ok: false, error: 'The file is empty.' };
  const doc = parser.parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    return { ok: false, error: 'This is not valid XML. The file may be damaged or cut off.' };
  }
  if (doc.documentElement?.localName.toLowerCase() !== 'gpx') {
    return { ok: false, error: 'This is not a GPX file.' };
  }

  const fc = gpx(doc);
  const candidates: GpxCandidate[] = [];
  let skipped = 0;
  let counts = { track: 0, route: 0 };
  let waypoints = 0;

  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Point') {
      waypoints++;
      continue;
    }
    let lines: number[][][];
    if (g.type === 'LineString') lines = [g.coordinates];
    else if (g.type === 'MultiLineString')
      lines = g.coordinates; // track segments, joined in order
    else continue;

    const kind = f.properties?._gpxType === 'rte' ? 'route' : 'track';
    counts = { ...counts, [kind]: counts[kind] + 1 };
    const raw = lines.flat();
    const valid = raw
      .filter((c) => Coord.safeParse(c).success)
      .map((c): LonLat => [c[0] as number, c[1] as number]);
    const clean = dedupe(valid);
    if (clean.length < 2) {
      skipped++;
      continue;
    }
    const geometry = simplifyLine(clean, SIMPLIFY_M);
    const name = typeof f.properties?.name === 'string' && f.properties.name.trim();
    candidates.push({
      name: name || `${kind === 'route' ? 'Route' : 'Track'} ${counts[kind]}`,
      kind,
      geometry,
      lengthM: lineLengthM(clean),
      suggestedType: looksClosed(clean) ? 'circuit' : 'stage',
      pointsIn: raw.length,
      droppedPoints: raw.length - valid.length,
    });
  }

  if (candidates.length === 0) {
    // togeojson drops one-point tracks entirely, so count the elements in the XML too.
    const lineElements =
      doc.getElementsByTagName('trk').length + doc.getElementsByTagName('rte').length;
    const why =
      skipped > 0 || lineElements > 0
        ? 'Its tracks have fewer than two usable points.'
        : waypoints > 0
          ? 'It only has waypoints. Record or draw the route instead.'
          : 'It has no tracks or routes.';
    return { ok: false, error: `Nothing to import. ${why}` };
  }
  return { ok: true, candidates, skipped };
}
