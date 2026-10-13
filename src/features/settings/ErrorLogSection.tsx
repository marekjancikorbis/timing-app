import { useState, useSyncExternalStore } from 'react';
import { clearErrorLog, type ErrorEntry, getErrorLog, subscribeErrorLog } from '../../app/errors';

const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' });

// getErrorLog parses storage each call; cache by the raw string so useSyncExternalStore is stable.
let cache: { raw: string; log: ErrorEntry[] } = { raw: '', log: [] };
function snapshot(): ErrorEntry[] {
  const log = getErrorLog();
  const raw = JSON.stringify(log);
  if (raw !== cache.raw) cache = { raw, log };
  return cache.log;
}

/** Settings: the errors this device recorded (coordinates already removed), to copy or clear. */
export function ErrorLogSection() {
  const log = useSyncExternalStore(subscribeErrorLog, snapshot);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <section className="space-y-2" aria-label="Error log">
      <h2 className="font-medium">Error log</h2>
      <p className="text-sm text-neutral-400" data-testid="error-count">
        {log.length === 0
          ? 'No errors recorded on this device.'
          : `${log.length} error${log.length === 1 ? '' : 's'} recorded. Locations are removed.`}
      </p>
      {log.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
          >
            {open ? 'Hide' : 'Show'}
          </button>
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(JSON.stringify(log, null, 2))
                .then(() => setCopied(true))
            }
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
          >
            {copied ? 'Copied' : 'Copy for a bug report'}
          </button>
          <button
            type="button"
            onClick={clearErrorLog}
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
          >
            Clear
          </button>
        </div>
      )}
      {open && (
        <ol className="max-h-80 space-y-2 overflow-y-auto text-xs">
          {[...log].reverse().map((e) => (
            <li key={`${e.at}-${e.message}`} className="rounded bg-neutral-900 p-2">
              <div className="text-neutral-400">
                {time.format(e.at)} · {e.source} · {e.path}
              </div>
              <div className="font-mono">{e.message}</div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
