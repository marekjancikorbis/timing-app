import { usePwa } from '../app/pwa';

/**
 * "New version" and "works offline" notices. Hidden while driving (`quiet`): nothing should pop up
 * on the drive screen, and reloading there would end the run.
 */
export function PwaBanner({ quiet }: { quiet: boolean }) {
  const { updateReady, offlineReady, applyUpdate, dismissUpdate, dismissOfflineReady } = usePwa();
  if (quiet) return null;
  if (updateReady) {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center gap-2 bg-amber-400 px-3 py-2 text-sm text-neutral-950"
      >
        <span className="mr-auto">A new version of Lap Timer is ready.</span>
        <button
          type="button"
          onClick={applyUpdate}
          className="rounded bg-neutral-950 px-3 py-1 text-white"
        >
          Reload
        </button>
        <button type="button" onClick={dismissUpdate} className="px-2 py-1">
          Later
        </button>
      </div>
    );
  }
  if (offlineReady) {
    return (
      <div role="status" className="flex items-center gap-2 bg-neutral-800 px-3 py-2 text-sm">
        <span className="mr-auto">Lap Timer now works offline.</span>
        <button type="button" onClick={dismissOfflineReady} className="px-2 py-1">
          OK
        </button>
      </div>
    );
  }
  return null;
}

/** Shown only when the browser offers installation. */
export function InstallButton() {
  const { installEvent, install } = usePwa();
  if (!installEvent) return null;
  return (
    <button
      type="button"
      onClick={() => void install()}
      className="rounded border border-amber-400 px-3 py-1 text-sm text-amber-400"
    >
      Install app
    </button>
  );
}
