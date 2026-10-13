import type { Fix } from '../engine/filters';
import { Emitter, type GpsSource } from './GpsSource';

/** Parse an NDJSON log (one fix per line, as written by the GPS logger). Bad lines are skipped. */
export function parseNdjson(text: string): Fix[] {
  const out: Fix[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Partial<Fix>;
      if (typeof o.t === 'number' && typeof o.lat === 'number' && typeof o.lon === 'number') {
        out.push({
          t: o.t,
          lat: o.lat,
          lon: o.lon,
          acc: o.acc ?? 5,
          spd: o.spd ?? null,
          hdg: o.hdg ?? null,
          receivedAt: o.receivedAt,
        });
      }
    } catch {
      // ignore malformed lines
    }
  }
  return out;
}

export function toNdjson(fixes: readonly Fix[]): string {
  return fixes.map((f) => JSON.stringify(f)).join('\n') + '\n';
}

/**
 * Replays recorded fixes in real time × `speed`. Timestamps are shifted so the first fix is "now",
 * which keeps the tracker's clock and the fix times consistent.
 */
export class ReplayGps implements GpsSource {
  readonly name: string;
  private fixes = new Emitter<Fix>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private i = 0;

  constructor(
    private readonly log: readonly Fix[],
    private readonly speed = 1,
    name = 'Replay',
  ) {
    this.name = name;
  }

  async start(): Promise<void> {
    this.stop();
    this.i = 0;
    const first = this.log[0];
    if (!first) return;
    const wallStart = performance.timeOrigin + performance.now();
    const realStart = performance.now();
    const step = () => {
      const elapsedLog = (performance.now() - realStart) * this.speed;
      while (this.i < this.log.length && (this.log[this.i] as Fix).t - first.t <= elapsedLog) {
        const f = this.log[this.i++] as Fix;
        const shift = wallStart - first.t;
        // Compress log time into wall time so a 10× replay still looks like 1 Hz to the engine.
        const t = wallStart + (f.t - first.t) / this.speed;
        this.fixes.emit({
          ...f,
          t,
          receivedAt: f.receivedAt !== undefined ? f.receivedAt + shift : undefined,
        });
      }
      if (this.i < this.log.length) this.timer = setTimeout(step, 20);
    };
    step();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  subscribe(onFix: (fix: Fix) => void): () => void {
    return this.fixes.on(onFix);
  }
}
