import { systemClock } from '../engine/clock';
import type { Feedback } from '../features/live/session';
import { beepNow, countdownBeeps, playBeeps, unlockAudio } from './audio';
import { vibrate } from './haptics';
import { speak } from './speech';

/** Real sound, speech and vibration for the drive screen. */
export const browserFeedback: Feedback = {
  countdown(zeroAt, seconds) {
    const ctx = unlockAudio();
    if (!ctx) return () => {};
    return playBeeps(countdownBeeps(zeroAt, seconds, systemClock.now(), ctx.currentTime), ctx);
  },
  beep: (freq) => beepNow(freq),
  speak,
  vibrate,
};
