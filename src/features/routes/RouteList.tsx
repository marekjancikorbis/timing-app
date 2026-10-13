import { useState } from 'react';
import type { Route } from '../../data/types';
import { formatDistance } from '../editor/preview';

interface Props {
  routes: Route[];
  onOpen: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  /** Start timing on this route. */
  onDrive?: (id: string) => void;
  /** Open the route's history. */
  onHistory?: (id: string) => void;
  units?: 'metric' | 'imperial';
}

/** Saved routes (§3.2 MVP 3): open, rename, delete (with a confirm step). */
export function RouteList({
  routes,
  onOpen,
  onRename,
  onDelete,
  onDrive,
  onHistory,
  units = 'metric',
}: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);

  if (routes.length === 0) {
    return (
      <p className="text-neutral-400">No routes yet. Draw one, record one, or import a GPX file.</p>
    );
  }

  return (
    <ul className="divide-y divide-neutral-800">
      {routes.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-2 py-3">
          {editing === r.id ? (
            <form
              className="flex flex-1 gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (draftName.trim()) onRename(r.id, draftName.trim());
                setEditing(null);
              }}
            >
              <input
                aria-label="Route name"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
              />
              <button type="submit" className="rounded bg-amber-400 px-3 py-1 text-neutral-950">
                Save
              </button>
              <button type="button" onClick={() => setEditing(null)} className="px-2 py-1">
                Cancel
              </button>
            </form>
          ) : (
            <>
              <button type="button" onClick={() => onOpen(r.id)} className="flex-1 text-left">
                <span className="block font-medium">{r.name}</span>
                <span className="text-sm text-neutral-400">
                  {r.type === 'circuit' ? 'Circuit' : 'Stage'} · {formatDistance(r.lengthM, units)}{' '}
                  · {r.intervalM} m sectors
                </span>
              </button>
              {onDrive && (
                <button
                  type="button"
                  onClick={() => onDrive(r.id)}
                  className="rounded bg-amber-400 px-3 py-1 text-sm font-medium text-neutral-950"
                >
                  Drive
                </button>
              )}
              {onHistory && (
                <button
                  type="button"
                  onClick={() => onHistory(r.id)}
                  className="rounded border border-neutral-700 px-3 py-1 text-sm hover:bg-neutral-800"
                >
                  History
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setDraftName(r.name);
                  setEditing(r.id);
                }}
                className="px-2 py-1 text-sm"
              >
                Rename
              </button>
              {confirming === r.id ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirming(null);
                      onDelete(r.id);
                    }}
                    className="rounded bg-red-600 px-2 py-1 text-sm"
                  >
                    Delete with all runs
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="px-2 py-1 text-sm"
                  >
                    Keep
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(r.id)}
                  className="px-2 py-1 text-sm text-red-400"
                >
                  Delete
                </button>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
