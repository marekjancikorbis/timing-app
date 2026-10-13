import type { LapTimerDb } from './db';
import { DEFAULT_SETTINGS, type Settings } from './types';

export function createSettingsRepo(db: LapTimerDb) {
  return {
    /** Stored settings over the defaults, so new settings get a value on old databases. */
    async get(): Promise<Settings> {
      const row = await db.settings.get('app');
      if (!row) return { ...DEFAULT_SETTINGS };
      const { key: _key, ...stored } = row;
      return { ...DEFAULT_SETTINGS, ...stored };
    },

    async update(patch: Partial<Settings>): Promise<Settings> {
      const next = { ...(await this.get()), ...patch };
      await db.settings.put({ key: 'app', ...next });
      return next;
    },
  };
}
