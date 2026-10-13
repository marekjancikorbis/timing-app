import { describe, expect, it } from 'vitest';
import { FakeClock, systemClock } from './clock';

describe('clocks', () => {
  it('FakeClock only moves when told', () => {
    const c = new FakeClock(1000);
    expect(c.now()).toBe(1000);
    expect(c.advance(250)).toBe(1250);
    c.set(5000);
    expect(c.now()).toBe(5000);
  });

  it('systemClock is close to Date.now() and non-decreasing', () => {
    const a = systemClock.now();
    const b = systemClock.now();
    expect(Math.abs(a - Date.now())).toBeLessThan(1000);
    expect(b).toBeGreaterThanOrEqual(a);
  });
});
