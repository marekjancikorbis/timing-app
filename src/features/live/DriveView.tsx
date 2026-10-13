import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { RunsRepo } from '../../data/runsRepo';
import type { Route, Run } from '../../data/types';
import type { Clock } from '../../engine/clock';
import { COUNTDOWN_MAX_S, COUNTDOWN_MIN_S, countdownRemaining } from '../../engine/countdown';
import type { RunResult } from '../../engine/tracker';
import type { StartMode } from '../../engine/types';
import { BigTimer } from '../../ui/BigTimer';
import { DeltaBadge } from '../../ui/DeltaBadge';
import { SectorStrip } from '../../ui/SectorStrip';
import { StartLights } from '../../ui/StartLights';
import { useNow } from '../../ui/useNow';
import { formatTime } from './liveModel';
import type { SessionState, TimingSession } from './session';

interface Props {
  route: Route;
  session: TimingSession;
  clock: Clock;
  runsRepo: RunsRepo;
  /** Called inside the START tap, before the countdown starts (iOS needs a gesture for audio). */
  onStartTap?: () => void;
}

const seg = (on: boolean) =>
  `px-4 py-2 ${on ? 'bg-amber-400 text-neutral-950' : 'bg-neutral-900 hover:bg-neutral-800'}`;

const REASONS: Record<NonNullable<RunResult['invalidReason']>, string> = {
  'off-route': 'left the route',
  'gps-gap': 'GPS dropped out',
  'user-abort': 'stopped',
  'jump-start': 'jump start',
};

function Check({ ok, children }: { ok: boolean | undefined; children: React.ReactNode }) {
  return (
    <li className={ok ? 'text-green-400' : 'text-neutral-400'} data-ok={!!ok}>
      {ok ? '✓' : '○'} {children}
    </li>
  );
}

interface Choice {
  mode: StartMode;
  countdownS: number;
  setMode: (m: StartMode) => void;
  setCountdownS: (n: number) => void;
}

function ArmScreen({
  s,
  session,
  onStartTap,
  choice,
}: { s: SessionState; choice: Choice } & Pick<Props, 'session' | 'onStartTap'>) {
  const { mode, countdownS, setMode, setCountdownS } = choice;
  const live = s.live;
  const armed = live.state !== 'idle' && live.state !== 'finished' && live.state !== 'aborted';
  const acc = live.staging?.accuracyM ?? live.accuracyM;

  if (!armed) {
    return (
      <section className="space-y-4">
        <div className="inline-flex overflow-hidden rounded border border-neutral-700 text-lg">
          <button
            type="button"
            className={seg(mode === 'flying')}
            aria-pressed={mode === 'flying'}
            onClick={() => setMode('flying')}
          >
            Flying start
          </button>
          <button
            type="button"
            className={seg(mode === 'standing')}
            aria-pressed={mode === 'standing'}
            onClick={() => setMode('standing')}
          >
            Standing start
          </button>
        </div>
        {mode === 'standing' && (
          <label className="flex items-center gap-2">
            Countdown
            <select
              value={countdownS}
              onChange={(e) => setCountdownS(Number(e.target.value))}
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
            >
              {Array.from(
                { length: COUNTDOWN_MAX_S - COUNTDOWN_MIN_S + 1 },
                (_, i) => COUNTDOWN_MIN_S + i,
              ).map((n) => (
                <option key={n} value={n}>
                  {n} s
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          onClick={() => void session.arm(mode, countdownS)}
          className="w-full rounded bg-amber-400 py-4 text-xl font-semibold text-neutral-950"
        >
          Arm timer
        </button>
      </section>
    );
  }

  const standing = session.tracker.startMode === 'standing';
  return (
    <section className="space-y-5">
      <h2 className="text-xl font-semibold">
        {standing ? 'Standing start: stage the car' : 'Flying start: drive through the start line'}
      </h2>
      <ul className="space-y-1 text-lg" aria-label="Checks">
        <Check ok={s.gps.status === 'active'}>
          GPS {s.gps.status}
          {acc != null && ` · ±${acc.toFixed(0)} m`}
        </Check>
        {standing ? (
          <>
            <Check ok={live.staging?.gpsOk}>Accuracy 10 m or better</Check>
            <Check ok={live.staging?.atLine}>At the start line</Check>
            <Check ok={live.staging?.stationary}>Stationary</Check>
          </>
        ) : (
          <Check ok={live.state === 'ready'}>Behind the start line</Check>
        )}
      </ul>
      {s.gps.message && <p className="text-red-400">{s.gps.message}</p>}
      {standing && (
        <button
          type="button"
          disabled={live.state !== 'staged'}
          onClick={() => {
            onStartTap?.();
            session.startCountdown();
          }}
          className="h-32 w-full rounded-xl bg-green-600 text-4xl font-bold disabled:bg-neutral-800 disabled:text-neutral-500"
        >
          START
        </button>
      )}
      <button
        type="button"
        onClick={() => session.stop()}
        className="rounded border border-neutral-700 px-4 py-2"
      >
        Disarm
      </button>
    </section>
  );
}

function CountdownScreen({
  s,
  session,
  clock,
}: {
  s: SessionState;
  session: TimingSession;
  clock: Clock;
}) {
  const now = useNow(clock, true);
  const zeroAt = s.live.countdown?.zeroAt ?? session.tracker.countdownZeroAt ?? now;
  const remaining = countdownRemaining(zeroAt, now);
  const total = s.live.countdown?.total ?? remaining;
  return (
    <section className="flex flex-col items-center gap-8 py-6">
      {s.live.jumpStart && (
        <div role="alert" className="w-full rounded bg-red-600 py-3 text-center text-3xl font-bold">
          JUMP START
        </div>
      )}
      <div className="font-mono text-[10rem] leading-none tabular-nums" data-testid="countdown">
        {remaining > 0 ? remaining : 'GO'}
      </div>
      <StartLights total={total} remaining={remaining} />
      <button
        type="button"
        onClick={() => session.cancelCountdown()}
        className="w-full rounded border-2 border-neutral-600 py-5 text-2xl"
      >
        Cancel
      </button>
    </section>
  );
}

function LiveScreen({
  s,
  session,
  clock,
}: {
  s: SessionState;
  session: TimingSession;
  clock: Clock;
}) {
  const live = s.live;
  const now = useNow(clock, true);
  const elapsed = live.t0 === null ? null : now - live.t0;
  const lastLap = live.results.at(-1);
  return (
    <section className="flex flex-col gap-5">
      {(live.jumpStart || live.offRoute) && (
        <div role="alert" className="rounded bg-red-600 py-2 text-center text-xl font-bold">
          {live.jumpStart ? 'JUMP START' : 'OFF ROUTE'}
        </div>
      )}
      <DeltaBadge ms={live.gapMs} label="Gap" className="text-center text-8xl font-bold" />
      <BigTimer ms={elapsed} className="text-center text-6xl" />
      <div className="flex items-baseline justify-center gap-3 text-2xl">
        <span className="text-neutral-400">
          {live.lastSector ? `S${live.lastSector.index + 1}` : 'Sector'}
        </span>
        <DeltaBadge ms={live.lastSector?.deltaMs ?? null} label="Last sector" />
      </div>
      <SectorStrip sectors={live.sectors} />
      <div className="flex justify-between text-lg text-neutral-300">
        <span data-testid="speed">
          {live.speedMps === null ? '–' : Math.round(live.speedMps * 3.6)} km/h
        </span>
        {live.lap > 0 && <span>Lap {live.lap}</span>}
        <span>GPS {live.accuracyM === null ? '–' : `±${live.accuracyM.toFixed(0)} m`}</span>
      </div>
      {lastLap && (
        <p className="text-center text-neutral-400">Last lap {formatTime(lastLap.totalMs)}</p>
      )}
      <button
        type="button"
        onClick={() => session.stop()}
        className="mt-4 rounded border border-neutral-700 py-3"
      >
        Stop
      </button>
    </section>
  );
}

function FinishScreen({
  s,
  session,
  choice,
}: {
  s: SessionState;
  session: TimingSession;
  choice: Choice;
}) {
  const run = s.live.lastResult;
  return (
    <section className="space-y-4">
      {run ? (
        <>
          <BigTimer ms={run.totalMs} className="text-center text-6xl" />
          <p className="text-center text-lg" data-testid="result-status">
            {run.valid ? 'Valid run' : `Not valid: ${REASONS[run.invalidReason ?? 'user-abort']}`}
            {run.jumpStart && ' · jump start'}
            {run.launchMs !== undefined && ` · launch ${(run.launchMs / 1000).toFixed(2)} s`}
          </p>
          {run.sectorMs.length > 0 && <SectorStrip sectors={s.live.sectors} />}
        </>
      ) : (
        <p className="text-center text-neutral-400">Stopped.</p>
      )}
      {s.saveError && (
        <p role="alert" className="text-red-400">
          {s.saveError}
        </p>
      )}
      <button
        type="button"
        onClick={() => void session.arm(choice.mode, choice.countdownS)}
        className="w-full rounded bg-amber-400 py-4 text-xl font-semibold text-neutral-950"
      >
        Again
      </button>
    </section>
  );
}

function History({ runs }: { runs: Run[] | undefined }) {
  if (!runs?.length) return <p className="text-sm text-neutral-400">No runs yet.</p>;
  return (
    <ol className="divide-y divide-neutral-800 text-sm" aria-label="History">
      {[...runs].reverse().map((r) => (
        <li key={r.id} className="flex justify-between py-1.5">
          <span className="font-mono tabular-nums">{formatTime(r.totalMs)}</span>
          <span className="text-neutral-400">
            {r.startMode}
            {r.lapNumber > 1 && ` · lap ${r.lapNumber}`}
            {!r.valid && ` · ${REASONS[r.invalidReason ?? 'user-abort']}`}
            {r.jumpStart && ' · jump start'}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function DriveView({ route, session, clock, runsRepo, onStartTap }: Props) {
  const s = useSyncExternalStore(session.subscribe, session.getState);
  const history = useLiveQuery(() => runsRepo.listByRoute(route.id), [route.id, s.saved.length]);
  const state = s.live.state;
  const [mode, setMode] = useState<StartMode>(route.defaultStartMode);
  const [countdownS, setCountdownS] = useState(route.defaultCountdownS);
  const choice: Choice = { mode, countdownS, setMode, setCountdownS };

  // The countdown needs ticks between GPS fixes.
  useEffect(() => {
    if (state !== 'countdown') return;
    const id = setInterval(() => session.tick(), 50);
    return () => clearInterval(id);
  }, [state, session]);

  return (
    <div className="mx-auto max-w-xl space-y-6 p-4">
      <h1 className="text-lg text-neutral-400">{route.name}</h1>
      {state === 'countdown' ? (
        <CountdownScreen s={s} session={session} clock={clock} />
      ) : state === 'running' ? (
        <LiveScreen s={s} session={session} clock={clock} />
      ) : state === 'finished' || state === 'aborted' ? (
        <FinishScreen s={s} session={session} choice={choice} />
      ) : (
        <ArmScreen s={s} session={session} onStartTap={onStartTap} choice={choice} />
      )}
      {state !== 'running' && state !== 'countdown' && (
        <section className="space-y-2">
          <h2 className="font-medium">History</h2>
          <History runs={history} />
        </section>
      )}
    </div>
  );
}
