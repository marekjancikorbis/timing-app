// Doppler-aided along-track smoothing (§4.3 C, "light Kalman smoothing").
//
// Phone GPS positions are noisy (σ 2–5 m) but Doppler speed is much better (~0.1–0.3 m/s).
// Distance along the route is estimated as  ∫ speed dt  +  offset,  where the offset (GPS position
// minus integrated speed) changes slowly and is low-pass filtered. Speed integration has no lag,
// so the estimate follows acceleration and braking immediately; only the noise is averaged out.
// Causal: every output uses past fixes only, so live timing is not delayed.

export interface SmootherConfig {
  /** EMA weight for the position offset: lower = smoother, slower to correct speed bias. */
  alpha: number;
  /** Largest correction applied to a raw position, metres. */
  maxCorrectionM: number;
  /** A gap longer than this restarts the filter. */
  maxGapMs: number;
  /**
   * Speeds below this count as standing still. Doppler speed is a magnitude, so its noise at
   * standstill is always positive and would otherwise integrate into a slow forward creep.
   */
  deadbandMps: number;
}

export const DEFAULT_SMOOTHER: SmootherConfig = {
  alpha: 0.25,
  maxCorrectionM: 15,
  maxGapMs: 3000,
  deadbandMps: 0.5,
};

export class AlongTrackSmoother {
  private lastT: number | undefined;
  private lastV = 0;
  private integ = 0;
  private offset = 0;
  private n = 0;

  constructor(private readonly cfg: SmootherConfig = DEFAULT_SMOOTHER) {}

  /**
   * Feed one fix: time (ms), raw distance along the route (m, unwrapped) and device speed (m/s).
   * Returns the smoothed distance. Without a speed the raw value is passed through and the
   * filter restarts.
   */
  update(t: number, sRaw: number, speed: number | null | undefined): number {
    if (speed == null || !Number.isFinite(speed)) {
      this.reset();
      return sRaw;
    }
    if (speed < this.cfg.deadbandMps) speed = 0;
    if (this.lastT === undefined || t - this.lastT > this.cfg.maxGapMs || t <= this.lastT) {
      this.lastT = t;
      this.lastV = speed;
      this.integ = 0;
      this.offset = sRaw;
      this.n = 1;
      return sRaw;
    }
    this.integ += ((this.lastV + speed) / 2) * ((t - this.lastT) / 1000);
    this.lastT = t;
    this.lastV = speed;
    // Plain average while warming up (1/n), then the EMA weight.
    this.n++;
    this.offset += Math.max(this.cfg.alpha, 1 / this.n) * (sRaw - this.integ - this.offset);
    const smoothed = this.integ + this.offset;
    const c = this.cfg.maxCorrectionM;
    return Math.min(sRaw + c, Math.max(sRaw - c, smoothed));
  }

  reset(): void {
    this.lastT = undefined;
  }
}
