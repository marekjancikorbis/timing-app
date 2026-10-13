// Back up and restore all data (§3.2 should-have, R10: iOS may evict storage). A backup is the
// database as JSON, gzip-compressed with fflate (§9.4). Restore validates the file with Zod before
// touching the database, and runs in one transaction.

import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';
import { z } from 'zod';
import type { LapTimerDb } from '../../data/db';
import type {
  GpsLog,
  ReferenceChoice,
  Route,
  Run,
  Session,
  Settings,
  Trace,
} from '../../data/types';

export const BACKUP_FORMAT = 'laptimer-backup';
export const BACKUP_VERSION = 1;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: number;
  routes: Route[];
  sessions: Session[];
  runs: Run[];
  traces: Trace[];
  referenceChoices: ReferenceChoice[];
  gpsLogs: GpsLog[];
  /** Without the OpenRouteService key: a backup file may be shared. */
  settings?: Partial<Settings>;
}

const id = z.string().min(1);
const lonLat = z.tuple([z.number(), z.number()]);
const gate = z.object({ a: lonLat, b: lonLat, bearingDeg: z.number() });
const startMode = z.enum(['flying', 'standing']);

// Checked closely where a bad value would break the app; extra fields are kept (passthrough) so a
// backup from a newer version still restores what this version understands.
const RouteZ = z.looseObject({
  id,
  name: z.string(),
  type: z.enum(['circuit', 'stage']),
  geometry: z.array(lonLat).min(2),
  lengthM: z.number().positive(),
  intervalM: z.number().positive(),
  gateWidthM: z.number().positive(),
  startGate: gate,
  finishGate: gate.optional(),
  defaultStartMode: startMode,
  defaultCountdownS: z.number(),
  source: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const SessionZ = z.looseObject({
  id,
  routeId: id,
  startedAt: z.number(),
  notes: z.string().optional(),
});
const RunZ = z.looseObject({
  id,
  sessionId: id,
  routeId: id,
  lapNumber: z.number().int(),
  startMode,
  startTime: z.number(),
  totalMs: z.number(),
  intervalM: z.number(),
  sectorMs: z.array(z.number()),
  sectorFlags: z.array(z.enum(['ok', 'estimated'])),
  valid: z.boolean(),
  traceId: id,
});
const TraceZ = z.looseObject({
  id,
  points: z.array(
    z.looseObject({ t: z.number(), lat: z.number(), lon: z.number(), acc: z.number() }),
  ),
  profile: z.object({ s: z.array(z.number()), t: z.array(z.number()) }),
});
const ChoiceZ = z.looseObject({
  id,
  routeId: id,
  startMode,
  kind: z.enum(['best', 'session-best', 'run']),
  runId: z.string().optional(),
});
const GpsLogZ = z.looseObject({
  id,
  name: z.string(),
  startedAt: z.number(),
  updatedAt: z.number(),
  fixes: z.array(z.looseObject({ t: z.number(), lat: z.number(), lon: z.number() })),
});

const BackupZ = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.number().int().positive(),
  exportedAt: z.number(),
  routes: z.array(RouteZ),
  sessions: z.array(SessionZ),
  runs: z.array(RunZ),
  traces: z.array(TraceZ),
  referenceChoices: z.array(ChoiceZ).default([]),
  gpsLogs: z.array(GpsLogZ).default([]),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export async function createBackup(db: LapTimerDb, now = Date.now()): Promise<Backup> {
  return db.transaction(
    'r',
    [db.routes, db.sessions, db.runs, db.traces, db.referenceChoices, db.gpsLogs, db.settings],
    async () => {
      const row = await db.settings.get('app');
      let settings: Partial<Settings> | undefined;
      if (row) {
        const { key: _key, orsApiKey: _secret, ...rest } = row;
        settings = rest;
      }
      const backup: Backup = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: now,
        routes: await db.routes.toArray(),
        sessions: await db.sessions.toArray(),
        runs: await db.runs.toArray(),
        traces: await db.traces.toArray(),
        referenceChoices: await db.referenceChoices.toArray(),
        gpsLogs: await db.gpsLogs.toArray(),
      };
      if (settings) backup.settings = settings;
      return backup;
    },
  );
}

/** Backup → gzip bytes. */
export function encodeBackup(b: Backup): Uint8Array<ArrayBuffer> {
  return gzipSync(strToU8(JSON.stringify(b)), { level: 6 });
}

export type ParsedBackup = { ok: true; backup: Backup } | { ok: false; error: string };

/** Bytes of a backup file (gzip or plain JSON) → a validated backup, or a readable error. */
export function decodeBackup(bytes: Uint8Array): ParsedBackup {
  let text: string;
  try {
    const gz = bytes[0] === 0x1f && bytes[1] === 0x8b;
    text = strFromU8(gz ? gunzipSync(bytes) : bytes);
  } catch {
    return { ok: false, error: 'The file is damaged (it could not be decompressed).' };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This is not a Lap Timer backup (not JSON).' };
  }
  if ((json as { format?: unknown })?.format !== BACKUP_FORMAT) {
    return { ok: false, error: 'This is not a Lap Timer backup.' };
  }
  if (((json as { version?: number }).version ?? 0) > BACKUP_VERSION) {
    return {
      ok: false,
      error: 'This backup was made by a newer version of the app. Update first.',
    };
  }
  const parsed = BackupZ.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `The backup is damaged (${issue?.path.join('.') || 'file'}: ${issue?.message}).`,
    };
  }
  return { ok: true, backup: parsed.data as unknown as Backup };
}

export interface RestoreSummary {
  routes: number;
  runs: number;
  gpsLogs: number;
}

/**
 * Write a backup into the database. 'merge' adds and overwrites by id, keeping everything else;
 * 'replace' deletes all current data first. The OpenRouteService key on this device is kept.
 */
export async function restoreBackup(
  db: LapTimerDb,
  b: Backup,
  mode: 'merge' | 'replace',
): Promise<RestoreSummary> {
  const tables = [
    db.routes,
    db.sessions,
    db.runs,
    db.traces,
    db.referenceChoices,
    db.gpsLogs,
    db.settings,
  ];
  await db.transaction('rw', tables, async () => {
    if (mode === 'replace') {
      for (const t of tables) if (t !== db.settings) await t.clear();
    }
    await db.routes.bulkPut(b.routes);
    await db.sessions.bulkPut(b.sessions);
    await db.traces.bulkPut(b.traces);
    await db.runs.bulkPut(b.runs);
    await db.referenceChoices.bulkPut(b.referenceChoices);
    await db.gpsLogs.bulkPut(b.gpsLogs);
    if (b.settings) {
      const current = await db.settings.get('app');
      const { orsApiKey: _ignored, ...incoming } = b.settings;
      await db.settings.put({
        ...(current ?? {}),
        ...incoming,
        orsApiKey: current?.orsApiKey ?? '',
        key: 'app',
      } as never);
    }
  });
  return { routes: b.routes.length, runs: b.runs.length, gpsLogs: b.gpsLogs.length };
}

export function backupFileName(now = Date.now()): string {
  return `laptimer-backup-${new Date(now).toISOString().slice(0, 10)}.json.gz`;
}
