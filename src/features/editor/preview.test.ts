import { describe, expect, it } from 'vitest';
import { LAT0, LON0, ll, straightGeometry } from '../../../tests/harness';
import { createProjection } from '../../engine/geo';
import { ovalCircuit } from '../../gps/simulator';
import {
  buildPreview,
  formatDistance,
  INTERVAL_SLIDER,
  type Preview,
  parseIntervalInput,
  previewGeoJson,
  sectorSummary,
} from './preview';

function ok(input: Parameters<typeof buildPreview>[0]): Preview {
  const r = buildPreview(input);
  if (!r.ok) throw new Error(r.error);
  return r.preview;
}

describe('buildPreview', () => {
  it('places checkpoint markers every interval along the route', () => {
    const p = ok({ type: 'stage', geometry: straightGeometry(2330), intervalM: 100 });
    expect(p.sectorCount).toBe(23); // 22 × 100 m + 130 m (remainder merged)
    expect(p.lastSectorM).toBeCloseTo(130, 0);
    expect(p.checkpoints).toHaveLength(22);
    // marker k sits k × 100 m from the start, on the road
    const proj = createProjection(LON0, LAT0);
    for (const c of [p.checkpoints[0], p.checkpoints[9], p.checkpoints[21]]) {
      const { x, y } = proj.toXY(...(c?.position as [number, number]));
      expect(x).toBeCloseTo(((c?.index as number) + 1) * 100, 6);
      expect(y).toBeCloseTo(0, 6);
    }
  });

  it('updates live with the interval and flags the single-sector case', () => {
    const geometry = straightGeometry(800);
    expect(ok({ type: 'stage', geometry, intervalM: 250 }).sectorCount).toBe(3); // 250+250+300
    const single = ok({ type: 'stage', geometry, intervalM: 1000 });
    expect(single).toMatchObject({ singleSector: true, sectorCount: 1, checkpoints: [] });
  });

  it('clamps the interval to the slider range', () => {
    expect(ok({ type: 'stage', geometry: straightGeometry(3000), intervalM: 20 }).intervalM).toBe(
      100,
    );
  });

  it('uses the start line as the finish on a circuit', () => {
    const p = ok({ type: 'circuit', geometry: ovalCircuit(300, 80), intervalM: 200 });
    expect(p.finishGate[0][0]).toBeCloseTo(p.startGate[0][0], 9);
    expect(p.finishGate[1][1]).toBeCloseTo(p.startGate[1][1], 9);
  });

  it('reports unusable geometry instead of throwing', () => {
    expect(buildPreview({ type: 'stage', geometry: [ll(0)], intervalM: 100 })).toEqual({
      ok: false,
      error: 'Route needs at least two points',
    });
    expect(buildPreview({ type: 'stage', geometry: [ll(0), ll(2)], intervalM: 100 })).toMatchObject(
      { ok: false },
    );
  });
});

describe('text helpers', () => {
  it.each([
    [130, 'metric', '130 m'],
    [2330, 'metric', '2.33 km'],
    [100, 'imperial', '328 ft'],
    [2330, 'imperial', '1.45 mi'],
  ] as const)('formatDistance(%d, %s) = %s', (m, units, text) => {
    expect(formatDistance(m, units)).toBe(text);
  });

  it('summarises sectors as in §5', () => {
    expect(
      sectorSummary(ok({ type: 'stage', geometry: straightGeometry(2330), intervalM: 100 })),
    ).toBe('23 sectors, last sector 130 m');
    expect(
      sectorSummary(ok({ type: 'stage', geometry: straightGeometry(800), intervalM: 1000 })),
    ).toBe('1 sector: the interval is as long as the route (800 m)');
  });

  it('parses the interval box', () => {
    expect(parseIntervalInput('250')).toBe(250);
    expect(parseIntervalInput(' 260 ')).toBe(250);
    expect(parseIntervalInput('5000')).toBe(1000);
    expect(parseIntervalInput('')).toBeUndefined();
    expect(parseIntervalInput('abc')).toBeUndefined();
    expect(INTERVAL_SLIDER).toEqual({ min: 100, max: 1000, step: 50 });
  });
});

describe('previewGeoJson', () => {
  it('has the route, gates and numbered checkpoints', () => {
    const input = { type: 'stage' as const, geometry: straightGeometry(1000), intervalM: 250 };
    const fc = previewGeoJson(input, ok(input));
    const kinds = fc.features.map((f) => f.properties.kind);
    expect(kinds).toEqual(['route', 'start', 'checkpoint', 'checkpoint', 'checkpoint', 'finish']);
    expect(
      fc.features.filter((f) => f.properties.kind === 'checkpoint').map((f) => f.properties.label),
    ).toEqual(['1', '2', '3']);
  });

  it('has no separate finish line on a circuit', () => {
    const input = { type: 'circuit' as const, geometry: ovalCircuit(300, 80), intervalM: 500 };
    const kinds = previewGeoJson(input, ok(input)).features.map((f) => f.properties.kind);
    expect(kinds).not.toContain('finish');
  });
});
