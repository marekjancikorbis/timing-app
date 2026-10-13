// Record a route by driving it (§3.2 MVP 1): a reference lap for a circuit, or a stage end to end.
// Pure: feed it fixes from any GpsSource (device, replay, simulator).

import { type Fix, FixFilter, type RejectReason } from '../../engine/filters';
import { createProjection, dist, type LonLat, type Projection, type Vec2 } from '../../engine/geo';
import type { RouteType } from '../../engine/route';
import { lineLengthM, simplifyLine } from './simplify';

export interface RecorderConfig {
  maxAccuracyM: number;
  /** Below this speed the car is treated as stopped and no points are added. */
  minSpeedMps: number;
  /** Without a device speed, a new point must be this far from the last one. */
  minSpacingM: number;
  /** A circuit closes when the car comes back within this distance of the start… */
  closeM: number;
  /** …after having been at least this far away. */
  leaveM: number;
  simplifyM: number;
}

export const DEFAULT_RECORDER: RecorderConfig = {
  maxAccuracyM: 15,
  minSpeedMps: 1,
  minSpacingM: 5,
  closeM: 25,
  leaveM: 100,
  simplifyM: 1.5,
};

export interface RecorderStatus {
  points: number;
  lengthM: number;
  rejected: number;
  /** Straight-line distance back to the first point. */
  distanceToStartM: number;
  /** A full lap has been driven (the car is back near the start). */
  lapClosed: boolean;
}

export type RecordingResult =
  | { ok: true; geometry: LonLat[]; lengthM: number; type: RouteType }
  | { ok: false; error: string };

export class RouteRecorder {
  private readonly cfg: RecorderConfig;
  private readonly filter: FixFilter;
  private proj: Projection | null = null;
  private pts: LonLat[] = [];
  private xy: Vec2[] = [];
  private len = 0;
  private rejected = 0;
  private maxAway = 0;
  /** Index where the lap closed (closest approach to the start), once it has. */
  private closeIdx: number | null = null;
  private closeBest = Number.POSITIVE_INFINITY;

  constructor(cfg: Partial<RecorderConfig> = {}) {
    this.cfg = { ...DEFAULT_RECORDER, ...cfg };
    this.filter = new FixFilter({ maxAccuracyM: this.cfg.maxAccuracyM, maxSpeedMps: 300 / 3.6 });
  }

  /** Returns null if the fix was used or skipped as stationary, otherwise why it was rejected. */
  push(fix: Fix): RejectReason | null {
    const reason = this.filter.check(fix);
    if (reason) {
      this.rejected++;
      return reason;
    }
    this.proj ??= createProjection(fix.lon, fix.lat);
    const p = this.proj.toXY(fix.lon, fix.lat);
    const last = this.xy.at(-1);
    if (last) {
      const moved = dist(last, p);
      const stopped =
        fix.spd != null ? fix.spd < this.cfg.minSpeedMps : moved < this.cfg.minSpacingM;
      if (stopped) return null;
      this.len += moved;
    }
    this.pts.push([fix.lon, fix.lat]);
    this.xy.push(p);
    this.trackLap(p);
    return null;
  }

  private trackLap(p: Vec2): void {
    const start = this.xy[0] as Vec2;
    const d = dist(start, p);
    this.maxAway = Math.max(this.maxAway, d);
    if (this.maxAway < this.cfg.leaveM || d > this.cfg.closeM) return;
    // Back near the start: keep the closest approach while it keeps getting closer.
    if (this.closeIdx === null || (this.closeIdx === this.xy.length - 2 && d < this.closeBest)) {
      this.closeIdx = this.xy.length - 1;
      this.closeBest = d;
    }
  }

  status(): RecorderStatus {
    const start = this.xy[0];
    const last = this.xy.at(-1);
    return {
      points: this.pts.length,
      lengthM: this.len,
      rejected: this.rejected,
      distanceToStartM: start && last ? dist(start, last) : 0,
      lapClosed: this.closeIdx !== null,
    };
  }

  /**
   * Turn the recording into route geometry. 'auto' picks a circuit when a lap closed.
   * A circuit is cut at the point where the lap closed, so extra driving past the start is dropped.
   */
  finish(type: RouteType | 'auto' = 'auto'): RecordingResult {
    const chosen: RouteType =
      type === 'auto' ? (this.closeIdx !== null ? 'circuit' : 'stage') : type;
    let pts = this.pts;
    if (chosen === 'circuit') {
      if (this.closeIdx === null) {
        return { ok: false, error: 'The lap is not closed yet: drive back to where you started.' };
      }
      pts = pts.slice(0, this.closeIdx + 1);
    }
    if (pts.length < 2 || lineLengthM(pts) < 50) {
      return { ok: false, error: 'Too short to be a route: drive at least 50 m.' };
    }
    const geometry = simplifyLine(pts, this.cfg.simplifyM);
    return { ok: true, geometry, lengthM: lineLengthM(geometry), type: chosen };
  }
}
