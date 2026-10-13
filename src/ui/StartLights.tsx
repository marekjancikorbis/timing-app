/**
 * Rally-style lights: one per second of the countdown. They light red one by one as the
 * seconds pass, and all turn green at zero (§5).
 */
export function StartLights({ total, remaining }: { total: number; remaining: number }) {
  const go = remaining <= 0;
  return (
    <ol className="flex justify-center gap-3" aria-label={go ? 'Go' : `${remaining} seconds`}>
      {Array.from({ length: total }, (_, i) => {
        const lit = go || i < total - remaining;
        return (
          <li
            key={i}
            data-lit={lit}
            className={`h-10 w-10 rounded-full border-2 border-neutral-700 ${
              go ? 'bg-green-500' : lit ? 'bg-red-600' : 'bg-neutral-900'
            }`}
          />
        );
      })}
    </ol>
  );
}
