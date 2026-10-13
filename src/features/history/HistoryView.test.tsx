// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { straightGeometry } from '../../../tests/harness';
import { routeFromDraft } from '../../data/routeModel';
import type { Run, Session } from '../../data/types';
import { HistoryView } from './HistoryView';

afterEach(cleanup);

const route = routeFromDraft(
  {
    name: 'Hill',
    type: 'stage',
    geometry: straightGeometry(1500),
    source: 'drawn',
    intervalM: 500,
    defaultStartMode: 'standing',
  },
  'route',
  1,
);

let seq = 0;
function run(o: Partial<Run>): Run {
  seq++;
  return {
    id: `r${seq}`,
    sessionId: 's1',
    routeId: 'route',
    lapNumber: 1,
    startMode: 'standing',
    startTime: 1_000_000 + seq,
    totalMs: 60_000,
    intervalM: 500,
    sectorMs: [20_000, 20_000, 20_000],
    sectorFlags: ['ok', 'ok', 'ok'],
    valid: true,
    traceId: `t${seq}`,
    ...o,
  };
}

const sessions: Session[] = [{ id: 's1', routeId: 'route', startedAt: 1_000_000, notes: 'Dry' }];
const runs = [
  run({ totalMs: 61_000, sectorMs: [19_000, 21_000, 21_000] }),
  run({ totalMs: 60_000 }),
  run({ startMode: 'flying', totalMs: 55_000 }),
];

function setup() {
  const props = {
    onOpenRun: vi.fn(),
    onCompare: vi.fn(),
    onDeleteRun: vi.fn(),
    onSessionNotes: vi.fn(),
  };
  render(<HistoryView route={route} runs={runs} sessions={sessions} {...props} />);
  return props;
}

describe('HistoryView', () => {
  it('shows best and theoretical best for the route default start mode', () => {
    setup();
    expect(screen.getByTestId('best').textContent).toBe('1:00.00');
    expect(screen.getByTestId('theoretical').textContent).toBe('0:59.00');
    expect(screen.getAllByTestId('run-row')).toHaveLength(2);
    expect(screen.getByText('Dry')).toBeTruthy();
  });

  it('switches start mode', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Flying' }));
    expect(screen.getByTestId('best').textContent).toBe('0:55.00');
    expect(screen.getAllByTestId('run-row')).toHaveLength(1);
  });

  it('colours sectors against the best run', () => {
    setup();
    const [slower] = screen.getAllByTestId('run-row');
    const colors = within(slower as HTMLElement)
      .getAllByRole('cell')
      .map((c) => c.getAttribute('data-color'))
      .filter(Boolean);
    expect(colors).toEqual(['purple', 'red', 'red']);
  });

  it('compares two picked runs, opens and deletes runs', () => {
    const p = setup();
    const compare = screen.getByRole('button', { name: /Compare/ });
    expect((compare as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Pick 1:01.00 to compare'));
    fireEvent.click(screen.getByLabelText('Pick 1:00.00 to compare'));
    fireEvent.click(compare);
    expect(p.onCompare).toHaveBeenCalledWith('r1', 'r2');

    fireEvent.click(screen.getByRole('button', { name: '1:01.00' }));
    expect(p.onOpenRun).toHaveBeenCalledWith('r1');

    fireEvent.click(screen.getByLabelText('Delete run 1:01.00'));
    expect(p.onDeleteRun).not.toHaveBeenCalled(); // confirm step first
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(p.onDeleteRun).toHaveBeenCalledWith('r1');
  });

  it('edits session notes', () => {
    const p = setup();
    fireEvent.click(screen.getByText('Dry'));
    fireEvent.change(screen.getByLabelText('Session notes'), {
      target: { value: ' Wet, slicks ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(p.onSessionNotes).toHaveBeenCalledWith('s1', 'Wet, slicks');
  });
});
