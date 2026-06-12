import { recordAction, recordScreenshot } from "../shared/db";
import type { CommandFrame } from "../shared/protocol";
import type { Executor } from "./executor";
import type { GroupRegistry } from "./group-registry";
import {
  pageFill,
  pageGetText,
  pageScroll,
  pageSelect,
  pageSnapshot,
  pageWaitForSelector,
  runInPage,
  type Target
} from "./page-actions";

const SNAPSHOT_MAX_NODES = 200;

function target(params: Record<string, unknown>): Target {
  return {
    ref: params.ref as string | undefined,
    selector: params.selector as string | undefined,
    x: params.x as number | undefined,
    y: params.y as number | undefined
  };
}

/**
 * Translates a single `command` frame into registry / executor / page-action
 * calls and returns the `data` the plugin tool expects. Records every action
 * (and screenshot) to IndexedDB for the dashboard — including failures.
 */
export class CommandRouter {
  constructor(
    private readonly registry: GroupRegistry,
    private readonly executor: Executor
  ) {}

  async handle(frame: CommandFrame): Promise<unknown> {
    const start = Date.now();
    try {
      const { data, summary } = await this.dispatch(frame);
      await recordAction({
        ts: start,
        group: frame.group,
        action: frame.action,
        ok: true,
        summary,
        durationMs: Date.now() - start
      });
      return data;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordAction({
        ts: start,
        group: frame.group,
        action: frame.action,
        ok: false,
        summary: message,
        durationMs: Date.now() - start
      });
      throw err;
    }
  }

  private async dispatch(frame: CommandFrame): Promise<{ data: unknown; summary: string }> {
    const { action, group, params } = frame;

    switch (action) {
      case "open": {
        const info = await this.registry.open(
          group,
          params.url as string | undefined,
          params.focus as boolean | undefined
        );
        return { data: info, summary: `opened ${info.url}` };
      }
      case "navigate": {
        const info = await this.registry.navigate(
          group,
          params.url as string,
          params.tabId as number | undefined
        );
        return { data: info, summary: `navigated to ${info.url}` };
      }
      case "tabs": {
        const data = await this.registry.list((params.group as string | undefined) || undefined);
        return { data, summary: `listed ${data.groups.length} group(s)` };
      }
      case "close": {
        const data = await this.registry.close(group, params.tabId as number | undefined);
        return { data, summary: `closed ${data.closed.length} tab(s)` };
      }
      case "click": {
        const tabId = this.registry.resolveTab(group, params.tabId as number | undefined);
        await this.executor.click(
          tabId,
          target(params),
          (params.button as "left" | "middle" | "right") ?? "left"
        );
        return { data: { ok: true }, summary: "clicked" };
      }
      case "double_click": {
        const tabId = this.registry.resolveTab(group, params.tabId as number | undefined);
        await this.executor.doubleClick(tabId, target(params));
        return { data: { ok: true }, summary: "double-clicked" };
      }
      case "type": {
        const tabId = this.registry.resolveTab(group, params.tabId as number | undefined);
        await this.executor.type(
          tabId,
          params.text as string,
          target(params),
          Boolean(params.submit)
        );
        return { data: { ok: true }, summary: `typed ${(params.text as string).length} chars` };
      }
      case "press_key": {
        const tabId = this.registry.resolveTab(group, params.tabId as number | undefined);
        await this.executor.pressKey(tabId, params.key as string);
        return { data: { ok: true }, summary: `pressed ${params.key}` };
      }
      case "fill": {
        const tabId = this.registry.resolveTab(group, params.tabId as number | undefined);
        const fields = params.fields as Array<{ ref?: string; selector?: string; value: string }>;
        const filled = await runInPage(tabId, pageFill, [{ fields }]);
        return { data: { filled }, summary: `filled ${filled} field(s)` };
      }
      case "select": {
        const tabId = this.registry.resolveTab(group, params.tabId as number | undefined);
        const ok = await runInPage(tabId, pageSelect, [
          {
            ref: params.ref as string | undefined,
            selector: params.selector as string | undefined,
            value: params.value as string | undefined,
            values: params.values as string[] | undefined
          }
        ]);
        if (!ok) {
          throw new Error("select target not found or not a <select> element");
        }
        return { data: { ok }, summary: "selected" };
      }
      case "scroll": {
        const tabId = this.registry.resolveTab(group, params.tabId as number | undefined);
        await runInPage(tabId, pageScroll, [
          {
            deltaX: params.deltaX as number | undefined,
            deltaY: params.deltaY as number | undefined,
            to: params.to as "top" | "bottom" | undefined,
            ref: params.ref as string | undefined,
            selector: params.selector as string | undefined
          }
        ]);
        return { data: { ok: true }, summary: "scrolled" };
      }
      case "snapshot": {
        const tabId = this.registry.resolveTab(group, params.tabId as number | undefined);
        const result = await runInPage(tabId, pageSnapshot, [SNAPSHOT_MAX_NODES]);
        return { data: result, summary: `snapshot (${result.refs} refs)` };
      }
      case "get_text": {
        const tabId = this.registry.resolveTab(group, params.tabId as number | undefined);
        const text = await runInPage(tabId, pageGetText, []);
        return { data: { text }, summary: `read ${text.length} chars` };
      }
      case "wait": {
        const tabId = this.registry.resolveTab(group, params.tabId as number | undefined);
        if (typeof params.ms === "number") {
          await new Promise((r) => setTimeout(r, params.ms as number));
          return { data: { ok: true }, summary: `waited ${params.ms}ms` };
        }
        const state = (params.state as "visible" | "hidden" | "attached") ?? "visible";
        const found = await runInPage(tabId, pageWaitForSelector, [
          { selector: params.selector as string, state, timeoutMs: 10_000 }
        ]);
        if (!found) {
          throw new Error(`timed out waiting for ${params.selector} to be ${state}`);
        }
        return { data: { found }, summary: `waited for ${params.selector}` };
      }
      case "screenshot": {
        const tabId = this.registry.resolveTab(group, params.tabId as number | undefined);
        const shot = await this.executor.screenshot(tabId, Boolean(params.fullPage));
        await recordScreenshot({
          ts: Date.now(),
          group,
          dataUrl: `data:image/png;base64,${shot.base64}`,
          width: shot.width,
          height: shot.height
        });
        return { data: shot, summary: `screenshot ${shot.width}×${shot.height}` };
      }
      default:
        throw new Error(`unknown action: ${action}`);
    }
  }
}
