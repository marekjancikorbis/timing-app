import { describe, expect, it, vi } from 'vitest';
import type { LonLat } from '../../engine/geo';
import { MAX_WAYPOINTS, ORS_URL, snapRequest, snapToRoads } from './snap';

const wps: LonLat[] = [
  [14.42, 50.08],
  [14.45, 50.09],
];

function respond(status: number, body: unknown) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );
}

const orsOk = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [14.42, 50.08, 250],
          [14.43, 50.081, 251],
          [14.43, 50.081, 251],
          [14.45, 50.09, 255],
        ],
      },
      properties: { summary: { distance: 2871.4, duration: 300 } },
    },
  ],
};

describe('snapRequest', () => {
  it('posts the waypoints with the key and unlimited snap radius', () => {
    const req = snapRequest(wps, 'KEY');
    expect(req.method).toBe('POST');
    expect((req.headers as Record<string, string>).Authorization).toBe('KEY');
    expect(JSON.parse(req.body as string)).toEqual({ coordinates: wps, radiuses: [-1, -1] });
  });
});

describe('snapToRoads', () => {
  it('returns the road geometry (2-D, de-duplicated) and its length', async () => {
    const f = respond(200, orsOk);
    const r = await snapToRoads(wps, ' KEY ', f);
    expect(f).toHaveBeenCalledWith(ORS_URL, expect.objectContaining({ method: 'POST' }));
    expect((f.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ Authorization: 'KEY' });
    expect(r).toEqual({
      ok: true,
      geometry: [
        [14.42, 50.08],
        [14.43, 50.081],
        [14.45, 50.09],
      ],
      lengthM: 2871.4,
    });
  });

  it.each([
    [undefined, wps, 'Add an OpenRouteService API key in Settings to snap to roads.'],
    ['  ', wps, 'Add an OpenRouteService API key in Settings to snap to roads.'],
    ['KEY', wps.slice(0, 1), 'Place at least a start and a finish.'],
    [
      'KEY',
      Array.from({ length: MAX_WAYPOINTS + 1 }, (_, i): LonLat => [14 + i * 0.001, 50]),
      'Use at most 50 points (there are 51).',
    ],
  ])('validates input before calling the API (key %j)', async (key, points, error) => {
    const f = respond(200, orsOk);
    expect(await snapToRoads(points, key, f)).toEqual({ ok: false, error });
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    [
      401,
      { error: 'Access to this API has been disallowed' },
      'The OpenRouteService key was refused. Check it in Settings.',
    ],
    [403, '', 'The OpenRouteService key was refused. Check it in Settings.'],
    [
      429,
      { error: 'Rate limit exceeded' },
      'Too many snap requests right now. Wait a minute and try again.',
    ],
    [
      404,
      { error: { code: 2010, message: 'Could not find routable point within a radius' } },
      'No road found between these points. Move them closer to a road, or draw by hand.',
    ],
    [
      400,
      { error: { code: 2009, message: 'Route could not be found' } },
      'No road found between these points. Move them closer to a road, or draw by hand.',
    ],
    [
      500,
      { error: { code: 2099, message: 'Unknown internal error' } },
      'Snapping failed (500: Unknown internal error).',
    ],
    [502, '<html>Bad gateway</html>', 'Snapping failed (502).'],
  ])('maps HTTP %d to a helpful message', async (status, body, error) => {
    expect(await snapToRoads(wps, 'KEY', respond(status, body))).toEqual({ ok: false, error });
  });

  it('reports a network failure', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await snapToRoads(wps, 'KEY', f)).toEqual({
      ok: false,
      error: 'No connection. Snapping needs the internet; drawing by hand works offline.',
    });
  });

  it.each([
    ['no features', { type: 'FeatureCollection', features: [] }],
    [
      'a point instead of a line',
      { features: [{ geometry: { type: 'Point', coordinates: [14, 50] } }] },
    ],
    ['not JSON', 'oops'],
  ])('rejects a malformed 200 response (%s)', async (_, body) => {
    expect(await snapToRoads(wps, 'KEY', respond(200, body))).toEqual({
      ok: false,
      error: 'Snapping returned something unexpected.',
    });
  });

  it('copes with a response without a summary', async () => {
    const noSummary = { features: [{ geometry: orsOk.features[0]?.geometry }] };
    const r = await snapToRoads(wps, 'KEY', respond(200, noSummary));
    expect(r.ok && Number.isNaN(r.lengthM)).toBe(true);
  });
});
