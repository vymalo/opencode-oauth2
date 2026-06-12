import { db } from "../shared/db";
import type { GroupRecord } from "../shared/types";
import type { Executor } from "./executor";

const LOAD_TIMEOUT_MS = 15_000;

function hasTabGroups(): boolean {
  return (
    typeof chrome !== "undefined" && typeof chrome.tabs?.group === "function" && !!chrome.tabGroups
  );
}

/** Wait until a tab finishes loading (or the timeout elapses). */
async function waitForComplete(
  tabId: number,
  timeoutMs = LOAD_TIMEOUT_MS
): Promise<chrome.tabs.Tab> {
  const deadline = Date.now() + timeoutMs;
  let tab = await chrome.tabs.get(tabId);
  while (tab.status !== "complete" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    tab = await chrome.tabs.get(tabId);
  }
  return tab;
}

export interface TabInfo {
  tabId: number;
  url: string;
  title: string;
}

/**
 * Owns the mapping from a named group to its tabs. On Chromium it creates a real
 * titled tab group; on Firefox (no tabGroups API) it keeps a logical registry
 * only. Mirrors state into IndexedDB so the dashboard can render live.
 */
export class GroupRegistry {
  private readonly groups = new Map<string, GroupRecord>();

  constructor(private readonly executor: Executor) {}

  private async persist(record: GroupRecord): Promise<void> {
    this.groups.set(record.name, record);
    await db.groups.put(record).catch(() => {});
  }

  private async groupTab(name: string, tabId: number): Promise<number | undefined> {
    if (!hasTabGroups()) {
      return undefined;
    }
    const existing = this.groups.get(name);
    try {
      const groupId = await chrome.tabs.group(
        existing?.tabGroupId
          ? { tabIds: [tabId], groupId: existing.tabGroupId }
          : { tabIds: [tabId] }
      );
      await chrome.tabGroups.update(groupId, { title: name });
      return groupId;
    } catch {
      return existing?.tabGroupId;
    }
  }

  async open(name: string, url?: string, focus = true): Promise<TabInfo> {
    const created = await chrome.tabs.create({ url: url ?? "about:blank", active: focus });
    const tabId = created.id;
    if (tabId === undefined) {
      throw new Error("failed to create tab");
    }
    const tabGroupId = await this.groupTab(name, tabId);
    const tab = await waitForComplete(tabId);
    const existing = this.groups.get(name);
    await this.persist({
      name,
      tabIds: existing ? [...new Set([...existing.tabIds, tabId])] : [tabId],
      activeTabId: tabId,
      tabGroupId,
      createdAt: existing?.createdAt ?? Date.now()
    });
    return { tabId, url: tab.url ?? url ?? "about:blank", title: tab.title ?? "" };
  }

  /** Resolve which tab an action targets. */
  resolveTab(name: string, tabId?: number): number {
    if (tabId !== undefined) {
      return tabId;
    }
    const group = this.groups.get(name);
    const resolved = group?.activeTabId ?? group?.tabIds[0];
    if (resolved === undefined) {
      throw new Error(`group "${name}" has no open tabs — call browser_open first`);
    }
    return resolved;
  }

  async navigate(name: string, url: string, tabId?: number): Promise<TabInfo> {
    const target = this.resolveTab(name, tabId);
    await chrome.tabs.update(target, { url });
    const tab = await waitForComplete(target);
    const group = this.groups.get(name);
    if (group) {
      await this.persist({ ...group, activeTabId: target });
    }
    return { tabId: target, url: tab.url ?? url, title: tab.title ?? "" };
  }

  async list(name?: string): Promise<{ groups: Array<GroupRecord & { tabs: TabInfo[] }> }> {
    const wanted = name ? [this.groups.get(name)].filter(Boolean) : [...this.groups.values()];
    const groups = await Promise.all(
      (wanted as GroupRecord[]).map(async (group) => {
        const tabs: TabInfo[] = [];
        for (const tabId of group.tabIds) {
          try {
            const tab = await chrome.tabs.get(tabId);
            tabs.push({ tabId, url: tab.url ?? "", title: tab.title ?? "" });
          } catch {
            /* tab gone; pruned on next close/removal event */
          }
        }
        return { ...group, tabs };
      })
    );
    return { groups };
  }

  async close(name: string, tabId?: number): Promise<{ closed: number[] }> {
    const group = this.groups.get(name);
    if (!group) {
      return { closed: [] };
    }
    const toClose = tabId !== undefined ? [tabId] : [...group.tabIds];
    for (const id of toClose) {
      await this.executor.release(id).catch(() => {});
      await chrome.tabs.remove(id).catch(() => {});
    }
    const remaining = group.tabIds.filter((id) => !toClose.includes(id));
    if (remaining.length === 0) {
      this.groups.delete(name);
      await db.groups.delete(name).catch(() => {});
    } else {
      await this.persist({
        ...group,
        tabIds: remaining,
        activeTabId: remaining.includes(group.activeTabId ?? -1) ? group.activeTabId : remaining[0]
      });
    }
    return { closed: toClose };
  }

  /** Drop a tab that was closed out-of-band (user closed it). */
  async forget(tabId: number): Promise<string | null> {
    for (const group of this.groups.values()) {
      if (!group.tabIds.includes(tabId)) {
        continue;
      }
      await this.executor.release(tabId).catch(() => {});
      const remaining = group.tabIds.filter((id) => id !== tabId);
      if (remaining.length === 0) {
        this.groups.delete(group.name);
        await db.groups.delete(group.name).catch(() => {});
      } else {
        await this.persist({
          ...group,
          tabIds: remaining,
          activeTabId: group.activeTabId === tabId ? remaining[0] : group.activeTabId
        });
      }
      return group.name;
    }
    return null;
  }
}
