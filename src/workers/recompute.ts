// Recompute stored runs for a new sector interval (§4.2). Pure, so the same code runs in the
// Web Worker and in tests, and the main thread can call it directly as a fallback.

import { type Profile, sectorsFromProfile } from '../engine/delta';
import { clampInterval, computeCheckpoints } from '../engine/route';

export interface RecomputeRequest {
  /** Route length (`Route.lengthM`): checkpoints depend only on this and the interval. */
  lengthM: number;
  intervalM: number;
  runs: { id: string; profile: Profile }[];
}

export interface RecomputeResult {
  id: string;
  intervalM: number;
  sectorMs: number[];
}

export function handleRecompute(req: RecomputeRequest): RecomputeResult[] {
  const intervalM = clampInterval(req.intervalM);
  const checkpoints = computeCheckpoints(req.lengthM, intervalM);
  return req.runs.map((r) => ({
    id: r.id,
    intervalM,
    sectorMs: sectorsFromProfile(r.profile, checkpoints).sectorMs.map(Math.round),
  }));
}
