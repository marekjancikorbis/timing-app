// Error monitoring (§9.5, Phase 5). Every uncaught error is kept in a small local log (Settings →
// Error log) and, when the build has a Sentry DSN (VITE_SENTRY_DSN), sent to Sentry. Location data
// is personal: coordinates are scrubbed from everything before it is stored or sent.

const LOG_KEY = 'laptimer-errors';
const LOG_MAX = 50;

export interface ErrorEntry {
  at: number;
  message: string;
  stack?: string;
  /** Where it came from: 'window', 'promise', 'render', 'route'… */
  source: string;
  path: string;
}

/** Keys whose values are positions. */
const COORD_KEY = /^(lat|lon|lng|latitude|longitude|coords?|position|geometry|points?|trace)$/i;
/** A decimal number with 4+ decimals in coordinate range: GPS-precision lat/lon in text. */
const COORD_NUMBER = /-?\b(?:1[0-7]\d|\d{1,2}|180)\.\d{4,}\b/g;

/** Remove anything that could locate the user: coordinate-like numbers and position fields. */
export function scrub<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return value.replace(COORD_NUMBER, '[coord]') as T;
  if (value === null || typeof value !== 'object') return value;
  if (depth > 10) return '[…]' as T; // never pass on what wasn't checked
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = COORD_KEY.test(k) ? '[removed]' : scrub(v, depth + 1);
  }
  return out as T;
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function getErrorLog(): ErrorEntry[] {
  try {
    const raw = storage()?.getItem(LOG_KEY);
    return raw ? (JSON.parse(raw) as ErrorEntry[]) : [];
  } catch {
    return [];
  }
}

export function clearErrorLog(): void {
  try {
    storage()?.removeItem(LOG_KEY);
  } catch {
    // nothing to clear
  }
  notify();
}

const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};
/** For useSyncExternalStore: re-render the log view when an error is recorded. */
export function subscribeErrorLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type Reporter = (error: unknown, source: string) => void;
let remote: Reporter | null = null;

/** Record an error locally (scrubbed, newest last, capped) and report it if Sentry is set up. */
export function recordError(error: unknown, source: string, now = Date.now()): ErrorEntry {
  const e = error instanceof Error ? error : new Error(String(error));
  const entry: ErrorEntry = scrub({
    at: now,
    message: e.message || e.name,
    stack: e.stack?.split('\n').slice(0, 12).join('\n'),
    source,
    path: typeof location === 'undefined' ? '' : location.pathname,
  });
  try {
    const log = [...getErrorLog(), entry].slice(-LOG_MAX);
    storage()?.setItem(LOG_KEY, JSON.stringify(log));
  } catch {
    // storage full or blocked: still report remotely
  }
  remote?.(error, source);
  notify();
  return entry;
}

/** Catch what nothing else catches. Call once at startup. */
export function installGlobalHandlers(target: Window = window): void {
  target.addEventListener('error', (ev) => recordError(ev.error ?? ev.message, 'window'));
  target.addEventListener('unhandledrejection', (ev) => recordError(ev.reason, 'promise'));
}

/** Send errors to Sentry when the build has a DSN. Without one, Sentry isn't even downloaded. */
export async function initRemoteReporting(): Promise<void> {
  // Read here, not as a parameter: with no DSN at build time the bundler drops the import below,
  // so Sentry is neither shipped nor precached.
  const dsn: string | undefined = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;
  const Sentry = await import('@sentry/browser');
  Sentry.init({
    dsn,
    // Our handlers report; Sentry's own global handlers would double-count.
    integrations: (defaults) =>
      defaults.filter((i) => i.name !== 'GlobalHandlers' && i.name !== 'Breadcrumbs'),
    beforeSend: (event) => scrub(event),
  });
  remote = (error, source) => Sentry.captureException(error, { tags: { source } });
}

/** For tests. */
export function setRemoteReporter(r: Reporter | null): void {
  remote = r;
}
