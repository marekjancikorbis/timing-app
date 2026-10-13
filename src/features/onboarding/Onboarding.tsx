import { useState } from 'react';

/** Per device: whoever holds this phone has read how it works and accepted the safety terms. */
export const ONBOARDED_KEY = 'laptimer-onboarded';

export function isOnboarded(
  storage: Pick<Storage, 'getItem'> | undefined = safeStorage(),
): boolean {
  try {
    return storage?.getItem(ONBOARDED_KEY) === '1';
  } catch {
    return false;
  }
}

export function markOnboarded(storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  try {
    storage?.setItem(ONBOARDED_KEY, '1');
  } catch {
    // storage blocked: the welcome shows again next time, which is harmless
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** iOS Safari outside the installed app: geolocation and the wake lock work best from the icon. */
export function needsIosInstallHint(nav: Navigator = navigator): boolean {
  const ios = /iPad|iPhone|iPod/.test(nav.userAgent);
  const standalone = (nav as Navigator & { standalone?: boolean }).standalone === true;
  return ios && !standalone;
}

const STEPS = [
  {
    title: 'Make a route',
    text: 'Draw it on the map, import a GPX file, or record it by driving once. Set the sector length (100–1000 m).',
  },
  {
    title: 'Arm and drive',
    text: 'Flying start: timing begins at the start line. Standing start: stop at the line, tap START, and go at zero. Runs save themselves.',
  },
  {
    title: 'Analyse',
    text: 'History shows your best, the theoretical best and every sector. Open a run for the gap and speed charts and the map.',
  },
];

/** First-run welcome (Phase 5): how it works, setup tips, and the safety terms to accept. */
export function Onboarding({ onDone, iosHint }: { onDone: () => void; iosHint: boolean }) {
  const [accepted, setAccepted] = useState(false);
  return (
    <div className="mx-auto max-w-xl space-y-6 p-4">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold text-amber-400">Lap Timer</h1>
        <p className="text-neutral-300">
          GPS timing for circuits and rally stages, with sectors and a live gap to your best run.
        </p>
      </header>

      <ol className="space-y-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-3">
            <span
              aria-hidden
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-400 font-semibold text-black"
            >
              {i + 1}
            </span>
            <span>
              <strong className="block">{s.title}</strong>
              <span className="text-sm text-neutral-400">{s.text}</span>
            </span>
          </li>
        ))}
      </ol>

      <section className="space-y-1 rounded bg-neutral-900 p-3 text-sm">
        <h2 className="font-medium">Before your first run</h2>
        <ul className="list-disc space-y-1 pl-5 text-neutral-300">
          <li>Allow location access when asked. Timing needs precise GPS.</li>
          <li>
            Mount the phone with the screen on. The browser pauses GPS when the screen locks, so the
            app keeps it awake while armed.
          </li>
          <li>
            Phone GPS is good to about ±0.1–0.3 s: right for improving, not for official results.
          </li>
          {iosHint && (
            <li>
              On iPhone, tap Share → <strong>Add to Home Screen</strong> and open Lap Timer from
              there.
            </li>
          )}
        </ul>
      </section>

      <label className="flex items-start gap-3 rounded border border-amber-400/60 p-3">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(e) => setAccepted(e.target.checked)}
          className="mt-1 h-5 w-5 shrink-0 accent-amber-400"
        />
        <span>
          I will use Lap Timer only on <strong>closed tracks and closed roads</strong>, and I won't
          look at or touch the phone while driving.
        </span>
      </label>

      <button
        type="button"
        disabled={!accepted}
        onClick={() => {
          markOnboarded();
          onDone();
        }}
        className="w-full rounded bg-amber-400 py-3 text-lg font-semibold text-black disabled:bg-neutral-800 disabled:text-neutral-500"
      >
        Start
      </button>
    </div>
  );
}
