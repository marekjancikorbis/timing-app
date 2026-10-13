// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { straightGeometry } from '../../../tests/harness';
import { routeFromDraft } from '../../data/routeModel';
import type { Run } from '../../data/types';
import { RunView } from './RunView';

// uPlot reads the pixel ratio through matchMedia when it is imported; jsdom has none.
vi.hoisted(() => {
  window.matchMedia ??= (() => ({ addEventListener() {}, removeEventListener() {} })) as never;
});

afterEach(cleanup);

const route = routeFromDraft(
  {
    name: 'Hill',
    type: 'stage',
    geometry: straightGeometry(1000),
    source: 'drawn',
    intervalM: 500,
  },
  'route',
  1,
);

function run(o: Partial<Run>): Run {
  return {
    id: 'a',
    sessionId: 's1',
    routeId: 'route',
    lapNumber: 1,
    startMode: 'standing',
    startTime: 1_000_000,
    totalMs: 51_000,
    intervalM: 500,
    sectorMs: [25_000, 26_000],
    sectorFlags: ['ok', 'estimated'],
    valid: true,
    traceId: 'ta',
    countdownS: 5,
    launchMs: 420,
    ...o,
  };
}

const a = run({});
const b = run({ id: 'b', totalMs: 50_000, sectorMs: [25_500, 24_500], sectorFlags: ['ok', 'ok'] });

describe('RunView', () => {
  it('shows the run with its sectors against the reference', () => {
    render(
      <RunView
        route={route}
        current={{ run: a }}
        reference={{ run: b }}
        candidates={[a, b]}
        onPickReference={vi.fn()}
        showGraphics={false}
      />,
    );
    expect(screen.getByTestId('run-time').textContent).toBe('0:51.00');
    expect(screen.getByTestId('run-status').textContent).toContain('launch ≈ 0.42 s');
    const rows = screen.getAllByTestId('sector-row');
    expect(rows).toHaveLength(2);
    const cells = (i: number) =>
      within(rows[i] as HTMLElement)
        .getAllByRole('cell')
        .map((c) => c.textContent);
    expect(cells(0)).toEqual(['S1', '0–500 m', '25.00', '25.50', '−0.50', '−0.50']);
    expect(cells(1)).toEqual(['S2', '500–1000 m', '26.00', '24.50', '+1.50', '+1.00']);
    expect(screen.getByText('The GPS trace of this run is missing.')).toBeTruthy();
  });

  it('picks another reference, or none', () => {
    const onPick = vi.fn();
    render(
      <RunView
        route={route}
        current={{ run: a }}
        candidates={[a, b]}
        onPickReference={onPick}
        showGraphics={false}
      />,
    );
    const select = screen.getByLabelText('Reference run') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'b']); // not itself
    fireEvent.change(select, { target: { value: 'b' } });
    expect(onPick).toHaveBeenLastCalledWith('b');
    fireEvent.change(select, { target: { value: '' } });
    expect(onPick).toHaveBeenLastCalledWith(undefined);
  });

  it('warns when the start modes differ', () => {
    render(
      <RunView
        route={route}
        current={{ run: a }}
        reference={{ run: { ...b, startMode: 'flying' } }}
        candidates={[a, b]}
        onPickReference={vi.fn()}
        showGraphics={false}
      />,
    );
    expect(screen.getByText(/Different start modes/)).toBeTruthy();
  });
});
