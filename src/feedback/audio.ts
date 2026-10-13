// Countdown and callout sounds (§4.4 step 4). Beeps are scheduled ahead on the AudioContext clock,
// so they land on time even if the main thread is busy; the plan is pure and tested.

export interface Beep {
  /** AudioContext time (seconds). */
  at: number;
  freq: number;
  duration: number;
}

export const SHORT_BEEP = { freq: 880, duration: 0.12 };
export const LONG_BEEP = { freq: 1320, duration: 0.6 };

/**
 * One short beep at each whole second before zero (N … 1) and a long beep at zero, for the
 * ones still ahead of `nowMs`. Wall-clock ms are mapped onto the AudioContext clock via `ctxNowS`.
 */
export function countdownBeeps(
  zeroAtMs: number,
  seconds: number,
  nowMs: number,
  ctxNowS: number,
): Beep[] {
  const toCtx = (t: number) => ctxNowS + (t - nowMs) / 1000;
  const beeps: Beep[] = [];
  for (let k = seconds; k >= 1; k--) {
    const t = zeroAtMs - k * 1000;
    if (t >= nowMs - 20) beeps.push({ at: toCtx(t), ...SHORT_BEEP });
  }
  if (zeroAtMs >= nowMs - 20) beeps.push({ at: toCtx(zeroAtMs), ...LONG_BEEP });
  return beeps;
}

let ctx: AudioContext | null = null;

/**
 * Create / resume the AudioContext. Must be called from the START tap: iOS only allows sound
 * started by a user gesture (R7).
 */
export function unlockAudio(): AudioContext | null {
  const AC =
    typeof window !== 'undefined'
      ? (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
  if (!AC) return null;
  ctx ??= new AC();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** Play scheduled beeps; returns a function that cancels the ones not yet played. */
export function playBeeps(beeps: readonly Beep[], audio: AudioContext | null = ctx): () => void {
  if (!audio) return () => {};
  const nodes = beeps.map((b) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = b.freq;
    gain.gain.setValueAtTime(0.0001, b.at);
    gain.gain.exponentialRampToValueAtTime(0.4, b.at + 0.01);
    gain.gain.setValueAtTime(0.4, b.at + b.duration - 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, b.at + b.duration);
    osc.connect(gain).connect(audio.destination);
    osc.start(b.at);
    osc.stop(b.at + b.duration + 0.01);
    return osc;
  });
  return () => {
    for (const o of nodes) {
      try {
        o.stop();
      } catch {
        // already stopped
      }
    }
  };
}

/** A single tone now (callouts). */
export function beepNow(freq: number, duration = 0.15): void {
  const audio = ctx;
  if (!audio) return;
  playBeeps([{ at: audio.currentTime + 0.01, freq, duration }], audio);
}
