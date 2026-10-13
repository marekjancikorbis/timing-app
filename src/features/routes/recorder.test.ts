import { describe, expect, it } from 'vitest';
import { routeFromDraft } from '../../data/routeModel';
import type { Fix } from '../../engine/filters';
import { percentile } from '../../engine/geo';
import { type PreparedRoute, prepareRoute, projectGlobal } from '../../engine/route';
import { parseNdjson, toNdjson } from '../../gps/replayGps';
import { ovalCircuit, simulateDrive, windingStage } from '../../gps/simulator';
import { RouteRecorder } from './recorder';
import { endGapM } from './simplify';

const circuit = prepareRoute({ type: 'circuit', geometry: ovalCircuit(400, 100) });
const stage = prepareRoute({ type: 'stage', geometry: windingStage(2000) });

function record(fixes: readonly Fix[], rec = new RouteRecorder()) {
  for (const f of fixes) rec.push(f);
  return rec;
}

/** How far the recorded vertices are from the true road (p95, metres). */
function offRoadP95(truth: PreparedRoute, geometry: [number, number][]): number {
  return percentile(
    geometry.map(([lon, lat]) => projectGlobal(truth, truth.proj.toXY(lon, lat)).d),
    95,
  );
}

describe('RouteRecorder: circuit', () => {
  // 1.3 laps at 20 m/s with σ 2 m noise, as a replayed NDJSON log
  const sim = simulateDrive({
    route: circuit,
    start: { mode: 'flying', approachM: 0 },
    laps: 1.3,
    speed: 20,
    noiseM: 2,
    seed: 11,
  });
  const replayed = parseNdjson(toNdjson(sim.fixes));

  it('closes the lap, cuts off the extra driving and matches the real track', () => {
    const rec = record(replayed);
    expect(rec.status().lapClosed).toBe(true);
    const r = rec.finish();
    if (!r.ok) throw new Error(r.error);
    expect(r.type).toBe('circuit');
    expect(Math.abs(r.lengthM / circuit.lengthM - 1)).toBeLessThan(0.04);
    expect(endGapM(r.geometry)).toBeLessThan(25);
    expect(offRoadP95(circuit, r.geometry)).toBeLessThan(7);
    expect(r.geometry.length).toBeLessThan(replayed.length); // simplified
    // and it makes a valid route
    const route = routeFromDraft(
      { name: 'Recorded', type: r.type, geometry: r.geometry, source: 'recorded' },
      'x',
      1,
    );
    expect(Math.abs(route.lengthM / circuit.lengthM - 1)).toBeLessThan(0.04);
  });

  it('is not a circuit before the lap closes', () => {
    const rec = record(replayed.slice(0, 40)); // ~800 m of a 1.4 km lap
    expect(rec.status().lapClosed).toBe(false);
    expect(rec.finish('circuit')).toEqual({
      ok: false,
      error: 'The lap is not closed yet: drive back to where you started.',
    });
    const asStage = rec.finish();
    expect(asStage.ok && asStage.type).toBe('stage');
  });
});

describe('RouteRecorder: stage', () => {
  it('records a stage end to end, ignoring the wait at the start', () => {
    const sim = simulateDrive({
      route: stage,
      start: { mode: 'standing', stagedS: 0, launchAtMs: 60_000 }, // a minute parked first
      speed: 18,
      noiseM: 2,
      noiseCorrelation: 0.9,
      seed: 5,
      runOutS: 0,
    });
    const rec = record(sim.fixes);
    const r = rec.finish();
    if (!r.ok) throw new Error(r.error);
    expect(r.type).toBe('stage');
    expect(Math.abs(r.lengthM / stage.lengthM - 1)).toBeLessThan(0.04);
    expect(offRoadP95(stage, r.geometry)).toBeLessThan(7);
  });

  it('adds no length while parked, with or without a device speed', () => {
    const parked = simulateDrive({
      route: stage,
      start: { mode: 'standing', stagedS: 0, launchAtMs: 120_000 },
      speed: 18,
      noiseM: 2,
      noiseCorrelation: 0.9,
      seed: 9,
    }).fixes.filter((f) => f.t < 1_700_000_000_000 + 119_000);
    expect(record(parked).status().lengthM).toBe(0);
    const noSpeed = parked.map(({ spd: _spd, ...f }) => f);
    expect(record(noSpeed).status().lengthM).toBeLessThan(30); // only the bigger noise jumps
  });
});

describe('RouteRecorder: input handling', () => {
  it('rejects inaccurate fixes and counts them', () => {
    const rec = new RouteRecorder();
    expect(rec.push({ t: 1000, lat: 50, lon: 14, acc: 40 })).toBe('accuracy');
    expect(rec.push({ t: 2000, lat: 50, lon: 14, acc: 5 })).toBeNull();
    expect(rec.status()).toMatchObject({ points: 1, rejected: 1, lengthM: 0, distanceToStartM: 0 });
  });

  it('refuses a recording that is too short', () => {
    const rec = new RouteRecorder();
    rec.push({ t: 0, lat: 50, lon: 14, acc: 5, spd: 10 });
    rec.push({ t: 1000, lat: 50.0001, lon: 14, acc: 5, spd: 10 });
    expect(rec.finish('stage')).toEqual({
      ok: false,
      error: 'Too short to be a route: drive at least 50 m.',
    });
    expect(new RouteRecorder().finish()).toMatchObject({ ok: false });
  });
});
