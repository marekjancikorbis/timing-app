// Export (§3.2 should-have, Phase 4): a run's trace as GPX or CSV, a route as GPX, and a route's
// history as CSV. Pure string builders; the page only downloads what these return.

import type { Route, Run, Trace } from '../../data/types';
import { computeCheckpoints } from '../../engine/route';

const xml = (s: string) =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] as string,
  );

const coord = (n: number) => n.toFixed(7);

function gpxDoc(name: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Lap Timer" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${xml(name)}</name></metadata>
${body}
</gpx>
`;
}

/** The run's GPS trace (fixes that were used for timing) as a GPX track with timestamps. */
export function runToGpx(run: Run, trace: Trace, routeName: string): string {
  const pts = trace.points
    .filter((p) => !p.rej)
    .map(
      (p) =>
        `<trkpt lat="${coord(p.lat)}" lon="${coord(p.lon)}"><time>${new Date(p.t).toISOString()}</time></trkpt>`,
    )
    .join('\n');
  const name = `${routeName} ${new Date(run.startTime).toISOString()}`;
  return gpxDoc(name, `<trk><name>${xml(name)}</name><trkseg>\n${pts}\n</trkseg></trk>`);
}

/** A route's line as a GPX track, so it can be imported again or used elsewhere. */
export function routeToGpx(route: Route): string {
  const pts = route.geometry
    .map(([lon, lat]) => `<trkpt lat="${coord(lat)}" lon="${coord(lon)}"/>`)
    .join('\n');
  return gpxDoc(
    route.name,
    `<trk><name>${xml(route.name)}</name><type>${route.type}</type><trkseg>\n${pts}\n</trkseg></trk>`,
  );
}

function csv(rows: readonly (readonly (string | number | undefined)[])[]): string {
  const cell = (v: string | number | undefined) => {
    if (v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${rows.map((r) => r.map(cell).join(',')).join('\n')}\n`;
}

/** Every fix of a run: time since the start, position, accuracy, speed, distance along the route. */
export function runToCsv(run: Run, trace: Trace): string {
  return csv([
    ['time_s', 'lat', 'lon', 'accuracy_m', 'speed_mps', 'distance_m', 'rejected'],
    ...trace.points.map((p) => [
      ((p.t - run.startTime) / 1000).toFixed(3),
      coord(p.lat),
      coord(p.lon),
      p.acc,
      p.spd === undefined ? undefined : p.spd.toFixed(2),
      p.s,
      p.rej,
    ]),
  ]);
}

/** One row per run with its total and sector times, for a spreadsheet. */
export function historyToCsv(route: Route, runs: readonly Run[]): string {
  const n = Math.max(0, ...runs.map((r) => r.sectorMs.length));
  const cps = computeCheckpoints(route.lengthM, route.intervalM);
  const sectorHeads = Array.from({ length: n }, (_, i) =>
    cps[i] === undefined ? `s${i + 1}` : `s${i + 1}_to_${Math.round(cps[i] as number)}m`,
  );
  return csv([
    [
      'start',
      'start_mode',
      'lap',
      'total_s',
      'valid',
      'invalid_reason',
      'jump_start',
      'interval_m',
      ...sectorHeads,
    ],
    ...runs.map((r) => [
      new Date(r.startTime).toISOString(),
      r.startMode,
      r.lapNumber,
      (r.totalMs / 1000).toFixed(3),
      r.valid ? 'yes' : 'no',
      r.invalidReason,
      r.jumpStart ? 'yes' : undefined,
      r.intervalM,
      ...Array.from({ length: n }, (_, i) =>
        r.sectorMs[i] === undefined ? undefined : ((r.sectorMs[i] as number) / 1000).toFixed(3),
      ),
    ]),
  ]);
}

/** A file name without characters that file systems reject. */
export function safeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim() || 'export'
  );
}
