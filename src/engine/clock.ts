// Injected time source (§4.7). The engine never reads the time itself, so tests can fast-forward.

export interface Clock {
  /** Wall-clock milliseconds since the epoch, from a steady (non-jumping) source. */
  now(): number;
}

/** performance.now() is monotonic; timeOrigin converts it to epoch ms (§4.4 step 5). */
export const systemClock: Clock = {
  now: () => performance.timeOrigin + performance.now(),
};

export class FakeClock implements Clock {
  constructor(private t = 1_700_000_000_000) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): number {
    this.t += ms;
    return this.t;
  }
}
