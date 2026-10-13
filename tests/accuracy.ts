// Accuracy benchmark (§8): simulated drives with known ground truth → error percentiles.

import { percentile } from '../src/engine/geo';
import { type PreparedRoute, prepareRoute } from '../src/engine/route';
import { ovalCircuit, simulateDrive, windingStage } from '../src/gps/simulator';
import { BASE_T, feed, makeTracker } from './harness';

export interface AccuracyReport {
  runs: number;
  /** Drives that produced no timed run at all (e.g. never staged). */
  missed: number;
  totalP95Ms: number;
  checkpointP95Ms: number;
  totalMaxMs: number;
  /** Runs flagged as jump starts although the car only moved after zero. */
  jumpStarts: number;
}

export interface AccuracyOptions {
  kind: 'stage-flying' | 'stage-standing' | 'circuit';
  /** Noise standard deviation per axis, metres. */
  noiseM: number;
  runs: number;
  intervalM?: number;
  noiseCorrelation?: number;
  /** Mean speed in m/s; the simulator varies it ±30% along the route. */
  speedMps?: number;
}

const routes = new Map<string, PreparedRoute>();
function route(kind: AccuracyOptions['kind'], intervalM: number): PreparedRoute {
  const key = `${kind}:${intervalM}`;
  let r = routes.get(key);
  if (!r) {
    r =
      kind === 'circuit'
        ? prepareRoute({ type: 'circuit', geometry: ovalCircuit(500, 120), intervalM })
        : prepareRoute({ type: 'stage', geometry: windingStage(2500), intervalM });
    routes.set(key, r);
  }
  return r;
}

export function measureAccuracy(o: AccuracyOptions): AccuracyReport {
  const r = route(o.kind, o.intervalM ?? 200);
  const L = r.lengthM;
  const mean = o.speedMps ?? 22; // ~80 km/h
  const speed = (s: number) => mean * (1 + 0.3 * Math.sin((2 * Math.PI * s) / 700));
  const standing = o.kind === 'stage-standing';
  const totalErr: number[] = [];
  const cpErr: number[] = [];
  let missed = 0;
  let jumpStarts = 0;

  for (let seed = 1; seed <= o.runs; seed++) {
    const sim = simulateDrive({
      route: r,
      start: standing ? { mode: 'standing', stagedS: -5, launchAtMs: 20_000 } : { mode: 'flying' },
      laps: o.kind === 'circuit' ? 2 : 1,
      speed,
      noiseM: o.noiseM,
      noiseCorrelation: o.noiseCorrelation ?? 0,
      seed,
      startEpoch: BASE_T,
    });
    const d = makeTracker(r);
    d.tracker.arm(standing ? 'standing' : 'flying', 5);
    // Standing: tap START once staged (from 6 s on). The car launches at 20 s, after zero.
    feed(d, sim.fixes, standing ? { startCountdownAt: BASE_T + 6000 } : {});

    const runs = d.runs();
    if (runs.length === 0) {
      missed++;
      continue;
    }
    // The car launches at 20 s. A jump start is false only if zero came before that.
    const first = runs[0];
    if (standing && first?.jumpStart && first.startTime <= BASE_T + 20_000) jumpStarts++;
    runs.forEach((run, lap) => {
      // Standing: time zero is the end of the countdown (run.startTime), wherever the car was.
      const lapStart = standing ? run.startTime : sim.timeAt(lap * L);
      const truthTotal = sim.timeAt((lap + 1) * L) - lapStart;
      totalErr.push(Math.abs(run.totalMs - truthTotal));
      let cum = 0;
      run.sectorMs.forEach((ms, k) => {
        cum += ms;
        const D = r.checkpoints[k] as number;
        cpErr.push(Math.abs(cum - (sim.timeAt(lap * L + D) - lapStart)));
      });
    });
  }
  return {
    runs: o.runs,
    missed,
    totalP95Ms: percentile(totalErr, 95),
    checkpointP95Ms: percentile(cpErr, 95),
    totalMaxMs: totalErr.length ? Math.max(...totalErr) : Number.NaN,
    jumpStarts,
  };
}
