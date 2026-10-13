import { useEffect, useState } from 'react';
import type { Clock } from '../engine/clock';

/** The clock's time, refreshed every animation frame while `active` (60 fps running clock, §9.3). */
export function useNow(clock: Clock, active: boolean): number {
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    if (!active) return;
    let id = 0;
    const loop = () => {
      setNow(clock.now());
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [clock, active]);
  return active ? now : clock.now();
}
