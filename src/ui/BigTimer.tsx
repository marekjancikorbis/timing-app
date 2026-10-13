import { formatTime } from '../features/live/liveModel';

/** Running time in large, equal-width digits so they don't jitter (§5). */
export function BigTimer({ ms, className = '' }: { ms: number | null; className?: string }) {
  return (
    <div className={`font-mono tabular-nums leading-none ${className}`} data-testid="timer">
      {formatTime(ms, 1)}
    </div>
  );
}
