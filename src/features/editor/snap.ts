// Snap to roads (§3.2 MVP 1) with the OpenRouteService directions API. Only used while creating
// a route; timing never touches the network.

import { z } from 'zod';
import type { LonLat } from '../../engine/geo';
import { dedupe } from '../routes/simplify';

export const ORS_URL = 'https://api.openrouteservice.org/v2/directions/driving-car/geojson';
/** ORS limit on waypoints per request. */
export const MAX_WAYPOINTS = 50;

export type SnapResult =
  | { ok: true; geometry: LonLat[]; lengthM: number }
  | { ok: false; error: string };

const OrsResponse = z.object({
  features: z
    .array(
      z.object({
        geometry: z.object({
          type: z.literal('LineString'),
          coordinates: z.array(z.array(z.number()).min(2)).min(2),
        }),
        properties: z
          .object({ summary: z.object({ distance: z.number() }).partial().optional() })
          .optional(),
      }),
    )
    .min(1),
});

const OrsError = z.object({
  error: z.object({ code: z.number().optional(), message: z.string() }),
});

export function snapRequest(waypoints: readonly LonLat[], apiKey: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/geo+json',
    },
    // radiuses: -1 lets ORS look as far as needed for the nearest road to each click
    body: JSON.stringify({ coordinates: waypoints, radiuses: waypoints.map(() => -1) }),
  };
}

function errorFor(status: number, body: unknown): string {
  const parsed = OrsError.safeParse(body);
  const detail = parsed.success ? parsed.data.error.message : undefined;
  if (status === 401 || status === 403)
    return 'The OpenRouteService key was refused. Check it in Settings.';
  if (status === 429) return 'Too many snap requests right now. Wait a minute and try again.';
  if (status === 404 || parsed.data?.error.code === 2010 || parsed.data?.error.code === 2009) {
    return 'No road found between these points. Move them closer to a road, or draw by hand.';
  }
  return `Snapping failed (${status}${detail ? `: ${detail}` : ''}).`;
}

export async function snapToRoads(
  waypoints: readonly LonLat[],
  apiKey: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<SnapResult> {
  if (!apiKey?.trim())
    return { ok: false, error: 'Add an OpenRouteService API key in Settings to snap to roads.' };
  if (waypoints.length < 2) return { ok: false, error: 'Place at least a start and a finish.' };
  if (waypoints.length > MAX_WAYPOINTS) {
    return {
      ok: false,
      error: `Use at most ${MAX_WAYPOINTS} points (there are ${waypoints.length}).`,
    };
  }
  let res: Response;
  try {
    res = await fetchFn(ORS_URL, snapRequest(waypoints, apiKey.trim()));
  } catch {
    return {
      ok: false,
      error: 'No connection. Snapping needs the internet; drawing by hand works offline.',
    };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (!res.ok) return { ok: false, error: errorFor(res.status, body) };
  const parsed = OrsResponse.safeParse(body);
  if (!parsed.success) return { ok: false, error: 'Snapping returned something unexpected.' };
  const feature = parsed.data.features[0] as z.infer<typeof OrsResponse>['features'][number];
  const geometry = dedupe(
    feature.geometry.coordinates.map((c): LonLat => [c[0] as number, c[1] as number]),
  );
  return { ok: true, geometry, lengthM: feature.properties?.summary?.distance ?? Number.NaN };
}
