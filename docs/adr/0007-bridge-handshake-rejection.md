# ADR-0007 — Bridge handshake rejection: explicit reject frame, slow-retry (not dormant), fingerprint logging

- **Status:** Accepted — shipped in 0.8.1 via [#55](https://github.com/vymalo/opencode-oauth2/pull/55)
  (2026-06). Its companion — the host-side token reload that makes most rejections self-heal —
  is [ADR-0006](0006-bridge-token-source-of-truth.md).
- **Scope:** `@vymalo/opencode-browser`'s broker handshake (`broker.ts`) and the companion
  extension's `BridgeClient` (`apps/browser-extension/src/background/bridge-client.ts`).

## Context

The browser bridge authenticates every connection with a shared token: the extension's
background worker dials out and sends a `hello` frame carrying the token; the broker compares it
to its own and replies `ready` on a match. The token lives in a per-user `bridge.json` that both
sides resolve independently (see [`browser.md`](../browser.md)).

When the two tokens disagree — a rotated token, a stale long-lived IDE host that resolved its
token once at boot, leading/trailing whitespace on a paste — the broker used to just
`conn.close()` **with nothing on the wire**. That created two problems:

- **The dialer couldn't tell a *rejection* from a *drop*.** A closed socket looks identical
  whether the broker refused the handshake or the network blinked. So the extension treated a
  token rejection as an ordinary disconnect and reconnected on its normal fast exponential
  backoff — re-sending the same doomed token roughly once a second. One real incident logged
  **~4000 `browser_handshake_rejected reason=bad_token` entries**, and the extension UI sat
  uselessly at "connecting" the whole time, telling the operator nothing.
- **The log gave nothing to diagnose with.** The bare `reason=bad_token` line couldn't
  distinguish a genuinely *wrong* token from a *stale* one, or a paste typo from a whitespace
  difference. There was no way to ask "are these even the same length?" without printing the
  secret.

## Decision

Three changes, landing together:

1. **Add an explicit `rejected` frame to the wire protocol.** Just before closing a refused
   handshake, the broker sends `{ type: "rejected", reason }` (`reason` is a stable machine code
   like `"bad_token"`, not a sentence). The type is defined in
   [`protocol.ts`](../../packages/opencode-browser/src/protocol.ts) (`RejectedFrame`,
   `rejectedFrame()`, decoded behind a `typeof parsed.reason === "string"` guard) and mirrored
   byte-for-byte into the extension's `shared/protocol`. The dialer can now distinguish a
   rejection from a drop and react differently.

2. **Slow-retry on rejection — not dormant.** On a `rejected` frame the extension shows a clear,
   **neutral** error ("the token may be stale/rotated, or another host is running — re-paste the
   current token, or restart the host that owns the bridge port") and switches from per-second
   backoff to a slow fixed cadence — `REJECTED_RETRY_MS` (60s) in `bridge-client.ts`. It does
   **not** stop reconnecting: a successful `ready` clears the `handshakeRejected` flag and
   restores fast backoff, and a dashboard "save" calls `reconnect()` to re-dial at once. So the
   link self-heals the moment a good host returns, with no manual step.

3. **Non-secret fingerprint logging.** `browser_handshake_rejected` now logs `expected` vs `got`
   token **fingerprints** via `tokenFingerprint()` — `len<N>.<djb2-base36-digest>`, never the
   raw token — plus `role`/`client`. A **same-length, different-value** pair reads at a glance as
   "rotated/stale token, not a paste typo"; a length difference points at whitespace or a
   truncated paste. That single line is the signal that cracked the real incident. The fingerprint
   helper guards `typeof token !== "string"` so a malformed/forged frame logged from the
   connection handler can never crash it.

## Consequences

**Positive**
- The flood is gone — at the 60s cadence the extension makes roughly **60× fewer** handshake
  attempts than the old ~1/s backoff while a rejection persists.
- The failure is **diagnosable from one log line** without leaking the shared secret: the
  `expected`/`got` fingerprints tell a human whether it's a rotation, a typo, or whitespace.
- The extension UI now says something **actionable** instead of an indefinite "connecting".
- The link **self-heals** when a good host returns — and composes with [ADR-0006](0006-bridge-token-source-of-truth.md)'s host-side
  token reload (the host re-reads `bridge.json` on a bad-token handshake and adopts a rotated
  token without a restart), so most rejections clear themselves on the next slow retry.

**Negative / cost**
- **One new frame type on the wire** (`rejected`), which must be kept in sync across the two
  protocol mirrors (`packages/opencode-browser/src/protocol.ts` and the extension's
  `shared/protocol.ts`) — the standing cost of the mirrored-protocol design.
- **Up to 60s worst-case reconnect latency** after a rejection clears (e.g. the operator fixes
  the host between retries) — the deliberate trade for not flooding. A dashboard save short-circuits
  it via `reconnect()`.
- The fingerprint is a **deliberately weak** (non-cryptographic, collision-prone djb2) hash. That's
  fine: it's a human match aid, not a security primitive — its only job is "do these two tokens
  look the same?" It must never be treated as proof of equality.

## Alternatives considered

### Silent `conn.close()` (status quo) — rejected
This is the bug. A bare close is indistinguishable from a network drop, so the dialer can only
retry it as one — producing the per-second flood and a UI stuck at "connecting" with no
explanation. Without a reason on the wire there is nothing the extension can branch on.

### Go dormant on rejection — rejected (initially shipped, then reversed)
The **first cut** of this work did go dormant: on a `rejected` frame the extension stopped
reconnecting entirely until a config change. That kills the flood, but a **live incident proved
it wrong.** The rejection was the *host's* fault — a stale token on a long-lived IDE host — and
the fix was host-side (restart the process that owned the bridge port, which then resolved the
current token). A **dormant** extension would *not* have noticed the good host returning; it would
have sat idle until someone manually hit reconnect. Slow-retry recovers automatically in that
exact case, which is why dormant was reversed to `REJECTED_RETRY_MS`. This is the part future
readers will come back for: **don't go dormant on a failure whose fix is on the other end of the
link** — keep a slow heartbeat so the link can heal itself.

### Log the raw tokens to debug mismatches — rejected
Printing the actual tokens would make a mismatch trivially diagnosable — but it leaks the shared
bridge secret into logs and any aggregator they flow to. The fingerprint gives the same practical
signal (same-length-different-value ⇒ rotation; different-length ⇒ whitespace/truncation) with no
secret on disk.

### A WebSocket close code instead of a frame — rejected
A custom close code (e.g. `4001 = bad_token`) carries no secret and needs no new frame. But close
codes are **coarse** (a small integer, no structured payload), easy to lose or rewrite across
proxies, and — decisively here — **not modeled in the DI test transport** the broker's tests
inject, so the behavior couldn't be exercised without real sockets. An explicit, typed `rejected`
frame is unit-testable through the existing transport seam and carries a stable, extensible
machine `reason` string for future refusal causes (wrong protocol, etc.).
