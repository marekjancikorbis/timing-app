import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { gpsLogsRepo } from '../../app/services';
import type { GpsLog } from '../../data/types';
import type { Fix } from '../../engine/filters';
import { BrowserGps } from '../../gps/browserGps';
import type { GpsStatus } from '../../gps/GpsSource';
import { parseNdjson, toNdjson } from '../../gps/replayGps';
import { analyzeLog, exitChecks } from './analyze';

const BATCH = 10;

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Report({ fixes }: { fixes: readonly Fix[] }) {
  const stats = useMemo(() => analyzeLog(fixes), [fixes]);
  if (!stats) return <p className="text-sm text-neutral-400">No fixes yet.</p>;
  return (
    <ul className="space-y-1 text-sm">
      {exitChecks(stats).map((c) => (
        <li key={c.label}>
          <span className={c.ok ? 'text-green-400' : 'text-red-400'}>{c.ok ? '✓' : '✗'}</span>{' '}
          {c.label}
          <div className="ml-5 text-neutral-400">{c.detail}</div>
        </li>
      ))}
      <li className="text-neutral-400">
        Doppler speed on{' '}
        {Number.isFinite(stats.speedReportedShare)
          ? `${Math.round(stats.speedReportedShare * 100)}%`
          : 'n/a'}{' '}
        of moving fixes
        {stats.speedBiasMps !== undefined && ` (bias ${stats.speedBiasMps.toFixed(2)} m/s)`}
      </li>
    </ul>
  );
}

/** Phase 0 (§7): log every fix with the screen on, then judge whether this phone is good enough. */
export function LoggerPage() {
  const logs = useLiveQuery(() => gpsLogsRepo.list(), []);
  const [active, setActive] = useState<GpsLog | null>(null);
  const [live, setLive] = useState<Fix[]>([]);
  const [status, setStatus] = useState<{ status: GpsStatus; message?: string }>({ status: 'idle' });
  const [selected, setSelected] = useState<{ name: string; fixes: Fix[] } | null>(null);
  const gps = useRef<BrowserGps | null>(null);
  const buffer = useRef<Fix[]>([]);

  const flush = async (id: string) => {
    const batch = buffer.current;
    buffer.current = [];
    await gpsLogsRepo.append(id, batch);
  };

  useEffect(() => () => gps.current?.stop(), []);

  const start = async () => {
    const log = await gpsLogsRepo.create(`Log ${new Date().toLocaleString()}`);
    setActive(log);
    setLive([]);
    const source = new BrowserGps();
    gps.current = source;
    source.onStatus((s, message) => setStatus({ status: s, message }));
    source.subscribe((fix) => {
      buffer.current.push(fix);
      setLive((prev) => [...prev, fix]);
      if (buffer.current.length >= BATCH) void flush(log.id);
    });
    await source.start();
  };

  const stop = async () => {
    gps.current?.stop();
    gps.current = null;
    if (active) await flush(active.id);
    setActive(null);
  };

  const last = live.at(-1);
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4">
      <h1 className="text-2xl font-semibold">GPS logger (Phase 0)</h1>
      <p className="text-sm text-neutral-400">
        Logs every GPS fix to this device. Drive a known loop several times, and also stay parked
        for 2–3 minutes, then check the results below against the go/no-go criteria.
      </p>

      <section className="space-y-3 rounded border border-neutral-800 p-3">
        <div className="flex items-center gap-3">
          {active ? (
            <button
              type="button"
              onClick={() => void stop()}
              className="rounded border border-neutral-600 px-4 py-2"
            >
              Stop logging
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void start()}
              className="rounded bg-red-600 px-4 py-2 font-medium"
            >
              Start logging
            </button>
          )}
          <span className="text-sm text-neutral-400">
            GPS {status.status}
            {last &&
              ` · ${live.length} fixes · ±${last.acc.toFixed(1)} m · ${last.spd != null ? `${(last.spd * 3.6).toFixed(0)} km/h` : 'no speed'}`}
          </span>
        </div>
        {status.message && <p className="text-sm text-red-400">{status.message}</p>}
        {active && <Report fixes={live} />}
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-3">
          <h2 className="mr-auto text-lg font-medium">Saved logs</h2>
          <label className="cursor-pointer rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800">
            Analyse an NDJSON file
            <input
              type="file"
              accept=".ndjson,.jsonl,.json,.txt"
              className="sr-only"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setSelected({ name: file.name, fixes: parseNdjson(await file.text()) });
                e.target.value = '';
              }}
            />
          </label>
        </div>
        <ul className="divide-y divide-neutral-800">
          {(logs ?? []).map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <button
                type="button"
                className="flex-1 text-left"
                onClick={() => setSelected({ name: l.name, fixes: l.fixes })}
              >
                {l.name} <span className="text-neutral-400">· {l.fixes.length} fixes</span>
              </button>
              <button
                type="button"
                className="px-2"
                onClick={() =>
                  download(`${l.name.replace(/[^\w-]+/g, '_')}.ndjson`, toNdjson(l.fixes))
                }
              >
                Download
              </button>
              <button
                type="button"
                className="px-2 text-red-400"
                onClick={() => void gpsLogsRepo.remove(l.id)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
        {selected && (
          <div className="space-y-2 rounded border border-neutral-800 p-3">
            <h3 className="font-medium">{selected.name}</h3>
            <Report fixes={selected.fixes} />
          </div>
        )}
      </section>
    </div>
  );
}
