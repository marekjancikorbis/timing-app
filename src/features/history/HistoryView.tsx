import { useState } from 'react';
import type { Route, Run, Session } from '../../data/types';
import type { SectorColor } from '../../engine/delta';
import type { StartMode } from '../../engine/types';
import { formatGap, formatTime } from '../live/liveModel';
import { groupBySession, runStatus, sectorCells, summarize } from './historyModel';

const CELL: Record<SectorColor, string> = {
  purple: 'bg-purple-600/80 text-white',
  green: 'bg-green-600/70 text-white',
  red: 'bg-red-600/70 text-white',
  neutral: 'text-neutral-300',
};

const seg = (on: boolean) =>
  `px-4 py-2 ${on ? 'bg-amber-400 text-neutral-950' : 'bg-neutral-900 hover:bg-neutral-800'}`;

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

interface Props {
  route: Route;
  runs: Run[];
  sessions: Session[];
  /** Reference run per start mode; defaults to the best run. */
  reference?: Partial<Record<StartMode, Run>>;
  onOpenRun?: (id: string) => void;
  onCompare?: (a: string, b: string) => void;
  onDeleteRun: (id: string) => void;
  onSessionNotes: (sessionId: string, notes: string) => void;
}

function SessionNotes({ session, onSave }: { session: Session; onSave: (notes: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(session.notes ?? '');
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setText(session.notes ?? '');
          setEditing(true);
        }}
        className="text-left text-sm text-neutral-400 hover:text-neutral-200"
      >
        {session.notes ? session.notes : '+ Add notes (car, tyres, weather, surface)'}
      </button>
    );
  }
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(text.trim());
        setEditing(false);
      }}
    >
      <input
        aria-label="Session notes"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
      />
      <button type="submit" className="rounded bg-amber-400 px-3 py-1 text-sm text-neutral-950">
        Save
      </button>
    </form>
  );
}

/** Route history (Phase 4): sessions, bests, theoretical best and a sector table per run. */
export function HistoryView({
  route,
  runs,
  sessions,
  reference,
  onOpenRun,
  onCompare,
  onDeleteRun,
  onSessionNotes,
}: Props) {
  const hasStanding = runs.some((r) => r.startMode === 'standing');
  const hasFlying = runs.some((r) => r.startMode === 'flying');
  const initial: StartMode =
    hasFlying && hasStanding ? route.defaultStartMode : hasStanding ? 'standing' : 'flying';
  const [mode, setMode] = useState<StartMode>(initial);
  const [picked, setPicked] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);

  const summary = summarize(runs, mode, route.intervalM);
  const ref = reference?.[mode] ?? summary.best;
  const groups = groupBySession(runs, sessions, mode);
  const sectorCount = Math.max(0, ...runs.map((r) => r.sectorMs.length));

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded border border-neutral-700">
          <button
            type="button"
            className={seg(mode === 'flying')}
            aria-pressed={mode === 'flying'}
            onClick={() => setMode('flying')}
          >
            Flying
          </button>
          <button
            type="button"
            className={seg(mode === 'standing')}
            aria-pressed={mode === 'standing'}
            onClick={() => setMode('standing')}
          >
            Standing
          </button>
        </div>
        <button
          type="button"
          disabled={picked.length !== 2}
          onClick={() => onCompare?.(picked[0] as string, picked[1] as string)}
          className="ml-auto rounded border border-neutral-700 px-3 py-2 disabled:text-neutral-500"
        >
          Compare {picked.length}/2
        </button>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Summary">
        <div className="rounded bg-neutral-900 p-3">
          <dt className="text-xs text-neutral-400">Best</dt>
          <dd className="font-mono text-2xl tabular-nums" data-testid="best">
            {formatTime(summary.best?.totalMs ?? null)}
          </dd>
        </div>
        <div className="rounded bg-neutral-900 p-3">
          <dt className="text-xs text-neutral-400">Theoretical best</dt>
          <dd className="font-mono text-2xl tabular-nums" data-testid="theoretical">
            {formatTime(summary.theoreticalBestMs ?? null)}
          </dd>
        </div>
        <div className="rounded bg-neutral-900 p-3">
          <dt className="text-xs text-neutral-400">Possible gain</dt>
          <dd className="font-mono text-2xl tabular-nums">
            {summary.best && summary.theoreticalBestMs !== undefined
              ? formatGap(summary.theoreticalBestMs - summary.best.totalMs)
              : '–'}
          </dd>
        </div>
        <div className="rounded bg-neutral-900 p-3">
          <dt className="text-xs text-neutral-400">Runs (valid)</dt>
          <dd className="text-2xl">
            {summary.runCount} ({summary.validCount})
          </dd>
        </div>
      </dl>

      {groups.length === 0 ? (
        <p className="text-neutral-400">No {mode}-start runs on this route yet.</p>
      ) : (
        groups.map((g) => (
          <section key={g.session.id} className="space-y-2" aria-label="Session">
            <header className="flex flex-wrap items-baseline gap-x-3">
              <h2 className="font-medium">{dateTime.format(g.session.startedAt)}</h2>
              <span className="text-sm text-neutral-400">
                {g.runs.length} run{g.runs.length === 1 ? '' : 's'}
                {g.best && ` · best ${formatTime(g.best.totalMs)}`}
              </span>
            </header>
            <SessionNotes
              key={g.session.notes ?? ''}
              session={g.session}
              onSave={(n) => onSessionNotes(g.session.id, n)}
            />
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="text-left text-xs text-neutral-400">
                    <th className="w-6 p-1">
                      <span className="sr-only">Compare</span>
                    </th>
                    <th className="p-1">Time</th>
                    <th className="p-1">Δ ref</th>
                    {Array.from({ length: sectorCount }, (_, i) => (
                      <th key={i} className="p-1 text-right">
                        S{i + 1}
                      </th>
                    ))}
                    <th className="p-1" />
                  </tr>
                </thead>
                <tbody>
                  {g.runs.map((r) => {
                    const cells = sectorCells(r, ref, summary.bestSectors, route.intervalM);
                    const status = runStatus(r);
                    return (
                      <tr
                        key={r.id}
                        className={`border-t border-neutral-800 ${r.valid ? '' : 'text-neutral-500'}`}
                        data-testid="run-row"
                      >
                        <td className="p-1">
                          <input
                            type="checkbox"
                            aria-label={`Pick ${formatTime(r.totalMs)} to compare`}
                            checked={picked.includes(r.id)}
                            onChange={() => toggle(r.id)}
                            className="accent-amber-400"
                          />
                        </td>
                        <td className="whitespace-nowrap p-1">
                          <button
                            type="button"
                            onClick={() => onOpenRun?.(r.id)}
                            className="font-mono tabular-nums underline-offset-2 hover:underline"
                          >
                            {formatTime(r.totalMs)}
                          </button>
                          {r.id === ref?.id && (
                            <span className="ml-1 text-xs text-amber-400">ref</span>
                          )}
                          {r.lapNumber > 1 && (
                            <span className="ml-1 text-xs text-neutral-400">L{r.lapNumber}</span>
                          )}
                          {status && (
                            <span className="block text-xs text-neutral-400">{status}</span>
                          )}
                        </td>
                        <td className="p-1 font-mono tabular-nums">
                          {ref && r.id !== ref.id ? formatGap(r.totalMs - ref.totalMs) : ''}
                        </td>
                        {cells.map((c, i) => (
                          <td
                            key={i}
                            className={`p-1 text-right font-mono tabular-nums ${CELL[c.color]} ${c.estimated ? 'italic opacity-70' : ''}`}
                            data-color={c.color}
                          >
                            {(c.ms / 1000).toFixed(2)}
                          </td>
                        ))}
                        {Array.from({ length: sectorCount - cells.length }, (_, i) => (
                          <td key={`pad${i}`} />
                        ))}
                        <td className="whitespace-nowrap p-1 text-right">
                          {confirming === r.id ? (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setConfirming(null);
                                  setPicked((p) => p.filter((x) => x !== r.id));
                                  onDeleteRun(r.id);
                                }}
                                className="rounded bg-red-600 px-2 py-0.5 text-xs"
                              >
                                Delete
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirming(null)}
                                className="px-2 py-0.5 text-xs"
                              >
                                Keep
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirming(r.id)}
                              className="px-2 py-0.5 text-xs text-red-400"
                              aria-label={`Delete run ${formatTime(r.totalMs)}`}
                            >
                              ✕
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
      {summary.bestSectors.length > 0 && (
        <p className="text-xs text-neutral-400">
          Purple = best sector of all runs, green/red = faster/slower than the reference. Italic =
          estimated (GPS gap).
        </p>
      )}
    </div>
  );
}
