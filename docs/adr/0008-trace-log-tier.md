# ADR-0008 — A `trace` log tier, unlocked by OpenCode's `DEBUG`

- **Status:** Accepted — shipped in `0.8.1` via [#56](https://github.com/vymalo/opencode-oauth2/pull/56)
  (2026-06). Applies to all four runtime plugins (`oauth2`, `models-info`, `ratelimit`,
  `browser`) and the shared logging pattern.
- **Scope:** the suite's structured-logging layer — the per-plugin `logging.ts` (`LogLevel`,
  `LOG_LEVEL_PRIORITY`, `fromOpenCodeLogLevel`) and the `createOpenCodeLogger` host bridge in
  each plugin's `opencode.ts`.

## Context

A clean, successful run of these plugins is intentionally near-silent at the default `info`
level. Lifecycle events (`plugin_initialized`, `sync_start`, `sync_success`,
`models_info_enriched`, …) are emitted at **`debug`**; only failures surface at `warn`/`error`.
So at `info` a healthy boot says nothing, and you only hear from a plugin when something
breaks. See the "Logging" section of [`../architecture.md`](../architecture.md).

When something *did* go wrong in the field, the existing `debug` tier often wasn't
fine-grained enough. `debug` carries the lifecycle skeleton — "a sync ran", "models were
enriched" — but not the per-step breadcrumb trail you actually need to diagnose a bad
outcome: every provider considered and every config-hook step (oauth2), each model
match/merge decision (models-info), every parsed `x-ratelimit-*` header and the
throttle/tier choice it drove (ratelimit), and every frame the bridge routed between agents
and executors plus the host-vs-guest election (browser). Reproducing an incident meant
adding ad-hoc logging and shipping a patched build.

We wanted a high-volume "tell me everything" tier — but under two constraints:

- **No new operator knob.** OpenCode's host log level is the natural control surface; a
  second env var or config field is one more thing to discover, document, and keep in sync.
- **Don't drown normal `debug` users.** Per-frame / per-model spam at `debug` would bury the
  lifecycle events that make `debug` useful, with no way to dial it back short of `info`.

And one hard limit: OpenCode's host log API, `client.app.log()`, accepts only
`debug | info | warn | error` — it has **no** `trace` level.

## Decision

Add a `trace` level **below** `debug` (priority `5`, vs `debug: 10`) to the shared `Logger`,
and map OpenCode's host `DEBUG` onto it — `fromOpenCodeLogLevel("DEBUG") → "trace"` (see
each plugin's `logging.ts`). Running the host at `--log-level DEBUG` therefore unlocks the
entire trace stream **on top of** the `debug` lifecycle events, with no extra env var or
config to set.

Concretely:

- **Gating is local, at `trace` priority.** Each plugin's `createOpenCodeLogger` checks the
  record's level against the level `DEBUG` mapped to before emitting, so trace records are
  dropped unless the host is at `DEBUG`.
- **The host wire is folded to `debug`.** Because `client.app.log()`'s enum has no `trace`,
  a trace record is forwarded to the host stream **labelled `debug`** — the fine-grained
  gating already happened locally, so the host only needs to receive it. The JSON-console
  fallback keeps the true `trace` label. The fold lives in `createOpenCodeLogger`:
  `const hostLevel = level === "trace" ? "debug" : level;`.
- **~85 trace events** were added across the four plugins at the highest-value internal
  steps (the breadcrumbs enumerated in Context).
- **Secret redaction applies to `trace`** exactly as to every other level — `trace` routes
  through the same `redactFields` path, so the new high-volume tier can't leak a token.

All four plugins converged on the *identical* mechanism, so the one host flag is a single
universal switch across the suite.

## Consequences

**Positive**
- **One flag, whole-suite observability.** `--log-level DEBUG` turns on deep tracing across
  oauth2, models-info, ratelimit, and browser at once — no per-plugin or per-feature toggle.
- **A clean run stays quiet.** The default `info` level is unchanged; trace only exists at
  `DEBUG`, so adding ~85 events cost the happy path nothing.
- **No new knob to discover or document.** Reusing the host's `DEBUG` keeps the operator
  surface exactly as wide as it already was.
- **One mechanism, four plugins.** The shared `logging.ts` shape means the tier behaves
  identically everywhere, and a future plugin inherits it for free.

**Negative / cost**
- **No `debug`-without-`trace` from the host.** `DEBUG` is all-or-nothing: you can't ask for
  the lifecycle `debug` events without also getting the high-volume trace stream. This is
  deliberate — "DEBUG" is the operator's universal "tell me everything" signal — but it does
  mean a `debug`-curious user gets the firehose.
- **The wire label loses fidelity.** A trace record reaches a centralized host aggregator
  labelled `debug`; the true `trace` tier is only visible on the stderr/JSON-console
  fallback. A small, documented fidelity loss — acceptable because the host enum gave us no
  other option.
- **Trace field construction is eager.** A trace event's `fields` object is built *before*
  the level check that might discard it, so on genuinely hot paths (e.g. per-frame routing
  in the browser bridge) field-building must stay cheap — don't serialize a large payload
  into a trace field that's usually dropped.

## Alternatives considered

### A dedicated env var (e.g. `VYMALO_LOG_LEVEL=trace`) — rejected

A second control to discover, document, and keep in sync with the host's level. This was a
deliberate choice between two offered options — a new env var vs. reusing `DEBUG` — and
DEBUG-reuse won: "DEBUG" already means *show me everything*, so reusing it is the
least-surprising lever and adds zero operator surface. (We already have one escape hatch in
this layer, `VYMALO_PLUGIN_CONSOLE_LOG`, for mirroring to stdout; adding a *second* env var
to also pick the level would make the logging contract harder to reason about, not easier.)

### Just add more `debug` events, no new level — rejected

Loses the semantic separation the tier exists to create. Users who want the normal `debug`
lifecycle (sync ran, models enriched) would be flooded with per-frame and per-model spam,
and there'd be no way to dial it back short of jumping all the way to `info` — which hides
the lifecycle events too. A distinct tier is precisely what lets one signal (`DEBUG`) carry
both.

### A real host-native `trace` level — rejected (not available)

`client.app.log()`'s level enum is fixed at `debug | info | warn | error`; there is no
`trace` to forward to. This constraint is the whole reason for the local-gate +
fold-to-`debug`-on-the-wire compromise — if the host ever grows a native `trace`, the fold
in `createOpenCodeLogger` is the one line to revisit.

### Scope trace to one plugin (e.g. browser only) — rejected

The incident that motivated the tier spanned **oauth2** (token/config decisions) and
**browser** (bridge frame routing) at once. A per-plugin tier would mean flipping several
switches to chase one cross-plugin failure; a per-suite tier is exactly what makes
`--log-level DEBUG` a *single* universal switch — the property this ADR is buying.
