import { describe, expect, it } from 'vitest';
import { type Fix, FixFilter } from './filters';

const f = (t: number, lat = 50, lon = 14, acc = 5): Fix => ({ t, lat, lon, acc });

describe('FixFilter', () => {
  it('accepts a normal sequence', () => {
    const filter = new FixFilter();
    expect(filter.check(f(1000))).toBeNull();
    expect(filter.check(f(2000, 50.0002))).toBeNull(); // ~22 m in 1 s
  });

  it('rejects poor accuracy, including NaN', () => {
    const filter = new FixFilter();
    expect(filter.check(f(1000, 50, 14, 25))).toBeNull();
    expect(filter.check(f(2000, 50, 14, 25.1))).toBe('accuracy');
    expect(filter.check(f(3000, 50, 14, Number.NaN))).toBe('accuracy');
  });

  it('rejects duplicate and out-of-order timestamps', () => {
    const filter = new FixFilter();
    filter.check(f(2000));
    expect(filter.check(f(2000))).toBe('duplicate');
    expect(filter.check(f(1500))).toBe('out-of-order');
  });

  it('rejects impossible jumps over 300 km/h but not 290 km/h', () => {
    const filter = new FixFilter();
    filter.check(f(0));
    // 0.001° lat ≈ 111 m. In 1 s that is ~400 km/h.
    expect(filter.check(f(1000, 50.001))).toBe('jump');
    // The rejected fix does not become the reference: 111 m in 1.4 s ≈ 286 km/h is accepted.
    expect(filter.check(f(1400, 50.001))).toBeNull();
  });

  it('reset forgets the previous fix', () => {
    const filter = new FixFilter();
    filter.check(f(2000));
    filter.reset();
    expect(filter.check(f(1000))).toBeNull();
  });
});
