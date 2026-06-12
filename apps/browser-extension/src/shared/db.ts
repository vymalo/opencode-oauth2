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

export async function recordAction(record: Omit<ActionRecord, "id">): Promise<void> {
  await db.actions.add(record);
  const count = await db.actions.count();
  if (count > MAX_ACTIONS) {
    const stale = await db.actions
      .orderBy("id")
      .limit(count - MAX_ACTIONS)
      .primaryKeys();
    await db.actions.bulkDelete(stale);
  }
}

export async function recordScreenshot(record: Omit<ScreenshotRecord, "id">): Promise<void> {
  await db.screenshots.add(record);
  const count = await db.screenshots.count();
  if (count > MAX_SCREENSHOTS) {
    const stale = await db.screenshots
      .orderBy("id")
      .limit(count - MAX_SCREENSHOTS)
      .primaryKeys();
    await db.screenshots.bulkDelete(stale);
  }
}

export async function clearHistory(): Promise<void> {
  await db.transaction("rw", db.actions, db.screenshots, async () => {
    await db.actions.clear();
    await db.screenshots.clear();
  });
}
