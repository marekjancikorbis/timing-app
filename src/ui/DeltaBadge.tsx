import { formatGap } from '../features/live/liveModel';

/** Gap to the reference: green when ahead, red when behind. */
export function DeltaBadge({
  ms,
  label,
  className = '',
}: {
  ms: number | null;
  label: string;
  className?: string;
}) {
  const tone = ms === null ? 'text-neutral-400' : ms <= 0 ? 'text-green-400' : 'text-red-400';
  return (
    <div
      className={`font-mono tabular-nums leading-none ${tone} ${className}`}
      aria-label={label}
      data-testid={label}
    >
      {formatGap(ms)}
    </div>
  );
}
