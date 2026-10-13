import { useMemo, useState } from 'react';
import type { Route, Run, Trace } from '../../data/types';
import { computeCheckpoints } from '../../engine/route';
import { LineChart } from '../../ui/LineChart';
import { runStatus } from '../history/historyModel';
import { formatGap, formatTime } from '../live/liveModel';
import { TraceMap } from '../map/TraceMap';
import {
  coloredTrace,
  deltaSeries,
  distanceGrid,
  profileEnd,
  resampleSeries,
  sectorRows,
  speedSeries,
} from './analysis';

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export interface LoadedRun {
  run: Run;
  trace?: Trace;
}

interface Props {
  route: Route;
  current: LoadedRun;
  reference?: LoadedRun;
  /** Runs that can be picked as the reference (same route). */
  candidates: Run[];
  onPickReference: (id: string | undefined) => void;
  /** Extra actions (export, set as reference…), rendered under the header. */
  actions?: React.ReactNode;
  /** Charts and maps need a browser with canvas/WebGL; tests turn them off. */
  showGraphics?: boolean;
}

export function runLabel(r: Run): string {
  return `${formatTime(r.totalMs)} · ${r.startMode}${r.lapNumber > 1 ? ` L${r.lapNumber}` : ''} · ${dateTime.format(r.startTime)}${r.valid ? '' : ' · not valid'}`;
}

const fmt2 = (v: number) => v.toFixed(2);
const fmt0 = (v: number) => v.toFixed(0);

const tone = (ms: number | undefined) =>
  ms === undefined ? '' : ms <= 0 ? 'text-green-400' : 'text-red-400';

/** Run detail and comparison (Phase 4): sectors, delta and speed charts, coloured trace. */
export function RunView({
  route,
  current,
  reference,
  candidates,
  onPickReference,
  actions,
  showGraphics = true,
}: Props) {
  const { run, trace } = current;
  const ref = reference?.run;
  const [colorBy, setColorBy] = useState<'delta' | 'speed'>(reference ? 'delta' : 'speed');

  const rows = useMemo(() => {
    const cps = computeCheckpoints(route.lengthM, run.intervalM);
    const refSectors = ref && ref.intervalM === run.intervalM ? ref.sectorMs : undefined;
    return sectorRows(cps, run.sectorMs, run.sectorFlags, refSectors);
  }, [route.lengthM, run, ref]);

  const charts = useMemo(() => {
    if (!trace) return null;
    const refProfile = reference?.trace?.profile;
    const delta = refProfile ? deltaSeries(trace.profile, refProfile) : null;
    const v = speedSeries(trace.points);
    const vRef = reference?.trace ? speedSeries(reference.trace.points) : null;
    const end = Math.max(profileEnd(trace.profile), refProfile ? profileEnd(refProfile) : 0);
    const grid = distanceGrid(end, 10);
    const speed = [
      { label: 'This run', values: resampleSeries(v.s, v.kmh, grid), color: '#f59e0b' },
      ...(vRef
        ? [
            {
              label: 'Reference',
              values: resampleSeries(vRef.s, vRef.kmh, grid),
              color: '#a3a3a3',
              dash: [6, 4],
            },
          ]
        : []),
    ];
    return {
      delta,
      deltaSeries: delta ? [{ label: 'Gap', values: delta.dS, color: '#f59e0b' }] : [],
      grid,
      speed,
      map: coloredTrace(trace.points, trace.profile, refProfile),
    };
  }, [trace, reference]);

  const sameMode = !ref || ref.startMode === run.startMode;
  const status = runStatus(run);

  return (
    <div className="space-y-6">
      <section className="space-y-1">
        <div className="font-mono text-5xl tabular-nums" data-testid="run-time">
          {formatTime(run.totalMs)}
        </div>
        <p className="text-neutral-300">
          {run.startMode === 'standing' ? 'Standing start' : 'Flying start'}
          {run.lapNumber > 1 && ` · lap ${run.lapNumber}`} · {dateTime.format(run.startTime)}
        </p>
        <p className="text-sm text-neutral-400" data-testid="run-status">
          {run.valid ? 'Valid' : 'Not valid'}
          {status && ` · ${status}`}
          {run.countdownS !== undefined && ` · ${run.countdownS} s countdown`}
          {run.launchMs !== undefined && ` · launch ≈ ${(run.launchMs / 1000).toFixed(2)} s`}
          {run.clockOffsetMs !== undefined && ` · clock offset ${Math.round(run.clockOffsetMs)} ms`}
        </p>
      </section>

      {actions}

      <section className="space-y-2">
        <label className="flex flex-wrap items-center gap-2">
          <span>Compare with</span>
          <select
            aria-label="Reference run"
            value={ref?.id ?? ''}
            onChange={(e) => onPickReference(e.target.value || undefined)}
            className="max-w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
          >
            <option value="">Nothing</option>
            {candidates
              .filter((c) => c.id !== run.id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {runLabel(c)}
                </option>
              ))}
          </select>
        </label>
        {ref && (
          <p className="text-lg">
            Gap{' '}
            <span className={`font-mono tabular-nums ${tone(run.totalMs - ref.totalMs)}`}>
              {formatGap(run.totalMs - ref.totalMs)}
            </span>{' '}
            to {formatTime(ref.totalMs)}
            {!sameMode && (
              <span className="block text-sm text-amber-400">
                Different start modes: the first sector isn't comparable.
              </span>
            )}
          </p>
        )}
      </section>

      {rows.length > 0 && (
        <section className="overflow-x-auto">
          <table className="w-full border-collapse text-sm" aria-label="Sectors">
            <thead>
              <tr className="text-left text-xs text-neutral-400">
                <th className="p-1">Sector</th>
                <th className="p-1">Distance</th>
                <th className="p-1 text-right">Time</th>
                {ref && <th className="p-1 text-right">Reference</th>}
                {ref && <th className="p-1 text-right">Δ sector</th>}
                {ref && <th className="p-1 text-right">Gap</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.index} className="border-t border-neutral-800" data-testid="sector-row">
                  <td className="p-1">S{r.index + 1}</td>
                  <td className="p-1 text-neutral-400">
                    {Math.round(r.fromM)}–{Math.round(r.toM)} m
                  </td>
                  <td
                    className={`p-1 text-right font-mono tabular-nums ${r.estimated ? 'italic opacity-70' : ''}`}
                  >
                    {(r.ms / 1000).toFixed(2)}
                  </td>
                  {ref && (
                    <td className="p-1 text-right font-mono tabular-nums text-neutral-400">
                      {r.refMs === undefined ? '–' : (r.refMs / 1000).toFixed(2)}
                    </td>
                  )}
                  {ref && (
                    <td className={`p-1 text-right font-mono tabular-nums ${tone(r.deltaMs)}`}>
                      {r.deltaMs === undefined ? '–' : formatGap(r.deltaMs)}
                    </td>
                  )}
                  {ref && (
                    <td className={`p-1 text-right font-mono tabular-nums ${tone(r.cumDeltaMs)}`}>
                      {r.cumDeltaMs === undefined ? '–' : formatGap(r.cumDeltaMs)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {!trace && <p className="text-neutral-400">The GPS trace of this run is missing.</p>}

      {showGraphics && charts && (
        <>
          {charts.delta && (
            <section className="space-y-1">
              <h2 className="font-medium">Gap to reference</h2>
              <p className="text-xs text-neutral-400">Above zero = behind the reference.</p>
              <LineChart
                x={charts.delta.s}
                series={charts.deltaSeries}
                yLabel="Gap (s)"
                zeroLine
                formatY={fmt2}
              />
            </section>
          )}
          <section className="space-y-1">
            <h2 className="font-medium">Speed</h2>
            <LineChart x={charts.grid} series={charts.speed} yLabel="km/h" formatY={fmt0} />
          </section>
          <section className="space-y-2">
            <div className="flex items-center gap-3">
              <h2 className="mr-auto font-medium">Trace</h2>
              <div className="inline-flex overflow-hidden rounded border border-neutral-700 text-sm">
                {(['delta', 'speed'] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    disabled={c === 'delta' && !reference?.trace}
                    aria-pressed={colorBy === c}
                    onClick={() => setColorBy(c)}
                    className={`px-3 py-1 disabled:text-neutral-600 ${colorBy === c ? 'bg-amber-400 text-black' : 'bg-neutral-900'}`}
                  >
                    {c === 'delta' ? 'Gained / lost' : 'Speed'}
                  </button>
                ))}
              </div>
            </div>
            <TraceMap
              route={route}
              trace={charts.map}
              colorBy={reference?.trace ? colorBy : 'speed'}
            />
            <p className="text-xs text-neutral-400">
              {reference?.trace && colorBy === 'delta'
                ? 'Green = gaining time on the reference, red = losing time.'
                : 'Blue = slow, yellow = medium, red = fast.'}
            </p>
          </section>
        </>
      )}
    </div>
  );
}
