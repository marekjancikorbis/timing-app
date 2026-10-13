// Service worker registration, update and install state (Phase 5). The store is plain Zustand so
// the banner can be tested by setting state; `registerPwa` wires it to the browser once at startup.

import { create } from 'zustand';

/** Chrome/Edge/Android's install event (not in the DOM typings). */
export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface PwaState {
  /** A new version is installed and waiting. */
  updateReady: boolean;
  /** Everything is cached: the app works offline from now on. */
  offlineReady: boolean;
  /** The browser offered to install the app (not on iOS: there it's Share → Add to Home Screen). */
  installEvent: InstallPromptEvent | null;
  /** Activates the waiting version and reloads. */
  applyUpdate: () => void;
  dismissUpdate: () => void;
  dismissOfflineReady: () => void;
  install: () => Promise<void>;
}

export const usePwa = create<PwaState>((set, get) => ({
  updateReady: false,
  offlineReady: false,
  installEvent: null,
  applyUpdate: () => {},
  dismissUpdate: () => set({ updateReady: false }),
  dismissOfflineReady: () => set({ offlineReady: false }),
  async install() {
    const e = get().installEvent;
    if (!e) return;
    set({ installEvent: null }); // the event can only be used once
    await e.prompt();
  },
}));

/** Register the service worker (production builds only) and listen for the install offer. */
export async function registerPwa(): Promise<void> {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // show our own button instead of the browser's mini-bar
    usePwa.setState({ installEvent: e as InstallPromptEvent });
  });
  window.addEventListener('appinstalled', () => usePwa.setState({ installEvent: null }));

  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const { registerSW } = await import('virtual:pwa-register');
  const update = registerSW({
    onNeedRefresh: () => usePwa.setState({ updateReady: true }),
    onOfflineReady: () => usePwa.setState({ offlineReady: true }),
  });
  usePwa.setState({ applyUpdate: () => void update(true) });
}
