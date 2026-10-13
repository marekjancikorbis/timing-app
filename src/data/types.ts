// Persisted data model (§4.9).

import type { Profile } from '../engine/delta';
import type { Fix } from '../engine/filters';
import type { LonLat } from '../engine/geo';
import type { Gate, RouteType } from '../engine/route';
import type { InvalidReason, SectorFlag, TracePoint } from '../engine/tracker';
import type { StartMode } from '../engine/types';

export type RouteSource = 'drawn' | 'snapped' | 'recorded' | 'gpx' | 'osm';

export interface Route {
  id: string;
  name: string;
  type: RouteType;
  /**
   * [lon, lat] vertices as drawn, snapped, recorded or imported. Stored as editable vertices rather
   * than the 5 m resample (§4.9 says "resampled"); the engine resamples on load, which is cheap.
   */
  geometry: LonLat[];
  lengthM: number;
  intervalM: number;
  gateWidthM: number;
  startGate: Gate;
  finishGate?: Gate;
  defaultStartMode: StartMode;
  defaultCountdownS: number;
  source: RouteSource;
  createdAt: number;
  updatedAt: number;
}

export interface Session {
  id: string;
  routeId: string;
  startedAt: number;
  notes?: string;
}

export interface Run {
  id: string;
  sessionId: string;
  routeId: string;
  lapNumber: number;
  startMode: StartMode;
  countdownS?: number;
  jumpStart?: boolean;
  launchMs?: number;
  clockOffsetMs?: number;
  startTime: number;
  totalMs: number;
  /** Interval that `sectorMs` was computed for (cache key, §4.2). */
  intervalM: number;
  sectorMs: number[];
  sectorFlags: SectorFlag[];
  valid: boolean;
  invalidReason?: InvalidReason;
  traceId: string;
}

/**
 * What the live gap is measured against, per route and start mode (§3.2 should-have):
 * the best valid run ever, the best of the current session, or one pinned run.
 */
export type ReferenceKind = 'best' | 'session-best' | 'run';

export interface ReferenceChoice {
  /** `${routeId}|${startMode}` */
  id: string;
  routeId: string;
  startMode: StartMode;
  kind: ReferenceKind;
  /** The pinned run, when kind is 'run'. */
  runId?: string;
}

/** Large and rarely needed, so stored apart from runs. */
export interface Trace {
  id: string;
  points: TracePoint[];
  /** Distance → time profile: lets sectors be recomputed for any interval (§4.2). */
  profile: Profile;
}

export interface Settings {
  units: 'metric' | 'imperial';
  deltaSmoothingS: number;
  audioCallouts: 'off' | 'beep' | 'voice';
  jumpStartInvalidates: boolean;
  theme: 'dark' | 'light' | 'sunlight';
  /** OpenRouteService key for snap-to-roads; entered by the user, never shipped in the build. */
  orsApiKey: string;
}

export const DEFAULT_SETTINGS: Settings = {
  units: 'metric',
  deltaSmoothingS: 1,
  audioCallouts: 'beep',
  jumpStartInvalidates: false,
  theme: 'dark',
  orsApiKey: '',
};

/** Phase 0: a raw GPS log from the logger page. */
export interface GpsLog {
  id: string;
  name: string;
  startedAt: number;
  updatedAt: number;
  fixes: Fix[];
}
