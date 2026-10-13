// What to say or beep for timing events (§3.2 "audio callouts"). Pure, throttled planner.

import type { TrackerEvent } from '../engine/tracker';

export type CalloutMode = 'off' | 'beep' | 'voice';
export type Callout = { kind: 'speak'; text: string } | { kind: 'beep'; freq: number } | null;

export const FASTER_HZ = 1200;
export const SLOWER_HZ = 400;

/** "1 23.4" for 83 400 ms: easier for speech engines than "1:23.4". */
export function spokenTime(ms: number): string {
  const tenths = Math.round(ms / 100);
  const min = Math.floor(tenths / 600);
  const sec = ((tenths % 600) / 10).toFixed(1);
  return min > 0 ? `${min} ${sec.padStart(4, '0')}` : sec;
}

/** "plus 0.3" / "minus 1.2" / "even". */
export function spokenGap(ms: number): string {
  const tenths = Math.round(Math.abs(ms) / 100);
  if (tenths === 0) return 'even';
  return `${ms > 0 ? 'plus' : 'minus'} ${(tenths / 10).toFixed(1)}`;
}

/**
 * Turns events into callouts. Sector beeps always play; spoken sector gaps are throttled so they
 * don't run into each other on short sectors. Laps, finishes and warnings are always spoken.
 */
export class CalloutPlanner {
  private lastSpokenAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly mode: CalloutMode,
    private readonly minSpeechGapMs = 8000,
  ) {}

  plan(e: TrackerEvent, nowMs: number): Callout {
    if (this.mode === 'off') return null;
    const say = (text: string, force = false): Callout => {
      if (!force && nowMs - this.lastSpokenAt < this.minSpeechGapMs) return null;
      this.lastSpokenAt = nowMs;
      return { kind: 'speak', text };
    };
    switch (e.type) {
      case 'checkpoint':
        if (e.gapMs === undefined) return null;
        if (this.mode === 'beep')
          return { kind: 'beep', freq: e.gapMs <= 0 ? FASTER_HZ : SLOWER_HZ };
        return say(spokenGap(e.gapMs));
      case 'lap':
      case 'finish': {
        if (this.mode === 'beep') return { kind: 'beep', freq: FASTER_HZ };
        const what =
          e.type === 'lap'
            ? `lap ${spokenTime(e.run.totalMs)}`
            : `finish ${spokenTime(e.run.totalMs)}`;
        return say(e.run.valid ? what : `${what}, not valid`, true);
      }
      case 'jumpStart':
        return this.mode === 'voice' ? say('jump start', true) : { kind: 'beep', freq: SLOWER_HZ };
      case 'offRoute':
        return this.mode === 'voice' ? say('off route', true) : { kind: 'beep', freq: SLOWER_HZ };
      default:
        return null;
    }
  }
}
