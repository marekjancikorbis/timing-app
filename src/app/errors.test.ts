// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearErrorLog,
  getErrorLog,
  installGlobalHandlers,
  recordError,
  scrub,
  setRemoteReporter,
} from './errors';

beforeEach(() => localStorage.clear());
afterEach(() => setRemoteReporter(null));

describe('scrub', () => {
  it('removes coordinate-like numbers from text', () => {
    expect(scrub('fix at 50.0812345, 14.4212345 rejected')).toBe(
      'fix at [coord], [coord] rejected',
    );
    expect(scrub('lat -33.86880 lon 151.20930')).toBe('lat [coord] lon [coord]');
  });

  it('keeps ordinary numbers', () => {
    expect(scrub('sector 3 took 12.34 s, 1000 m, index-abc.js:1:12345')).toBe(
      'sector 3 took 12.34 s, 1000 m, index-abc.js:1:12345',
    );
  });

  it('removes position fields at any depth and scrubs nested text', () => {
    const event = {
      message: 'bad 50.08123',
      extra: { lat: 50.1, lon: 14.4, nested: [{ coords: [1, 2], note: 'ok 14.42123' }] },
      trace: [{ t: 1 }],
    };
    expect(scrub(event)).toEqual({
      message: 'bad [coord]',
      extra: {
        lat: '[removed]',
        lon: '[removed]',
        nested: [{ coords: '[removed]', note: 'ok [coord]' }],
      },
      trace: '[removed]',
    });
  });

  it('does not pass on structures too deep to check', () => {
    let deep: unknown = { lat: 1 };
    for (let i = 0; i < 20; i++) deep = { inner: deep };
    expect(JSON.stringify(scrub(deep))).not.toContain('"lat"');
  });
});

describe('error log', () => {
  it('keeps the last 50 errors, scrubbed, and reports each one', () => {
    const report = vi.fn();
    setRemoteReporter(report);
    for (let i = 0; i < 55; i++) recordError(new Error(`boom ${i} at 50.123456`), 'window', i);
    const log = getErrorLog();
    expect(log).toHaveLength(50);
    expect(log[0]?.message).toBe('boom 5 at [coord]');
    expect(log.at(-1)).toMatchObject({ at: 54, source: 'window' });
    expect(report).toHaveBeenCalledTimes(55);
    clearErrorLog();
    expect(getErrorLog()).toEqual([]);
  });

  it('records non-Error values', () => {
    expect(recordError('plain text', 'promise').message).toBe('plain text');
  });

  it('catches uncaught errors and unhandled rejections', () => {
    const target = new EventTarget() as Window;
    installGlobalHandlers(target);
    target.dispatchEvent(Object.assign(new Event('error'), { error: new Error('uncaught') }));
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'rejected' }));
    expect(getErrorLog().map((e) => [e.source, e.message])).toEqual([
      ['window', 'uncaught'],
      ['promise', 'rejected'],
    ]);
  });
});
