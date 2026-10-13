// App-wide singletons. Pages import these; tests build their own on fake-indexeddb.
import { getDb } from '../data/db';
import { createGpsLogsRepo } from '../data/gpsLogsRepo';
import { createRoutesRepo } from '../data/routesRepo';
import { createRunsRepo } from '../data/runsRepo';
import { createSettingsRepo } from '../data/settingsRepo';

export const db = getDb();
export const routesRepo = createRoutesRepo(db);
export const runsRepo = createRunsRepo(db);
export const settingsRepo = createSettingsRepo(db);
export const gpsLogsRepo = createGpsLogsRepo(db);
