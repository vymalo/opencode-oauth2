import Dexie, { type Table } from "dexie";

import {
  type ActionRecord,
  DEFAULT_SETTINGS,
  type GroupRecord,
  type ScreenshotRecord,
  type Settings,
  type Status
} from "./types";

/** Keep the gallery/timeline from growing without bound. */
const MAX_ACTIONS = 500;
const MAX_SCREENSHOTS = 100;

/**
 * Single IndexedDB store shared by the background worker (writer) and the UI
 * (reader, via dexie-react-hooks `useLiveQuery`). Both run in the same
 * extension origin, so they see the same database.
 */
export class OcbDatabase extends Dexie {
  settings!: Table<Settings, string>;
  status!: Table<Status, string>;
  actions!: Table<ActionRecord, number>;
  screenshots!: Table<ScreenshotRecord, number>;
  groups!: Table<GroupRecord, string>;

  constructor() {
    super("opencode-browser");
    this.version(1).stores({
      settings: "id",
      status: "id",
      actions: "++id, ts, group, action",
      screenshots: "++id, ts, group",
      groups: "name, createdAt"
    });
  }
}

export const db = new OcbDatabase();

export async function getSettings(): Promise<Settings> {
  const row = await db.settings.get("singleton");
  return row ?? DEFAULT_SETTINGS;
}

export async function saveSettings(patch: Partial<Omit<Settings, "id">>): Promise<Settings> {
  const next: Settings = { ...(await getSettings()), ...patch, id: "singleton" };
  await db.settings.put(next);
  return next;
}

export async function getStatus(): Promise<Status> {
  const row = await db.status.get("singleton");
  return row ?? { id: "singleton", state: "disconnected" };
}

export async function setStatus(patch: Partial<Omit<Status, "id">>): Promise<void> {
  const next: Status = { ...(await getStatus()), ...patch, id: "singleton" };
  await db.status.put(next);
}

/** Drop the oldest rows so a table stays at/under `cap` after one more insert. */
async function pruneTo<T>(table: Table<T, number>, cap: number): Promise<void> {
  const count = await table.count();
  if (count >= cap) {
    const stale = await table
      .orderBy("id")
      .limit(count - cap + 1)
      .primaryKeys();
    await table.bulkDelete(stale);
  }
}

// Both writes are a dashboard convenience, not the source of truth (the plugin
// writes the PNG to disk). Prune *before* inserting so a near-quota gallery
// can't throw QuotaExceededError, and swallow errors so recording never breaks
// the actual browser command.
export async function recordAction(record: Omit<ActionRecord, "id">): Promise<void> {
  try {
    await pruneTo(db.actions, MAX_ACTIONS);
    await db.actions.add(record);
  } catch {
    /* best-effort */
  }
}

export async function recordScreenshot(record: Omit<ScreenshotRecord, "id">): Promise<void> {
  try {
    await pruneTo(db.screenshots, MAX_SCREENSHOTS);
    await db.screenshots.add(record);
  } catch {
    /* best-effort */
  }
}

export async function clearHistory(): Promise<void> {
  await db.transaction("rw", db.actions, db.screenshots, async () => {
    await db.actions.clear();
    await db.screenshots.clear();
  });
}
