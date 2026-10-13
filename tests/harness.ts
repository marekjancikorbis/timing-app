import { FakeClock } from '../src/engine/clock';
import type { Fix } from '../src/engine/filters';
import { createProjection, type LonLat } from '../src/engine/geo';
import type { PreparedRoute } from '../src/engine/route';
import {
  type RunResult,
  Tracker,
  type TrackerEvent,
  type TrackerOptions,
} from '../src/engine/tracker';

export const BASE_T = 1_700_000_000_000;
export const LON0 = 14.42;
export const LAT0 = 50.08;
const proj = createProjection(LON0, LAT0);

/** Local metres (east, north) → [lon, lat], using the same projection the route will use. */
export function ll(x: number, y = 0): LonLat {
  return proj.toLonLat({ x, y });
}

/** A fix at local position (x, y) metres, `ms` after BASE_T. */
export function fixAt(x: number, y: number, ms: number, extra: Partial<Fix> = {}): Fix {
  const [lon, lat] = ll(x, y);
  return { t: BASE_T + ms, lat, lon, acc: 4, spd: null, receivedAt: BASE_T + ms, ...extra };
}

/** Straight stage heading east from (0,0), `lengthM` long. */
export function straightGeometry(lengthM: number): LonLat[] {
  return [ll(0), ll(lengthM)];
}

export interface DriveOptions {
  /** Tap START at the first moment at or after this epoch ms when the tracker is staged. */
  startCountdownAt?: number;
  tickMs?: number;
}

export interface Drive {
  tracker: Tracker;
  clock: FakeClock;
  events: TrackerEvent[];
  of<K extends TrackerEvent['type']>(type: K): Extract<TrackerEvent, { type: K }>[];
  runs(): RunResult[];
}

export function makeTracker(route: PreparedRoute, opts: Partial<TrackerOptions> = {}): Drive {
  const clock = new FakeClock(BASE_T - 1000);
  const tracker = new Tracker(route, { clock, ...opts });
  const events: TrackerEvent[] = [];
  tracker.on((e) => events.push(e));
  return {
    tracker,
    clock,
    events,
    of: <K extends TrackerEvent['type']>(type: K) =>
      events.filter((e): e is Extract<TrackerEvent, { type: K }> => e.type === type),
    runs: () =>
      events.flatMap((e) =>
        e.type === 'lap' || e.type === 'finish' || (e.type === 'aborted' && e.run)
          ? [e.run as RunResult]
          : [],
      ),
  };
}

/** Feed fixes in delivery order, ticking the clock in between like a real rAF loop would. */
export function feed(d: Drive, fixes: readonly Fix[], o: DriveOptions = {}): void {
  const tickMs = o.tickMs ?? 50;
  let tapped = false;
  for (const f of fixes) {
    const at = f.receivedAt ?? f.t;
    while (d.clock.now() + tickMs < at) {
      d.clock.advance(tickMs);
      maybeTap();
      d.tracker.tick();
    }
    d.clock.set(Math.max(d.clock.now(), at));
    maybeTap();
    d.tracker.onFix(f);
  }
  function maybeTap(): void {
    if (tapped || o.startCountdownAt === undefined || d.clock.now() < o.startCountdownAt) return;
    tapped = d.tracker.startCountdown(); // keeps trying on later ticks until staged
  }
}
