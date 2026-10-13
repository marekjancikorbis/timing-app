// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE_T, fixAt, straightGeometry } from '../../../tests/harness';
import { type LapTimerDb, openDb } from '../../data/db';
import { createRoutesRepo } from '../../data/routesRepo';
import { createRunsRepo, type RunsRepo } from '../../data/runsRepo';
import type { Route } from '../../data/types';
import { FakeClock } from '../../engine/clock';
import type { Fix } from '../../engine/filters';
import { ManualGps } from '../../gps/manualGps';
import { DriveView } from './DriveView';
import { createTimingSession, type TimingSession } from './session';

let db: LapTimerDb;
let dbName: string;
let runs: RunsRepo;
let route: Route;
let clock: FakeClock;
let gps: ManualGps;
let session: TimingSession;

beforeEach(async () => {
  dbName = `drive-${Math.random()}`;
  db = openDb(dbName);
  await db.open();
  runs = createRunsRepo(db);
  route = await createRoutesRepo(db).create({
    name: 'Test straight',
    type: 'stage',
    geometry: straightGeometry(1000),
    source: 'drawn',
    intervalM: 250,
    defaultStartMode: 'flying',
  });
  clock = new FakeClock(BASE_T - 1000);
  gps = new ManualGps();
  session = await createTimingSession({
    route,
    gps,
    clock,
    runsRepo: runs,
    settings: { audioCallouts: 'off', deltaSmoothingS: 1, jumpStartInvalidates: false },
  });
});

afterEach(async () => {
  cleanup();
  session.dispose();
  db.close();
  await Dexie.delete(dbName);
});

/** Deliver fixes with the fake clock, ticking every 50 ms (inside act, as React state changes). */
function play(fixes: readonly Fix[]) {
  act(() => {
    for (const f of fixes) {
      while (clock.now() + 50 < f.t) {
        clock.advance(50);
        session.tick();
      }
      clock.set(Math.max(clock.now(), f.t));
      gps.push(f);
    }
  });
}

/** Parked at −5 m, then 4 m/s² from `moveAt` up to 30 m/s. */
function standing(moveAt: number, from = 0, to = 60_000): Fix[] {
  const out: Fix[] = [];
  for (let t = from; t <= to; t += 1000) {
    const dt = Math.max(0, t - moveAt) / 1000;
    const x = dt <= 7.5 ? -5 + 2 * dt * dt : -5 + 112.5 + 30 * (dt - 7.5);
    out.push(fixAt(x, 0, t, { spd: Math.min(4 * dt, 30) }));
  }
  return out;
}

const view = (onStartTap = vi.fn()) =>
  render(
    <DriveView
      route={route}
      session={session}
      clock={clock}
      runsRepo={runs}
      onStartTap={onStartTap}
    />,
  );

describe('DriveView', () => {
  it('standing start: checks → START → countdown lights → live → result → history', async () => {
    const onStartTap = vi.fn();
    view(onStartTap);
    expect(screen.getByText('No runs yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Standing start' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '3' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Arm timer' }));
    });

    // Armed but not staged yet: START is disabled.
    expect(screen.getByText('Standing start: stage the car')).toBeTruthy();
    const start = screen.getByRole('button', { name: 'START' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);

    play(standing(60_000, 0, 3000)); // parked at the line
    const checks = within(screen.getByRole('list', { name: 'Checks' })).getAllByRole('listitem');
    expect(checks.map((li) => li.dataset.ok)).toEqual(['true', 'true', 'true', 'true']);
    expect(start.disabled).toBe(false);

    act(() => {
      clock.set(BASE_T + 3500);
      fireEvent.click(start);
    });
    expect(onStartTap).toHaveBeenCalledOnce();
    expect(screen.getByTestId('countdown').textContent).toBe('3');
    const lights = within(screen.getByRole('list', { name: '3 seconds' })).getAllByRole('listitem');
    expect(lights).toHaveLength(3);
    expect(lights.map((l) => l.dataset.lit)).toEqual(['false', 'false', 'false']);

    act(() => {
      clock.set(BASE_T + 4600);
      session.tick();
    });
    await waitFor(() => expect(screen.getByTestId('countdown').textContent).toBe('2'));
    expect(
      screen.getByRole('list', { name: '2 seconds' }).querySelectorAll('[data-lit="true"]'),
    ).toHaveLength(1);

    // Zero at 6.5 s; the car leaves at 7 s and reaches the finish.
    play(standing(7000, 4000, 60_000));
    await waitFor(() =>
      expect(screen.getByTestId('result-status').textContent).toMatch(
        /^Valid run · launch 0\.\d\d s$/,
      ),
    );
    await act(() => session.flush());
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'History' })).getAllByRole('listitem'),
      ).toHaveLength(1),
    );
    expect(screen.getByRole('list', { name: 'History' }).textContent).toContain('standing');

    // "Again" re-arms with the same choice (standing, 3 s).
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Again' }));
    });
    expect(screen.getByText('Standing start: stage the car')).toBeTruthy();
    expect(session.tracker.startMode).toBe('standing');
  });

  it('shows the JUMP START banner during the countdown', async () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: 'Standing start' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Arm timer' }));
    });
    play(standing(60_000, 0, 3000));
    act(() => {
      clock.set(BASE_T + 3500); // 5 s countdown: zero at 8.5 s
      fireEvent.click(screen.getByRole('button', { name: 'START' }));
    });
    play(standing(5000, 4000, 7000)); // leaves 3.5 s early
    expect(screen.getByRole('alert').textContent).toBe('JUMP START');
    expect(screen.getByTestId('countdown')).toBeTruthy(); // still counting down

    // Cancel goes back to the checks.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('countdown')).toBeNull();
  });

  it('flying run: live gap, sector strip, speed and running time against the saved best', async () => {
    // A 30 m/s run is already saved; this one is slower.
    const flying = (v: number, startMs: number) =>
      Array.from({ length: Math.ceil(1100 / v) + 3 }, (_, k) =>
        fixAt(-45 + v * k, 0, startMs + k * 1000, { spd: v }),
      );
    view();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Arm timer' }));
    });
    play(flying(30, 0));
    await act(() => session.flush());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Again' }));
    });
    expect(screen.getByText(/Behind the start line/)).toBeTruthy();

    play(flying(25, 60_000).slice(0, 25)); // ~550 m in
    expect(screen.getByTestId('Gap').textContent).toMatch(/^\+\d\.\d\d$/);
    expect(screen.getByTestId('Last sector').textContent).toMatch(/^\+\d\.\d\d$/);
    expect(screen.getByTestId('speed').textContent).toBe('90 km/h');
    const cells = within(screen.getByRole('list', { name: 'Sectors' })).getAllByRole('listitem');
    expect(cells.map((c) => c.dataset.color)).toEqual(['red', 'red', 'pending', 'pending']);
    expect(screen.getByTestId('timer').textContent).toMatch(/^0:2\d\.\d$/);

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByTestId('result-status').textContent).toBe('Not valid: stopped');
  });
});
