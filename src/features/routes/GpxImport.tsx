import { useId, useState } from 'react';
import { formatDistance } from '../editor/preview';
import { type GpxCandidate, parseGpx } from './gpx';

interface Props {
  onPick: (candidate: GpxCandidate) => void;
  label?: string;
}

/** File picker for GPX. One track is taken directly; several are offered as a list. */
export function GpxImport({ onPick, label = 'Import GPX' }: Props) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<GpxCandidate[]>([]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setChoices([]);
    const result = parseGpx(await file.text());
    if (!result.ok) {
      setError(`${file.name}: ${result.error}`);
      return;
    }
    if (result.candidates.length === 1) onPick(result.candidates[0] as GpxCandidate);
    else setChoices(result.candidates);
  };

  return (
    <div className="space-y-2">
      <label
        htmlFor={id}
        className="inline-block cursor-pointer rounded border border-neutral-700 px-3 py-2 hover:bg-neutral-800"
      >
        {label}
      </label>
      <input
        id={id}
        type="file"
        accept=".gpx,application/gpx+xml,application/xml,text/xml"
        className="sr-only"
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      {choices.length > 0 && (
        <div className="rounded border border-neutral-700 p-2">
          <p className="mb-1 text-sm text-neutral-400">This file has several tracks. Pick one:</p>
          <ul>
            {choices.map((c, i) => (
              <li key={`${c.name}-${i}`}>
                <button
                  type="button"
                  className="w-full rounded px-2 py-1 text-left hover:bg-neutral-800"
                  onClick={() => {
                    setChoices([]);
                    onPick(c);
                  }}
                >
                  {c.name} · {c.kind} · {formatDistance(c.lengthM)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
