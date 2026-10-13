// A timing session on one route: GPS → tracker → live model, with saving, references and feedback.
// No React and no browser APIs of its own: everything external is injected, so it is unit-tested
// with a fake clock, a pushed-fix GPS source and fake-indexeddb.

import { prepareStored } from '../../data/routeModel';
import type { RunsRepo } from '../../data/runsRepo';
import type { Route, Run, Settings } from '../../data/types';
import type { Clock } from '../../engine/clock';
import type { Profile } from '../../engine/delta';
import { GapSmoother } from '../../engine/delta';
import { type RunResult, Tracker, type TrackerEvent } from '../../engine/tracker';
import type { StartMode } from '../../engine/types';
import { CalloutPlanner } from '../../feedback/callouts';
import type { GpsSource, GpsStatus } from '../../gps/GpsSource';
import { initialLive, type LiveContext, type LiveModel, liveReduce } from './liveModel';

export interface Feedback {
  /** Schedule the countdown beeps; returns a cancel function. */
  countdown(zeroAt: number, seconds: number): () => void;
  beep(freq: number): void;
  speak(text: string): void;
  vibrate(pattern: number | number[]): void;
}

export const silentFeedback: Feedback = {
  countdown: () => () => {},
  beep: () => {},
  speak: () => {},
  vibrate: () => {},
};

export interface SessionState {
  live: LiveModel;
  gps: { status: GpsStatus; message?: string };
  saved: Run[];
  saveError: string | null;
  /** Reference run per start mode (what the gap is measured against). */
  reference: Partial<Record<StartMode, Run>>;
}

export interface SessionDeps {
  route: Route;
  gps: GpsSource;
  clock: Clock;
  runsRepo: RunsRepo;
  settings: Pick<Settings, 'audioCallouts' | 'deltaSmoothingS' | 'jumpStartInvalidates'>;
  feedback?: Feedback;
}

export interface TimingSession {
  getState(): SessionState;
  subscribe(listener: (s: SessionState) => void): () => void;
  arm(mode: StartMode, countdownS: number): Promise<void>;
  /** Call from the START tap (after unlocking audio). False if not staged. */
  startCountdown(): boolean;
  cancelCountdown(): void;
  stop(): void;
  /** Drive the countdown: call every ~50 ms (or per animation frame). */
  tick(): void;
  /** Resolves when every run so far has been written. */
  flush(): Promise<void>;
  dispose(): void;
  readonly tracker: Tracker;
}

/** Load the best valid run per start mode, with its profile, and history bests per sector. */
async function loadReferences(route: Route, runs: RunsRepo) {
  const refs: Partial<Record<StartMode, { run: Run; profile: Profile }>> = {};
  for (const mode of ['flying', 'standing'] as const) {
    const run = await runs.best(route.id, mode);
    const trace = run && (await runs.getTrace(run.traceId));
    if (run && trace) refs[mode] = { run, profile: trace.profile };
  }
  const bests: Record<StartMode, number[]> = { flying: [], standing: [] };
  for (const r of await runs.listByRoute(route.id)) {
    if (!r.valid || r.jumpStart || r.intervalM !== route.intervalM) continue;
    const b = bests[r.startMode];
    r.sectorMs.forEach((ms, i) => {
      if (b[i] === undefined || ms < (b[i] as number)) b[i] = ms;
    });
  }
  return { refs, bests };
}

export async function createTimingSession(deps: SessionDeps): Promise<TimingSession> {
  const { route, gps, clock, runsRepo, settings } = deps;
  const feedback = deps.feedback ?? silentFeedback;
  const prepared = prepareStored(route);
  const { refs, bests } = await loadReferences(route, runsRepo);

  const profiles: Partial<Record<StartMode, Profile>> = {};
  const ctx: LiveContext = {
    refSectors: {},
    smoother: new GapSmoother(settings.deltaSmoothingS * 1000),
  };
  for (const mode of ['flying', 'standing'] as const) {
    const r = refs[mode];
    if (r) {
      profiles[mode] = r.profile;
      ctx.refSectors[mode] = r.run.sectorMs;
    }
  }

  const tracker = new Tracker(prepared, {
    clock,
    references: profiles,
    jumpStartInvalidates: settings.jumpStartInvalidates,
  });
  const callouts = new CalloutPlanner(settings.audioCallouts);
  const listeners = new Set<(s: SessionState) => void>();
  let state: SessionState = {
    live: initialLive(prepared.checkpoints.length, bests),
    gps: { status: 'idle' },
    saved: [],
    saveError: null,
    reference: { flying: refs.flying?.run, standing: refs.standing?.run },
  };
  let sessionId: string | null = null;
  let saving: Promise<void> = Promise.resolve();
  let cancelBeeps: (() => void) | null = null;

  const set = (patch: Partial<SessionState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l(state);
  };

  const save = (run: RunResult) => {
    saving = saving.then(async () => {
      try {
        sessionId ??= (await runsRepo.startSession(route.id)).id;
        const saved = await runsRepo.save(run, route.id, sessionId);
        const reference = { ...state.reference };
        const current = reference[run.startMode];
        // A faster valid run becomes the reference for the next one (§4.6 default).
        if (saved.valid && !saved.jumpStart && (!current || saved.totalMs < current.totalMs)) {
          reference[run.startMode] = saved;
          profiles[run.startMode] = run.profile;
          ctx.refSectors[run.startMode] = saved.sectorMs;
          tracker.setReferences({ ...profiles });
        }
        set({ saved: [...state.saved, saved], reference });
      } catch (e) {
        set({ saveError: `Could not save the run: ${e instanceof Error ? e.message : String(e)}` });
      }
    });
  };

  const onEvent = (e: TrackerEvent) => {
    set({ live: liveReduce(state.live, e, ctx) });
    const c = callouts.plan(e, clock.now());
    if (c?.kind === 'speak') feedback.speak(c.text);
    else if (c?.kind === 'beep') feedback.beep(c.freq);
    switch (e.type) {
      case 'countdownTick':
        feedback.vibrate(e.remaining === 0 ? 600 : 80);
        break;
      case 'jumpStart':
        feedback.vibrate([200, 100, 200, 100, 200]);
        break;
      case 'lap':
      case 'finish':
        save(e.run);
        break;
      case 'state':
        if (e.state !== 'countdown') {
          cancelBeeps?.();
          cancelBeeps = null;
        }
        break;
      default:
        break;
    }
  };
  const offTracker = tracker.on(onEvent);
  const offFix = gps.subscribe((fix) => tracker.onFix(fix));
  const offStatus = gps.onStatus?.((status, message) => set({ gps: { status, message } }));

  return {
    tracker,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async arm(mode, countdownS) {
      set({ saveError: null });
      tracker.arm(mode, countdownS);
      await gps.start();
    },
    startCountdown() {
      if (!tracker.startCountdown()) return false;
      const zeroAt = tracker.countdownZeroAt as number;
      cancelBeeps = feedback.countdown(zeroAt, Math.round((zeroAt - clock.now()) / 1000));
      return true;
    },
    cancelCountdown: () => tracker.cancelCountdown(),
    stop: () => tracker.stop(),
    tick: () => tracker.tick(),
    flush: () => saving,
    dispose() {
      cancelBeeps?.();
      offTracker();
      offFix();
      offStatus?.();
      gps.stop();
      listeners.clear();
    },
  };
}
