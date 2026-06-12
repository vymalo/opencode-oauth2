import { useLiveQuery } from "dexie-react-hooks";

import { db, getSettings, getStatus } from "../shared/db";
import { DEFAULT_SETTINGS, type Status } from "../shared/types";

const DISCONNECTED: Status = { id: "singleton", state: "disconnected" };

export function useStatus(): Status {
  return useLiveQuery(() => getStatus(), [], DISCONNECTED);
}

export function useSettings() {
  return useLiveQuery(() => getSettings(), [], DEFAULT_SETTINGS);
}

export function useActions() {
  return useLiveQuery(() => db.actions.orderBy("id").reverse().limit(200).toArray(), [], []);
}

export function useScreenshots() {
  return useLiveQuery(() => db.screenshots.orderBy("id").reverse().limit(60).toArray(), [], []);
}

export function useGroups() {
  return useLiveQuery(() => db.groups.orderBy("createdAt").toArray(), [], []);
}
