# ADR-0005 — Atomic on-disk state: per-writer temp file + rename

- **Status:** Accepted — shipped in 0.8.1; oauth2/models-info caches via
  [#54](https://github.com/vymalo/opencode-oauth2/pull/54) and the bridge token file via
  [#57](https://github.com/vymalo/opencode-oauth2/pull/57) (2026-06).
- **Scope:** every on-disk state file the suite writes — `@vymalo/opencode-oauth2`'s
  model-sync cache (`saveServerState`), `@vymalo/opencode-models-info`'s metadata cache
  (`put`), and `@vymalo/opencode-browser`'s `bridge.json` (`writeBridgeFile`).

## Context

Multiple OpenCode instances commonly run at once on one machine: the desktop app restores
every project window in parallel at launch (each window is its own OpenCode process), an IDE
keeps a long-lived agent, CLI runs come and go. They all share the same per-user state files
under the per-OS cache/state dirs. So concurrent writers to one path are the normal case
here, not an edge case.

The original writes weren't safe under that concurrency. Two distinct mistakes, two distinct
failures observed in real logs:

1. **oauth2 model-sync cache — shared temp path.** The cache already wrote atomically
   (temp file → `rename` onto the real path), but every writer used the **same** temp name,
   `<serverId>.json.tmp`. Two instances syncing the same provider raced: writer A's `rename`
   consumed the temp file writer B had just written, so B's `rename` threw
   `sync_failed … ENOENT … rename '<serverId>.json.tmp' -> '<serverId>.json'`. The atomicity
   of `rename` doesn't help when both writers share the temp path. Cosmetic-but-noisy — the
   cache file never corrupts (the winner's write lands); the loser just logs an `ERROR` and
   falls back to its stale model list for that boot. (Symptom-keyed entry in
   [`troubleshooting.md`](../troubleshooting.md).)

2. **`bridge.json` — non-atomic write.** A plain `writeFileSync` straight onto the real path
   is briefly truncated mid-write. A concurrent reader that catches that empty/torn window
   reads nothing usable, falls through to **generate** a fresh bridge token, and overwrites
   the shared file with it — the root cause of the browser bridge "token divergence" between
   host and extension when many instances boot at once. (The divergence story itself is
   [ADR-0006](0006-bridge-token-source-of-truth.md)'s subject; here it's just the forcing case for atomicity.)

Both are the same class of bug — an unprotected window where another process sees a state
that should never be observable — reached from two different starting points (a shared temp
path; no temp file at all).

## Decision

Every state write goes **temp-then-rename with a per-writer unique temp name**. The temp
path is `${target}.${process.pid}.${randomUUID()}.tmp`, the file is written `0o600`, then
`rename`d onto the real path, and the temp file is best-effort `unlink`ed on any write/rename
failure.

- `rename` is atomic on POSIX and on NTFS for a same-directory move, so a reader always sees
  either the whole old file or the whole new one — never a torn or empty one.
- **"Last writer wins"** on the final path: concurrent writes resolve to whichever `rename`
  lands last, deterministically and without error.
- The **pid + uuid** suffix gives every writer a private temp path, so concurrent writers
  can never collide on the temp file — closing the #54 ENOENT race at its root.
- The `unlink`-on-failure cleanup means a crash or a failed `rename` never strands an orphan
  `*.tmp` next to the real file.

The same one-liner is now used verbatim in all three stores; each carries a comment
cross-referencing the others (oauth2's `saveServerState` holds the canonical rationale).

## Consequences

**Positive**

- No torn/empty reads, so no spurious `bridge.json` token regeneration.
- No `ENOENT`-on-rename, so no noisy `sync_failed` ERROR on parallel desktop boot.
- No orphan temp files left behind by a crashed or failed write.
- One identical pattern across all three on-disk stores — easy to reason about and to audit.

**Negative / cost**

- A `randomUUID()` per write (negligible).
- Last-writer-wins means a write can be silently superseded by a concurrent one. Acceptable
  here: these files are **idempotent snapshots** (the current model list, the current
  metadata, the current bridge token), not append-only logs — losing a write just means the
  surviving snapshot is used, and the next sync refreshes it anyway.

## Alternatives considered

### Plain `writeFileSync` onto the real path — rejected

The simplest thing, and exactly the `bridge.json` bug: the real path is truncated for the
duration of the write, and any reader landing in that window sees an empty/torn file. With a
fallback-to-generate reader (`resolveSharedToken`), that torn read doesn't just fail — it
manufactures and persists a *different* value, diverging shared state. Non-atomic writes to a
shared file are never acceptable here.

### Atomic rename through a shared `<name>.tmp` — rejected

The original oauth2 cache. `rename` is atomic, but if two writers share one temp path the
atomicity is on the wrong operation: writer A's `rename` removes the temp file out from under
writer B, so B's `rename` hits `ENOENT`. This is the #54 race. The fix isn't "stop using a
temp file" — it's "give each writer its own temp file", which is exactly the per-writer name.

### Advisory file locking (`flock` / `lockfile` / a `proper-lockfile` dependency) — rejected

Correct, but heavyweight for what we need. It adds a dependency, brings cross-platform
flakiness (`flock` semantics differ across OSes and network filesystems), and reintroduces
lock-cleanup-on-crash complexity (stale locks after a hard kill) — plus it *serializes*
writers, adding contention. All of that to coordinate writes that are idempotent and where
last-writer-wins is already the desired outcome. Rename-based atomicity gives us the safety
with no lock, no dependency, and no serialization.

### Single-writer / leader election for cache writes — rejected

Electing one process to own each cache write would also remove the races, but it's
over-engineered for per-user snapshot files. It would couple the cache layer to a process-
election mechanism — which only the browser bridge has, and which exists there for a wholly
different reason (hosting one shared WebSocket bridge, see [ADR-0001](0001-bridge-transport-ws-not-bun-serve-or-socketio.md)).
A per-write atomic rename needs no coordination between processes at all.
