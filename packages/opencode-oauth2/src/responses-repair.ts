/**
 * Repair non-conformant OpenAI **Responses API** SSE streams.
 *
 * Some gateways (observed: Envoy AI Gateway fronting a local model server) emit
 * Responses streaming events **without** the `output_index` / `content_index`
 * fields that the canonical OpenAI Responses API always includes. The AI SDK's
 * `@ai-sdk/openai` responses parser (and, downstream, OpenCode) key each
 * message part by those indices, so when they are absent the text part is never
 * associated with its deltas and the host fails with
 * `text part <msg_id> not found` — even though the request, auth, routing, and
 * the gateway's final (non-streamed) object are all fine.
 *
 * This module injects the missing indices on the fly:
 * - `output_index` is assigned per item in the order their
 *   `response.output_item.added` events arrive (reasoning → 0, message → 1, …).
 * - `content_index` is set to `0` on the single content / text / reasoning part
 *   of each item (these gateways only ever emit one).
 *
 * Existing index fields are never overwritten, so the transform is a safe no-op
 * against a conformant gateway. Only the oauth2 plugin's `responseApi` path
 * installs it (as a wrapping `options.fetch`), and only for requests to the
 * `/responses` route with a `text/event-stream` body.
 */

const CONTENT_EVENT = /content_part|output_text|reasoning_text/;
const BLOCK_RE = /^event:\s*(\S+)\s*\ndata:\s*(\{[\s\S]*\})\s*$/;

/**
 * Stateful per-stream renderer. Tracks the `item_id → output_index` mapping
 * across blocks (the map must persist for the whole stream, so each stream gets
 * its own injector instance).
 */
function createIndexInjector(): (block: string) => string {
  const outputIndex = new Map<string, number>();
  let nextIndex = 0;

  return (block: string): string => {
    const match = block.match(BLOCK_RE);
    if (!match) {
      // Comments, `data: [DONE]`, keep-alives — pass through untouched.
      return block;
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(match[2]) as Record<string, unknown>;
    } catch {
      return block;
    }

    const type = typeof event.type === "string" ? event.type : "";
    const item = event.item as { id?: string } | undefined;
    const itemId =
      (item && typeof item.id === "string" ? item.id : undefined) ??
      (typeof event.item_id === "string" ? event.item_id : undefined);

    if (type === "response.output_item.added" && itemId && !outputIndex.has(itemId)) {
      outputIndex.set(itemId, nextIndex++);
    }

    if (itemId && outputIndex.has(itemId) && event.output_index === undefined) {
      event.output_index = outputIndex.get(itemId);
    }

    if (CONTENT_EVENT.test(type) && event.content_index === undefined) {
      event.content_index = 0;
    }

    return `event: ${match[1]}\ndata: ${JSON.stringify(event)}\n\n`;
  };
}

/**
 * Pure text form — repair a complete SSE document. Exposed for testing; the
 * runtime path uses {@link makeResponsesRepairStream}.
 */
export function repairResponsesSseText(input: string): string {
  const render = createIndexInjector();
  // Split after each `\n\n` boundary, keeping it attached to its block.
  return input
    .split(/(?<=\n\n)/)
    .map(render)
    .join("");
}

/**
 * Streaming form — a `TransformStream` that repairs SSE byte chunks, buffering
 * across chunk boundaries so a split mid-event is handled correctly.
 */
export function makeResponsesRepairStream(): TransformStream<Uint8Array, Uint8Array> {
  const render = createIndexInjector();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let out = "";
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        out += render(buffer.slice(0, boundary + 2));
        buffer = buffer.slice(boundary + 2);
      }
      if (out) {
        controller.enqueue(encoder.encode(out));
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) {
        controller.enqueue(encoder.encode(render(buffer)));
      }
    }
  });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

/**
 * Wrap a `fetch` so Responses-API SSE responses are run through the index
 * repair before the AI SDK parses them. Non-`/responses` requests and
 * non-streaming responses pass through unchanged. Composes with a `delegate`
 * (a pre-existing `options.fetch`) so stacking with other fetch-wrapping
 * plugins works regardless of order.
 */
export function createResponsesRepairFetch(delegate?: typeof fetch): typeof fetch {
  const base = delegate ?? globalThis.fetch;

  const repaired: typeof fetch = async (input, init) => {
    const response = await base(input, init);

    const contentType = response.headers.get("content-type") ?? "";
    if (
      !response.body ||
      !urlOf(input).includes("/responses") ||
      !contentType.includes("text/event-stream")
    ) {
      return response;
    }

    return new Response(response.body.pipeThrough(makeResponsesRepairStream()), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };

  return repaired;
}
