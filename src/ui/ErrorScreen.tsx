import { Link } from '@tanstack/react-router';

/**
 * Shown when a page fails to render. The error is already recorded by the React root's
 * onCaughtError (main.tsx); this only explains and offers a way out. Timing data is safe: runs are
 * saved as they finish.
 */
export function ErrorScreen({ error, reset }: { error: unknown; reset?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="mx-auto max-w-xl space-y-4 p-4">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-neutral-300">
        This page hit an error. Your saved routes and runs are not affected.
      </p>
      <p className="rounded bg-neutral-900 p-2 font-mono text-sm text-neutral-300">{message}</p>
      <div className="flex flex-wrap gap-2">
        {reset && (
          <button
            type="button"
            onClick={reset}
            className="rounded bg-amber-400 px-3 py-2 font-medium text-black"
          >
            Try again
          </button>
        )}
        <button
          type="button"
          onClick={() => location.reload()}
          className="rounded border border-neutral-700 px-3 py-2"
        >
          Reload the app
        </button>
        <Link to="/" className="rounded border border-neutral-700 px-3 py-2">
          Routes
        </Link>
      </div>
      <p className="text-xs text-neutral-400">The error is listed in Settings → Error log.</p>
    </div>
  );
}
