import { useState } from 'react';
import { type Backup, decodeBackup, type RestoreSummary } from './backup';

interface Props {
  /** Build the backup file and hand it to the browser. */
  onDownload: () => Promise<void>;
  onRestore: (backup: Backup, mode: 'merge' | 'replace') => Promise<RestoreSummary>;
}

type Status = { tone: 'ok' | 'error'; text: string } | null;

/** Settings: download a backup of everything, or restore one (merge or replace, with a confirm). */
export function BackupSection({ onDownload, onRestore }: Props) {
  const [pending, setPending] = useState<{ backup: Backup; fileName: string } | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<Status>) => {
    setBusy(true);
    try {
      setStatus(await work());
    } catch (e) {
      setStatus({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const restore = (mode: 'merge' | 'replace') =>
    run(async () => {
      if (!pending) return null;
      const r = await onRestore(pending.backup, mode);
      setPending(null);
      return {
        tone: 'ok',
        text: `Restored ${r.routes} route${r.routes === 1 ? '' : 's'}, ${r.runs} run${r.runs === 1 ? '' : 's'} and ${r.gpsLogs} GPS log${r.gpsLogs === 1 ? '' : 's'}.`,
      };
    });

  return (
    <section className="space-y-2" aria-label="Backup">
      <h2 className="font-medium">Backup</h2>
      <p className="text-xs text-neutral-400">
        Everything (routes, runs, traces, GPS logs, settings) in one file. Your OpenRouteService key
        is not included.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await onDownload();
              return { tone: 'ok', text: 'Backup downloaded.' };
            })
          }
          className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
        >
          Download backup
        </button>
        <label className="cursor-pointer rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800">
          Restore from file…
          <input
            type="file"
            accept=".gz,.json,application/gzip,application/json"
            aria-label="Restore backup file"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              void run(async () => {
                const parsed = decodeBackup(new Uint8Array(await file.arrayBuffer()));
                if (!parsed.ok) return { tone: 'error', text: parsed.error };
                setPending({ backup: parsed.backup, fileName: file.name });
                return null;
              });
            }}
          />
        </label>
      </div>
      {pending && (
        <div className="space-y-2 rounded border border-amber-400/50 p-3" role="dialog">
          <p className="text-sm">
            {pending.fileName}: {pending.backup.routes.length} routes, {pending.backup.runs.length}{' '}
            runs, from {new Date(pending.backup.exportedAt).toLocaleString()}.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void restore('merge')}
              className="rounded bg-amber-400 px-3 py-1.5 text-sm text-neutral-950"
            >
              Add to my data
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void restore('replace')}
              className="rounded bg-red-600 px-3 py-1.5 text-sm"
            >
              Replace all my data
            </button>
            <button type="button" onClick={() => setPending(null)} className="px-3 py-1.5 text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}
      {status && (
        <p
          role={status.tone === 'error' ? 'alert' : 'status'}
          className={`text-sm ${status.tone === 'error' ? 'text-red-400' : 'text-green-400'}`}
        >
          {status.text}
        </p>
      )}
    </section>
  );
}
