# Rate-limit awareness

How `@vymalo/opencode-ratelimit` runs inside OpenCode: the single hook it registers, the one interception point it relies on, how it composes with any auth scheme, and — most importantly — how its waits interact with OpenCode's own request timeouts.

For the copy-paste config reference (every option, the event table), see the package README: [`packages/opencode-ratelimit/README.md`](../packages/opencode-ratelimit/README.md). This page is for the adopter who needs to reason about the mechanism and its failure modes.

## What it does

If your OpenAI-compatible inference sits behind a gateway that advertises a quota on every response — Envoy Gateway's [global rate limit](https://gateway.envoyproxy.io/docs/tasks/traffic/global-rate-limit/) is the motivating case — this plugin makes OpenCode honor it. It reads the IETF draft-03 triple, proactively pauses requests once the window is exhausted, and backs off + retries on `429`.

Envoy emits these on **both** 200 and 429 responses, e.g.:

```
x-ratelimit-limit:     3, 3;w=60
x-ratelimit-remaining: 2
x-ratelimit-reset:     48
```

`x-ratelimit-reset` is **seconds until the bucket resets** and is the primary backoff signal. Envoy Gateway does **not** currently emit `Retry-After` ([envoyproxy/gateway#9078](https://github.com/envoyproxy/gateway/issues/9078)), so `Retry-After` is only consulted as a fallback when some other gateway provides it.

## The one interception point

OpenCode's plugin `Hooks` API has **no post-response hook** — nothing fires after an HTTP response, and nothing exposes response headers. The only place a plugin can observe a response's status and headers is a **custom `fetch`** on the provider.

OpenCode's provider loader extracts `options.fetch`, then re-wraps it with its own timeout logic and calls it for every request to that provider. So during its `config` hook this plugin sets `provider.options.fetch` to a wrapper. (Function values survive because the hook mutates the in-memory config object, not JSON — a `fetch` set in `opencode.json` could never be a function.)

The wrapper, per request:

1. **Pre-request gate** — if the last response reported `remaining: 0`, hold until `x-ratelimit-reset` elapses.
2. **Send** through the underlying fetch (or a fetch a prior plugin installed — it composes).
3. **Read** the rate-limit headers, update per-provider state, emit `ratelimit_quota`.
4. **On `429`** — wait `x-ratelimit-reset` (or the `Retry-After` fallback, or a 1s default), retry up to `maxRetries`, then return the `429` as-is.

The `Response` is returned **untouched** — we only read `status` and `headers`, never the body, so no `.clone()` is needed and the streaming body reaches OpenCode intact.

## Auth composition

The wrapper never reads or sets `Authorization`. OpenCode's per-request `chat.headers` hook (which `@vymalo/opencode-oauth2` uses to inject a fresh bearer) and the provider's own `options.headers` handle auth; our wrapper just passes `init` through. So this plugin is **auth-agnostic** and works with oauth2, a static API key, or no auth.

One ordering note: config hooks run in plugin-registration order, so list `@vymalo/opencode-oauth2` **before** `@vymalo/opencode-ratelimit` if you use both. This is a soft recommendation for tidiness — because the wrapper does not touch auth, the order does not actually affect correctness (unlike the oauth2 → models-info coupling, which does).

## The timeout interaction (the important part)

Because the wait happens **inside** our fetch, and OpenCode wraps our fetch with its own `headerTimeout` / `chunkTimeout`, a long wait competes with those timeouts. With the default `maxWaitMs: 0` (unlimited), a 55-second reset window is a 55-second wait — and if that exceeds OpenCode's header timeout, OpenCode aborts the request mid-wait.

The plugin handles this defensively rather than hanging:

- Every wait honors the incoming `init.signal`. A single shared cooldown timer serves all concurrent waiters, but each waiter races it against its **own** signal — so one request's cancellation never aborts the others.
- On an aborted wait it logs `ratelimit_wait_aborted` (warn) and re-throws the `AbortError`, which OpenCode treats as a normal cancellation.

If you genuinely want to wait out long windows, raise the provider's timeouts above your largest expected reset:

```json
"options": { "headerTimeout": 90000, "chunkTimeout": 90000 }
```

These are the same option keys OpenCode consumes, so they belong in the provider's `options` next to `baseURL`.

Two knobs trade off against this:

- **`maxWaitMs`** caps any single wait. Set it (e.g. `10000`) if you'd rather return a `429`/abort quickly than freeze the UI for the full window. `0` keeps the "always wait the full reset" behavior.
- **`maxRetries`** bounds the `429` retry loop. After it's exhausted the `429` is returned to OpenCode unchanged, so the host's own error handling takes over.

## Concurrency

Outside a cooldown, requests flow concurrently and each response's headers correct the shared per-provider state. A burst that races past `remaining: 0` before any response lands isn't gated — but Envoy answers the overflow with `429`s, which the backoff path mops up. During a known cooldown, all callers converge on one shared timer and resume together. This keeps the happy path fully parallel (streaming + title-gen + tool calls) while still respecting a hard stop.

## State

In-memory, per process, per provider — `{ remaining, limit, resetAtMs, cooldownUntilMs }`. There is **no disk cache** (a deliberate divergence from the other two plugins): a reset window is seconds, so persisting it across restarts would only ever serve stale data.

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Requests never throttle | Provider didn't opt in, or gateway emits no `x-ratelimit-*` | Add `options.meta.rateLimit`; confirm the gateway sends the draft-03 triple (check `headerPrefix`). |
| `ratelimit_wait_aborted` during long waits | Wait exceeded OpenCode's `headerTimeout` | Raise `options.headerTimeout` / `chunkTimeout`, or set a smaller `maxWaitMs`. |
| `ratelimit_giveup` then a `429` surfaces | `maxRetries` exhausted while still limited | Raise `maxRetries`, or accept the host-level `429`. |
| Quota tracked but no waits on a custom gateway | Header names differ | Set `headerPrefix` (e.g. `ratelimit`). |
