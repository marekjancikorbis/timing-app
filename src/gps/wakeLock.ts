// Keep the screen on during a run (§2.1, R2). Re-acquired when the page becomes visible again.

let sentinel: WakeLockSentinel | null = null;
let wanted = false;

async function acquire(): Promise<void> {
  if (!wanted || sentinel || !('wakeLock' in navigator)) return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch {
    // Denied (e.g. low battery or page hidden); retried on the next visibility change.
  }
}

function onVisibility(): void {
  if (document.visibilityState === 'visible') void acquire();
}

export function wakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

export async function keepScreenOn(): Promise<void> {
  wanted = true;
  document.addEventListener('visibilitychange', onVisibility);
  await acquire();
}

export function releaseScreen(): void {
  wanted = false;
  document.removeEventListener('visibilitychange', onVisibility);
  void sentinel?.release();
  sentinel = null;
}

export function screenIsLocked(): boolean {
  return sentinel !== null;
}
