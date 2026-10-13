// Fix validation (§4.3 C). Rejected fixes are still logged by the caller, just flagged.

import { haversineM } from './geo';

/** One GPS fix, normalised from the Geolocation API (or a replay / simulator). */
export interface Fix {
  /** Fix timestamp, epoch ms (position.timestamp). */
  t: number;
  lat: number;
  lon: number;
  /** Horizontal accuracy in metres. */
  acc: number;
  /** Speed in m/s, if the device reported it. */
  spd?: number | null;
  /** Heading in degrees, if the device reported it. */
  hdg?: number | null;
  /** When the callback ran, epoch ms (for clock-offset diagnostics). */
  receivedAt?: number;
}

export type RejectReason = 'accuracy' | 'duplicate' | 'out-of-order' | 'jump';

export interface FilterConfig {
  maxAccuracyM: number;
  maxSpeedMps: number;
}

export const DEFAULT_FILTER: FilterConfig = {
  maxAccuracyM: 25,
  maxSpeedMps: 300 / 3.6,
};

export class FixFilter {
  private last: Fix | null = null;

  constructor(private readonly cfg: FilterConfig = DEFAULT_FILTER) {}

  /** Returns null if the fix is accepted, otherwise why it was rejected. */
  check(fix: Fix): RejectReason | null {
    if (!(fix.acc <= this.cfg.maxAccuracyM)) return 'accuracy';
    const last = this.last;
    if (last) {
      if (fix.t === last.t) return 'duplicate';
      if (fix.t < last.t) return 'out-of-order';
      const d = haversineM(last.lon, last.lat, fix.lon, fix.lat);
      if (d / ((fix.t - last.t) / 1000) > this.cfg.maxSpeedMps) return 'jump';
    }
    this.last = fix;
    return null;
  }

  reset(): void {
    this.last = null;
  }
}
