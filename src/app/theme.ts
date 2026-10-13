// Applies Settings.theme to the page (Phase 5). The colours themselves live in index.css.

import { create } from 'zustand';
import type { Settings } from '../data/types';

export type Theme = Settings['theme'];

export const THEME_KEY = 'laptimer-theme';

/** Browser chrome colour per theme (the page background). */
const THEME_COLOR: Record<Theme, string> = {
  dark: '#0a0a0a',
  light: '#fafafa',
  sunlight: '#ffffff',
};

/** The theme in use, for code that can't use CSS variables (canvas charts). */
export const useTheme = create<{ theme: Theme }>(() => ({ theme: 'dark' }));

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme === 'dark') delete root.dataset.theme;
  else root.dataset.theme = theme;
  root.ownerDocument
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', THEME_COLOR[theme]);
  useTheme.setState({ theme });
  try {
    // Read by the inline script in index.html, so the first paint already has the right theme.
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // storage blocked: the theme still applies once settings load
  }
}

/** A theme colour variable's current value, e.g. cssColor('--color-neutral-400'). */
export function cssColor(name: string, fallback: string): string {
  if (typeof getComputedStyle === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
