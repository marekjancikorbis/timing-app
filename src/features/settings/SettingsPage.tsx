import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { settingsRepo } from '../../app/services';
import { requestPersistentStorage } from '../../data/db';
import type { Settings } from '../../data/types';

const field = 'rounded border border-neutral-700 bg-neutral-900 px-2 py-1';

export function SettingsPage() {
  const settings = useLiveQuery(() => settingsRepo.get(), []);
  const [key, setKey] = useState('');
  const [persisted, setPersisted] = useState<boolean | null>(null);
  useEffect(() => {
    if (settings) setKey(settings.orsApiKey);
  }, [settings]);

  if (!settings) return <p className="p-4 text-neutral-400">Loading…</p>;
  const update = (patch: Partial<Settings>) => void settingsRepo.update(patch);

  return (
    <div className="mx-auto max-w-xl space-y-6 p-4">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <label className="flex items-center justify-between gap-3">
        <span>Units</span>
        <select
          className={field}
          value={settings.units}
          onChange={(e) => update({ units: e.target.value as Settings['units'] })}
        >
          <option value="metric">Metric (km, m)</option>
          <option value="imperial">Imperial (mi, ft)</option>
        </select>
      </label>

      <label className="flex items-center justify-between gap-3">
        <span>Audio callouts</span>
        <select
          className={field}
          value={settings.audioCallouts}
          onChange={(e) => update({ audioCallouts: e.target.value as Settings['audioCallouts'] })}
        >
          <option value="off">Off</option>
          <option value="beep">Beeps</option>
          <option value="voice">Voice</option>
        </select>
      </label>

      <label className="flex items-center justify-between gap-3">
        <span>A jump start invalidates the run</span>
        <input
          type="checkbox"
          checked={settings.jumpStartInvalidates}
          onChange={(e) => update({ jumpStartInvalidates: e.target.checked })}
          className="h-5 w-5 accent-amber-400"
        />
      </label>

      <form
        className="space-y-1"
        onSubmit={(e) => {
          e.preventDefault();
          update({ orsApiKey: key.trim() });
        }}
      >
        <label className="block space-y-1">
          <span>OpenRouteService API key (for snap to roads)</span>
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className={`${field} w-full`}
          />
        </label>
        <p className="text-xs text-neutral-400">
          Free at openrouteservice.org. Stored only on this device; used only while creating routes.
        </p>
        <button
          type="submit"
          className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
        >
          Save key
        </button>
      </form>

      <div className="space-y-1">
        <button
          type="button"
          className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
          onClick={() => void requestPersistentStorage().then(setPersisted)}
        >
          Keep my data (persistent storage)
        </button>
        {persisted !== null && (
          <p className="text-xs text-neutral-400">
            {persisted
              ? 'Storage is persistent.'
              : 'The browser declined; export backups regularly.'}
          </p>
        )}
      </div>
    </div>
  );
}
