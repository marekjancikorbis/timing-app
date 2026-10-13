import { describe, expect, it } from 'vitest';
import type { Run, Session } from '../../data/types';
import { groupBySession, runStatus, sectorCells, summarize } from './historyModel';

let seq = 0;
function run(o: Partial<Run> = {}): Run {
  seq++;
  return {
    id: `r${seq}`,
    sessionId: 's1',
    routeId: 'route',
    lapNumber: 1,
    startMode: 'flying',
    startTime: seq * 1000,
    totalMs: 60_000,
    intervalM: 500,
    sectorMs: [20_000, 20_000, 20_000],
    sectorFlags: ['ok', 'ok', 'ok'],
    valid: true,
    traceId: `t${seq}`,
    ...o,
  };
}

describe('summarize', () => {
  it('finds the best run and the theoretical best per start mode', () => {
    const runs = [
      run({ totalMs: 61_000, sectorMs: [19_000, 21_000, 21_000] }),
      run({ totalMs: 60_000, sectorMs: [20_000, 20_000, 20_000] }),
      run({ totalMs: 62_000, sectorMs: [21_000, 22_000, 19_000] }),
      run({ startMode: 'standing', totalMs: 50_000, sectorMs: [10_000, 20_000, 20_000] }),
    ];
    const s = summarize(runs, 'flying', 500);
    expect(s.best?.totalMs).toBe(60_000);
    expect(s.bestSectors).toEqual([19_000, 20_000, 19_000]);
    expect(s.theoreticalBestMs).toBe(58_000);
    expect(s.runCount).toBe(3);
  });

  it('ignores invalid runs and jump starts for bests but counts them', () => {
    const runs = [
      run({ totalMs: 50_000, valid: false, invalidReason: 'off-route', sectorMs: [1, 1, 1] }),
      run({ totalMs: 55_000, jumpStart: true, startMode: 'standing', sectorMs: [1, 1, 1] }),
      run({ totalMs: 70_000, startMode: 'standing' }),
    ];
    expect(summarize(runs, 'flying', 500)).toMatchObject({ runCount: 1, validCount: 0 });
    expect(summarize(runs, 'flying', 500).best).toBeUndefined();
    expect(summarize(runs, 'flying', 500).theoreticalBestMs).toBeUndefined();
    const standing = summarize(runs, 'standing', 500);
    expect(standing.best?.totalMs).toBe(70_000);
    expect(standing.theoreticalBestMs).toBe(60_000);
  });

  it('only uses sectors computed for the current interval', () => {
    const runs = [run({ intervalM: 250, sectorMs: [1, 1, 1, 1, 1, 1] }), run()];
    expect(summarize(runs, 'flying', 500).bestSectors).toEqual([20_000, 20_000, 20_000]);
  });
});

describe('groupBySession', () => {
  const sessions: Session[] = [
    { id: 's1', routeId: 'route', startedAt: 100 },
    { id: 's2', routeId: 'route', startedAt: 9000 },
  ];

  it('groups newest session first, runs in driving order, with each session best', () => {
    const runs = [
      run({ sessionId: 's2', startTime: 9500, totalMs: 59_000 }),
      run({ sessionId: 's1', startTime: 300, totalMs: 61_000 }),
      run({ sessionId: 's1', startTime: 200, totalMs: 62_000 }),
      run({ sessionId: 's1', startTime: 400, startMode: 'standing' }),
    ];
    const g = groupBySession(runs, sessions, 'flying');
    expect(g.map((x) => x.session.id)).toEqual(['s2', 's1']);
    expect(g[1]?.runs.map((r) => r.startTime)).toEqual([200, 300]);
    expect(g[1]?.best?.totalMs).toBe(61_000);
  });

  it('keeps runs whose session row is missing', () => {
    const g = groupBySession([run({ sessionId: 'gone', startTime: 77 })], sessions, 'flying');
    expect(g[0]?.session).toMatchObject({ id: 'gone', startedAt: 77 });
  });
});

describe('sectorCells', () => {
  const ref = run({ sectorMs: [20_000, 20_000, 20_000] });
  const best = [19_000, 20_000, 21_000];

  it('colours purple / green / red against the reference and the bests', () => {
    const r = run({ sectorMs: [19_000, 19_500, 21_000], sectorFlags: ['ok', 'estimated', 'ok'] });
    expect(sectorCells(r, ref, best, 500)).toEqual([
      { ms: 19_000, color: 'purple', estimated: false },
      { ms: 19_500, color: 'purple', estimated: true },
      { ms: 21_000, color: 'purple', estimated: false },
    ]);
    const slow = run({ sectorMs: [19_500, 20_500, 22_000] });
    expect(sectorCells(slow, ref, best, 500).map((c) => c.color)).toEqual(['green', 'red', 'red']);
  });

  it('shows the reference itself only as purple or neutral', () => {
    expect(sectorCells(ref, ref, best, 500).map((c) => c.color)).toEqual([
      'neutral',
      'purple',
      'purple',
    ]);
  });

  it('leaves runs from another interval uncoloured', () => {
    const old = run({ intervalM: 250 });
    expect(sectorCells(old, ref, best, 500).every((c) => c.color === 'neutral')).toBe(true);
  });
});

describe('runStatus', () => {
  it('describes why a run does not count', () => {
    expect(runStatus(run())).toBe('');
    expect(runStatus(run({ valid: false, invalidReason: 'gps-gap' }))).toBe('GPS dropped out');
    expect(runStatus(run({ jumpStart: true, sectorFlags: ['ok', 'estimated'] }))).toBe(
      'jump start · estimated sectors',
    );
  });
});
