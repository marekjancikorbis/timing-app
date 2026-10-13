import type { SectorCell } from '../features/live/liveModel';

const COLORS: Record<SectorCell['color'], string> = {
  purple: 'bg-purple-500',
  green: 'bg-green-500',
  red: 'bg-red-500',
  neutral: 'bg-neutral-400',
  pending: 'bg-neutral-800',
};

/** One cell per sector: purple = best ever, green = faster than the reference, red = slower. */
export function SectorStrip({ sectors }: { sectors: readonly SectorCell[] }) {
  return (
    <ol className="flex h-4 w-full gap-0.5" aria-label="Sectors">
      {sectors.map((c, i) => (
        <li
          key={i}
          className={`flex-1 rounded-sm ${COLORS[c.color]} ${c.estimated ? 'opacity-60' : ''}`}
          data-color={c.color}
          title={
            c.ms !== undefined
              ? `Sector ${i + 1}: ${(c.ms / 1000).toFixed(2)} s`
              : `Sector ${i + 1}`
          }
        />
      ))}
    </ol>
  );
}
