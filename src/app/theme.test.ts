// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { applyTheme, THEME_KEY, useTheme } from './theme';

beforeEach(() => {
  document.head.innerHTML = '<meta name="theme-color" content="#0a0a0a">';
  localStorage.clear();
});

describe('applyTheme', () => {
  it('sets the theme attribute, browser colour, store and saved choice', () => {
    applyTheme('sunlight');
    expect(document.documentElement.dataset.theme).toBe('sunlight');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      '#ffffff',
    );
    expect(useTheme.getState().theme).toBe('sunlight');
    expect(localStorage.getItem(THEME_KEY)).toBe('sunlight');
  });

  it('dark is the default stylesheet: no attribute', () => {
    applyTheme('light');
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      '#0a0a0a',
    );
  });
});
