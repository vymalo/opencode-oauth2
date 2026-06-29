# ADR-0006 — Bridge token: `bridge.json` as single source of truth (host-only write, reload-on-mismatch)

- **Status:** Accepted — shipped in `@vymalo/opencode-browser@0.8.1` ([#57](https://github.com/vymalo/opencode-oauth2/pull/57), 2026-06).
- **Scope:** `@vymalo/opencode-browser` and `@vymalo/opencode-browser-mcp` — the bridge token
  lifecycle and its per-user `bridge.json` state file.

## Context

The bridge needs one shared secret that the host broker, any guest agents (a second OpenCode
session, the MCP server), and the companion browser extension all agree on. The operator
shouldn't have to wire it up, so it's resolved with a fallback chain in
[`token-file.ts`](../../packages/opencode-browser/src/token-file.ts) (`resolveSharedToken`):
**explicit operator config > shared `bridge.json` file > generate**. The file lives in the
persistent per-OS app-data dir so a generated token survives reboots — you paste it into the
extension once, not every session.

The forcing failure was **token divergence**, observed in a real multi-hour log: the extension
was sending the **correct, current** token but a long-lived host — a JetBrains-embedded
OpenCode ACP agent that had won the port bind hours earlier — kept rejecting every handshake
with `bad_token`. The extension couldn't connect to a browser it was correctly authenticated
for, and nothing short of killing the IDE fixed it. Two causes compounded:

1. **Every instance wrote `bridge.json` at load, before election, non-atomically.** A
   concurrent reader that caught the brief truncated/torn write window fell through to
   *generate* a fresh token (`resolveSharedToken`'s last branch) and then overwrote the shared
   file with it — so a guest cold-starting alongside the host could rotate the token out from
   under everyone. (The atomic-write fix — `writeBridgeFile` now writes to a per-writer
   `pid+uuid` temp file then `rename`s it onto the real path, see
   [ADR-0005](0005-atomic-file-writes-per-writer-temp.md) — stops the *torn read* that
   triggered the regenerate, but on its own doesn't stop the *unconditional write* from
   racing.)
2. **The running host resolved its token once at boot and never re-read `bridge.json`.** Once
   the file rotated underneath it, the host was orphaned: it still owned the port (nothing
   else could bind), and it kept checking handshakes against its stale in-memory token.
   Rotating the file did nothing — only killing the process recovered it. Worse, the owner is
   often an invisible IDE/desktop background process, so the operator can't even see what to
   kill without `lsof`.

## Decision

Make `bridge.json` the single source of truth for the (non-explicit) bridge token, and tighten
who writes it and when.

1. **`bridge.json` is authoritative.** For any token that wasn't pinned by the operator, the
   file's value is the truth; in-memory copies defer to it.

2. **Only the host writes it, and only on a real mismatch.** The write moved out of the
   unconditional pre-election path into the `onHost` (post-bind) callback in
   [`opencode.ts`](../../packages/opencode-browser/src/opencode.ts) (the `advertiseToken`
   closure), so it fires only for the process that actually won the bind — including a host
   reached later by failover re-election. And it writes **only when the file doesn't already
   match its own `(port, token)`**: a port change or an explicit operator token still
   propagates to the file (for guest discovery), but a second host whose file already agrees
   does nothing, and a deliberate rotation isn't clobbered. **Guests never write.**

3. **The host reloads on a mismatch.** On a `bad_token` handshake the broker
   ([`broker.ts`](../../packages/opencode-browser/src/broker.ts), `handleHello` →
   `adoptRotatedToken`) re-reads the file through an injected `reloadToken` dependency; if the
   file now holds a different non-empty value it **adopts** it and re-checks the same
   handshake before deciding to reject. So a rotation reaches a running host within the
   extension's retry window — no restart — and the event is logged
   `browser_bridge_token_reloaded`. The re-read happens **only on the mismatch path**, so it's
   off the hot path. **Exception:** when the token came from explicit operator config,
   `reloadToken` is wired to `undefined` — a pinned secret is never overridden by the file.

## Consequences

**Positive**
- The divergence class is closed at both ends. Atomic + host-only + match-gated writes stop a
  diverged token from being *created* (no guest can clobber the live host's token); reload-on-
  mismatch *heals* an already-rotated host without a process kill.
- A deliberate token rotation (edit/replace `bridge.json`) now propagates to a long-lived host
  on its next rejected handshake instead of requiring the operator to hunt down and kill the
  port owner.
- Explicit operator tokens stay authoritative — pinning `token` in plugin options sidesteps the
  whole class (the file can never override it).
- A port change keeps `bridge.json` in sync so guests still discover the right `(port, token)`.

**Negative / cost**
- The broker gains a small `reloadToken` seam in `BrokerDeps`. Kept injectable (host wires it,
  guests/tests omit it) for testability and runtime-neutrality, but it is one more dependency
  the host has to thread through.
- "The host adopts whatever the file says" widens the effective trust surface to *anyone who
  can write the `0o600` file*. That was already the trust model (the file is the shared
  secret), but it's now load-bearing: a writer of `bridge.json` can steer a running host's
  token, not just seed a new one.
- A narrow window remains where a guest that regenerated a token on a torn read still can't
  connect until it re-resolves from the (correct) file. Its blast radius shrank from "corrupts
  the shared file for everyone" to "that one guest is briefly stuck" — an acceptable trade.

## Alternatives considered

### Every instance writes the file at load (status quo) — rejected
This is the clobber path itself: a guest cold-starting beside the host can regenerate on a
torn read and overwrite the live host's token in `bridge.json`. Writing host-only, post-bind,
and only on mismatch removes the race without needing a lock file.

### Host never re-reads its token (status quo) — rejected
This is the orphaned-host failure. The host checks every handshake against a token it resolved
once at boot, so once the file rotates it rejects forever; the only remedy is
`lsof -nP -iTCP:<port> -sTCP:LISTEN` to find the owner and kill it. Bad UX, made worse because
the owner is often an invisible IDE/desktop background OpenCode that the operator didn't know
was holding the port.

### `fs.watch` the file instead of reload-on-mismatch — rejected
Event-driven reload sounds cleaner than reacting at handshake time, but `fs.watch` is
notoriously unreliable cross-platform and fires inconsistently on exactly the editor/atomic-
rename *replace* pattern this file is written with (temp file + `rename`). Reload-on-mismatch
reacts precisely when it matters — a rejected handshake — needs no watcher to keep alive across
re-election, and self-limits to the mismatch path so it's off the hot path. A watcher would be
more moving parts for a less reliable trigger.

### Require a restart on rotation / "just pin an explicit token" — partially adopted, not sufficient alone
Pinning an explicit `token` in plugin options *is* the recommended belt-and-suspenders, and it
genuinely sidesteps the entire class — an explicit token is authoritative and the file can
never override it. But the default path for most users is a generated/file token (no operator
config at all), and the suite has to behave sanely there too. "Just pin it" can't be the only
answer; reload-on-mismatch is what makes the *default* path self-healing.

### Make the running host authoritative and have it rewrite the file (host overwrites rotations) — rejected
The inverse: treat the host's in-memory token as truth and have it stamp the file back to its
own value. That would defeat the point — a deliberate operator rotation would be stomped by the
host on its next write, and you'd be back to "kill the process to change the token." We chose
**file-as-truth + host-adopts** so the file stays the lever the operator can actually pull.
