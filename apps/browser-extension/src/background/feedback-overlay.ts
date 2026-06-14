/**
 * In-page feedback overlay for `interactive` requests. Like `page-actions`, the
 * overlay function is injected via `chrome.scripting.executeScript({ func })`,
 * so it is serialized and re-evaluated in the page with **no module scope** —
 * everything it needs lives inside the single self-contained `feedbackOverlay`.
 *
 * It does NOT block: it paints the overlay, wires listeners, and returns. The
 * user's response (or a dismissal) comes back to the background worker via
 * `chrome.runtime.sendMessage` (the background owns the timeout + correlation).
 * Teardown is a second tiny injection that removes the overlay element, so the
 * background can cancel a request without a page-side message channel.
 */

export type FeedbackMode = "confirm" | "choose" | "point";

export interface FeedbackRequest {
  mode: FeedbackMode;
  prompt?: string;
  options?: string[];
  /** Background-owned deadline (ms); the overlay itself does not self-expire. */
  timeoutMs: number;
}

/** One mark the user made; mirrors the plugin's `Annotation` wire shape. */
export type FeedbackAnnotation =
  | { kind: "confirm"; value: boolean }
  | { kind: "choice"; value: string }
  | { kind: "point"; x: number; y: number; ref?: string; selector?: string; text?: string };

/** Message the injected overlay posts back to the background worker. */
export interface FeedbackMessage {
  type: "ocb-feedback-result";
  id: string;
  /** False when the user dismissed/skipped rather than answering. */
  responded: boolean;
  annotations: FeedbackAnnotation[];
}

/** Paint the overlay in the page. Resolves once injected (does not wait for input). */
export async function showFeedbackOverlay(
  tabId: number,
  id: string,
  req: FeedbackRequest
): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: feedbackOverlay,
    args: [id, req.mode, req.prompt ?? "", req.options ?? []]
  });
}

/** Remove the overlay for `id` from the page (best-effort). */
export async function hideFeedbackOverlay(tabId: number, id: string): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (overlayId: string) => {
        document.getElementById(`ocb-feedback-${overlayId}`)?.remove();
      },
      args: [id]
    });
  } catch {
    /* tab navigated/closed — nothing to remove */
  }
}

/**
 * THE injected overlay. Self-contained (all helpers inside). Runs in the page's
 * isolated content-script world, so `chrome.runtime.sendMessage` is available.
 */
function feedbackOverlay(id: string, mode: string, prompt: string, options: string[]): void {
  const elementId = `ocb-feedback-${id}`;
  document.getElementById(elementId)?.remove();

  const send = (responded: boolean, annotations: unknown[]): void => {
    chrome.runtime.sendMessage({ type: "ocb-feedback-result", id, responded, annotations });
  };

  const ACCENT = "#3b82f6";
  const root = document.createElement("div");
  root.id = elementId;
  root.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483647",
    "font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
    "color:#0f172a"
  ].join(";");

  // Brand bar (anti-spoof: clearly identifies the source of the prompt).
  const bar = document.createElement("div");
  bar.style.cssText = [
    "position:absolute",
    "top:0",
    "left:0",
    "right:0",
    "display:flex",
    "align-items:center",
    "gap:8px",
    "padding:8px 12px",
    "background:#0f172a",
    "color:#f8fafc",
    "font-size:13px",
    "box-shadow:0 1px 6px rgba(0,0,0,.25)"
  ].join(";");
  const dot = document.createElement("span");
  dot.style.cssText = `width:8px;height:8px;border-radius:9999px;background:${ACCENT};flex:none`;
  const brand = document.createElement("span");
  brand.style.cssText = "font-weight:600";
  brand.textContent = "opencode-browser";
  const msg = document.createElement("span");
  msg.style.cssText = "opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  msg.textContent = prompt || "is asking for your input";
  bar.append(dot, brand, msg);
  root.appendChild(bar);

  const skip = (): void => {
    cleanup();
    send(false, []);
  };

  const finish = (annotations: unknown[]): void => {
    cleanup();
    send(true, annotations);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      skip();
    }
  };
  function cleanup(): void {
    document.removeEventListener("keydown", onKey, true);
    root.remove();
  }
  document.addEventListener("keydown", onKey, true);

  const btn = (label: string, primary: boolean): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText = [
      "padding:6px 14px",
      "border-radius:8px",
      "font-size:13px",
      "font-weight:600",
      "cursor:pointer",
      `border:1px solid ${primary ? ACCENT : "#cbd5e1"}`,
      `background:${primary ? ACCENT : "#fff"}`,
      `color:${primary ? "#fff" : "#0f172a"}`
    ].join(";");
    return b;
  };

  if (mode === "point") {
    // Transparent capture layer below the bar; click picks a page element.
    const capture = document.createElement("div");
    capture.style.cssText = [
      "position:absolute",
      "inset:36px 0 0 0",
      "cursor:crosshair",
      "background:rgba(59,130,246,.06)"
    ].join(";");
    const hint = document.createElement("div");
    hint.style.cssText = [
      "position:absolute",
      "bottom:16px",
      "left:50%",
      "transform:translateX(-50%)",
      "background:#0f172a",
      "color:#f8fafc",
      "padding:6px 12px",
      "border-radius:9999px",
      "font-size:12px"
    ].join(";");
    hint.textContent = "Click the element you mean — Esc to skip";
    capture.appendChild(hint);
    capture.addEventListener("click", (e: MouseEvent) => {
      const x = e.clientX;
      const y = e.clientY;
      root.style.display = "none";
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      root.style.display = "";
      const annotation: Record<string, unknown> = { kind: "point", x, y };
      if (el) {
        let node: HTMLElement | null = el;
        while (node && !node.getAttribute("data-ocb-ref")) {
          node = node.parentElement;
        }
        const ref = node?.getAttribute("data-ocb-ref") ?? undefined;
        if (ref) {
          annotation.ref = ref;
        }
        annotation.selector = cssPath(el);
        const label = (el.textContent || "").trim().slice(0, 80);
        if (label) {
          annotation.text = label;
        }
      }
      finish([annotation]);
    });
    root.appendChild(capture);
  } else {
    const panel = document.createElement("div");
    panel.style.cssText = [
      "position:absolute",
      "top:50%",
      "left:50%",
      "transform:translate(-50%,-50%)",
      "min-width:280px",
      "max-width:420px",
      "background:#fff",
      "border:1px solid #e2e8f0",
      "border-radius:14px",
      "box-shadow:0 12px 40px rgba(2,6,23,.28)",
      "padding:18px"
    ].join(";");
    const q = document.createElement("div");
    q.style.cssText = "font-size:14px;line-height:1.4;margin-bottom:14px";
    q.textContent = prompt || (mode === "confirm" ? "Confirm?" : "Choose one:");
    panel.appendChild(q);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end";

    if (mode === "choose") {
      for (const opt of options.length ? options : ["OK"]) {
        const b = btn(opt, false);
        b.addEventListener("click", () => finish([{ kind: "choice", value: opt }]));
        actions.appendChild(b);
      }
      const skipBtn = btn("Skip", false);
      skipBtn.style.marginLeft = "auto";
      skipBtn.addEventListener("click", skip);
      actions.appendChild(skipBtn);
    } else {
      const no = btn("No", false);
      no.addEventListener("click", () => finish([{ kind: "confirm", value: false }]));
      const yes = btn("Yes", true);
      yes.addEventListener("click", () => finish([{ kind: "confirm", value: true }]));
      actions.append(no, yes);
    }
    panel.appendChild(actions);
    root.appendChild(panel);
  }

  document.documentElement.appendChild(root);

  /** Minimal stable-ish CSS selector for an element (id → nth-of-type path). */
  function cssPath(el: HTMLElement): string {
    if (el.id) {
      return `#${CSS.escape(el.id)}`;
    }
    const parts: string[] = [];
    let node: HTMLElement | null = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      const current: HTMLElement = node;
      let part = current.tagName.toLowerCase();
      const parent: HTMLElement | null = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (c): c is Element => c.tagName === current.tagName
        );
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      if (current.id) {
        parts[0] = `#${CSS.escape(current.id)}`;
        break;
      }
      node = parent;
      depth++;
    }
    return parts.join(" > ");
  }
}
