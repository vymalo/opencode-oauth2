/**
 * Functions that run **inside the target page** via `chrome.scripting.execute-
 * Script({ func })`. They must be fully self-contained (no closures over module
 * scope — only their `args`), because the browser serializes them and re-parses
 * them in the page world.
 *
 * Both executors share these for the DOM-bound work (snapshot, text, scroll,
 * fill, select, wait, element geometry). The CDP executor additionally uses
 * trusted CDP input for click/type/key; the content executor falls back to the
 * synthetic-event functions here.
 *
 * Element targeting is unified through a `data-ocb-ref` attribute: `pageSnapshot`
 * tags elements with `e1, e2, …` and every other function resolves a `ref` to
 * the selector `[data-ocb-ref="<ref>"]`.
 */

export interface Target {
  ref?: string;
  selector?: string;
  x?: number;
  y?: number;
}

export interface Center {
  found: boolean;
  x: number;
  y: number;
}

export interface SnapshotResult {
  snapshot: string;
  refs: number;
}

/** Run a self-contained function in the page and return its result. */
export async function runInPage<Args extends unknown[], Result>(
  tabId: number,
  func: (...args: Args) => Result,
  args: Args
): Promise<Result> {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: func as (...a: unknown[]) => unknown,
    args
  });
  return injection?.result as Result;
}

// ─── Injected page functions ────────────────────────────────────────────────
// Each is exported so the executors can pass it to runInPage. They reference
// only DOM globals and their parameters.

export function pageSnapshot(maxNodes: number): SnapshotResult {
  const SELECTOR =
    'a,button,input,textarea,select,summary,label,[role],[onclick],[tabindex]:not([tabindex="-1"])';
  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return false;
    }
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  };
  const name = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) {
      return aria.trim();
    }
    const ph = el.getAttribute("placeholder");
    if (ph) {
      return ph.trim();
    }
    const val = (el as HTMLInputElement).value;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    return (text || val || "").slice(0, 80);
  };
  // Clear any refs from a prior snapshot so ids stay stable within one capture.
  for (const prev of Array.from(document.querySelectorAll("[data-ocb-ref]"))) {
    prev.removeAttribute("data-ocb-ref");
  }
  const lines: string[] = [];
  let n = 0;
  for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
    if (n >= maxNodes || !isVisible(el)) {
      continue;
    }
    n += 1;
    const ref = `e${n}`;
    el.setAttribute("data-ocb-ref", ref);
    const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
    const type = (el as HTMLInputElement).type ? ` [${(el as HTMLInputElement).type}]` : "";
    const href = (el as HTMLAnchorElement).href ? ` → ${(el as HTMLAnchorElement).href}` : "";
    lines.push(`${ref}\t${role}${type}\t"${name(el)}"${href}`);
  }
  return { snapshot: lines.join("\n") || "(no interactive elements found)", refs: n };
}

export function pageGetText(): string {
  return (document.body?.innerText ?? "").slice(0, 20000);
}

function resolveEl(target: { ref?: string; selector?: string }): Element | null {
  if (target.ref) {
    return document.querySelector(`[data-ocb-ref="${CSS.escape(target.ref)}"]`);
  }
  if (target.selector) {
    return document.querySelector(target.selector);
  }
  return null;
}

export function pageGetCenter(target: Target): Center {
  const el = resolveEl(target);
  if (!el) {
    return { found: false, x: 0, y: 0 };
  }
  el.scrollIntoView({ block: "center", inline: "center" });
  const rect = el.getBoundingClientRect();
  return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

export function pageScroll(opts: {
  deltaX?: number;
  deltaY?: number;
  to?: "top" | "bottom";
  ref?: string;
  selector?: string;
}): boolean {
  // A stale ref/selector must not silently fall back to scrolling the window.
  if ((opts.ref || opts.selector) && !resolveEl(opts)) {
    return false;
  }
  const scroller: Element | (Window & typeof globalThis) =
    opts.ref || opts.selector ? (resolveEl(opts) ?? window) : window;
  if (opts.to === "top") {
    (scroller as Element).scrollTo?.(0, 0) ?? window.scrollTo(0, 0);
    return true;
  }
  if (opts.to === "bottom") {
    const max =
      scroller === window ? document.body.scrollHeight : (scroller as Element).scrollHeight;
    (scroller as Element).scrollTo?.(0, max) ?? window.scrollTo(0, max);
    return true;
  }
  const dx = opts.deltaX ?? 0;
  const dy = opts.deltaY ?? 0;
  if (scroller === window) {
    window.scrollBy(dx, dy);
  } else {
    (scroller as Element).scrollBy(dx, dy);
  }
  return true;
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter ? setter.call(el, value) : (el.value = value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export function pageFill(args: {
  fields: Array<{ ref?: string; selector?: string; value: string }>;
}): number {
  let filled = 0;
  for (const field of args.fields) {
    const el = resolveEl(field);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      (el as HTMLElement).focus();
      setNativeValue(el, field.value);
      filled += 1;
    }
  }
  return filled;
}

export function pageSelect(args: {
  ref?: string;
  selector?: string;
  value?: string;
  values?: string[];
}): boolean {
  const el = resolveEl(args);
  if (!(el instanceof HTMLSelectElement)) {
    return false;
  }
  const wanted = new Set(args.values ?? (args.value !== undefined ? [args.value] : []));
  let matched = 0;
  for (const opt of Array.from(el.options)) {
    const sel = wanted.has(opt.value) || wanted.has(opt.label);
    opt.selected = sel;
    if (sel) {
      matched += 1;
    }
  }
  if (matched === 0) {
    // Requested value(s) matched no option — report failure rather than
    // silently clearing the control.
    return false;
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/** Whether the page's currently-focused element can accept typed text. */
export function pageActiveEditable(): boolean {
  const el = document.activeElement;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}

export async function pageWaitForSelector(args: {
  selector: string;
  state: "visible" | "hidden" | "attached";
  timeoutMs: number;
}): Promise<boolean> {
  const deadline = Date.now() + args.timeoutMs;
  const matches = (): boolean => {
    const el = document.querySelector(args.selector);
    if (args.state === "attached") {
      return el !== null;
    }
    if (!el) {
      return args.state === "hidden";
    }
    const rect = el.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0;
    return args.state === "visible" ? visible : !visible;
  };
  while (Date.now() < deadline) {
    if (matches()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return matches();
}

export function pageSyntheticPointer(args: {
  ref?: string;
  selector?: string;
  x?: number;
  y?: number;
  dblclick?: boolean;
  button?: "left" | "middle" | "right";
}): boolean {
  const useCoords =
    typeof args.x === "number" && typeof args.y === "number" && !args.ref && !args.selector;
  const el =
    resolveEl(args) ??
    (typeof args.x === "number" && typeof args.y === "number"
      ? document.elementFromPoint(args.x, args.y)
      : null);
  if (!(el instanceof HTMLElement)) {
    return false;
  }
  // Only scroll the element into view for ref/selector targets — for explicit
  // coordinates the caller means *those* viewport pixels, and scrolling would
  // move them out from under the click.
  if (!useCoords) {
    el.scrollIntoView({ block: "center" });
  }
  const rect = el.getBoundingClientRect();
  // MouseEvent.button: left=0, middle=1, right=2. MouseEvent.buttons bitfield:
  // left=1, right=2, middle=4.
  const button = args.button ?? "left";
  const buttonIndex = button === "middle" ? 1 : button === "right" ? 2 : 0;
  const buttonsBit = button === "middle" ? 4 : button === "right" ? 2 : 1;
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    button: buttonIndex,
    buttons: buttonsBit,
    clientX: useCoords ? (args.x as number) : rect.left + rect.width / 2,
    clientY: useCoords ? (args.y as number) : rect.top + rect.height / 2,
    view: window
  };
  el.focus();
  el.dispatchEvent(new PointerEvent("pointerdown", init));
  el.dispatchEvent(new MouseEvent("mousedown", init));
  el.dispatchEvent(new PointerEvent("pointerup", init));
  el.dispatchEvent(new MouseEvent("mouseup", init));
  if (button === "right") {
    // Right-click fires contextmenu instead of click.
    el.dispatchEvent(new MouseEvent("contextmenu", init));
  } else {
    el.dispatchEvent(new MouseEvent("click", init));
    if (args.dblclick) {
      el.dispatchEvent(new MouseEvent("dblclick", init));
    }
  }
  return true;
}

export function pageSyntheticType(args: {
  text: string;
  ref?: string;
  selector?: string;
  submit?: boolean;
}): boolean {
  const el =
    (resolveEl(args) as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);
  if (!el) {
    return false;
  }
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // Reuse the native-setter helper so both `input` and `change` fire — many
    // frameworks (React) only validate on `change`.
    setNativeValue(el, (el.value ?? "") + args.text);
  } else if (el.isContentEditable) {
    el.textContent = (el.textContent ?? "") + args.text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    // Not a text-editable target — report failure rather than a false success.
    return false;
  }
  if (args.submit) {
    const enter: KeyboardEventInit = {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter"
    };
    el.dispatchEvent(new KeyboardEvent("keydown", enter));
    el.dispatchEvent(new KeyboardEvent("keyup", enter));
    (el.closest("form") as HTMLFormElement | null)?.requestSubmit?.();
  }
  return true;
}

export function pageSyntheticKey(args: { key: string }): boolean {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  // Parse chords (e.g. "Control+a") into modifier flags + the final key. Kept
  // inline because this function is injected into the page and can't import.
  let ctrlKey = false;
  let altKey = false;
  let shiftKey = false;
  let metaKey = false;
  let key = args.key;
  if (args.key.length > 1) {
    const parts = args.key.split("+");
    key = parts.pop() ?? "";
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower === "ctrl" || lower === "control") ctrlKey = true;
      else if (lower === "alt" || lower === "option") altKey = true;
      else if (lower === "shift") shiftKey = true;
      else if (lower === "meta" || lower === "cmd" || lower === "command" || lower === "super")
        metaKey = true;
    }
  }
  const init: KeyboardEventInit = {
    bubbles: true,
    cancelable: true,
    key,
    code: key,
    ctrlKey,
    altKey,
    shiftKey,
    metaKey
  };
  const notCancelled = target.dispatchEvent(new KeyboardEvent("keydown", init));
  // Synthetic key events don't trigger the browser's default editing actions,
  // so apply the common editable-control effects ourselves (best-effort — the
  // CDP executor handles the rest via trusted input). Skip if a listener called
  // preventDefault, or if a modifier chord is held.
  let applied = false;
  if (
    notCancelled &&
    !ctrlKey &&
    !altKey &&
    !metaKey &&
    (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
  ) {
    const field = target;
    try {
      // selectionStart/setRangeText throw on inputs that don't support
      // selection (e.g. type=number); fall back to dispatch-only there.
      const start = field.selectionStart ?? field.value.length;
      const end = field.selectionEnd ?? start;
      if (key === "Backspace") {
        field.setRangeText("", start === end ? Math.max(0, start - 1) : start, end, "end");
        applied = true;
      } else if (key === "Delete") {
        field.setRangeText(
          "",
          start,
          start === end ? Math.min(field.value.length, end + 1) : end,
          "end"
        );
        applied = true;
      } else if (key === "Enter") {
        if (field instanceof HTMLTextAreaElement) {
          field.setRangeText("\n", start, end, "end");
          applied = true;
        } else {
          (field.closest("form") as HTMLFormElement | null)?.requestSubmit?.();
          applied = true;
        }
      }
    } catch {
      applied = false;
    }
    if (applied) {
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  return true;
}
