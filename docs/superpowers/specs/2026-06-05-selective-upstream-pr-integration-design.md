# Selective Upstream PR Integration Design

Date: 2026-06-05

## Goal

Integrate only useful, low-risk upstream PR changes after auditing open PRs on `cita-777/metapi`.

## Scope

Include:

1. PR #575 — MySQL/TiDB-safe admin snapshot upsert.
2. PR #470 — Dashboard balance overflow truncation.

Exclude for now:

- PR #567 — `X-User-Id` New API compatibility. Research against `QuantumNous/new-api` shows official New API requires `New-Api-User`, not `X-User-Id`; current system already supports `New-Api-User` and related compatibility headers.
- PR #557 — Docker Node 26 bump. It conflicts with the project’s intentional Node 22 Docker strategy and had failing CI.
- PR #520 / #550 — useful but large/conflicting feature sets; defer for later decomposition.

## Design

### Admin snapshot upsert

`src/server/services/adminSnapshotStore.ts` currently uses Drizzle `onConflictDoUpdate`, which is appropriate for SQLite/Postgres-style conflict handling but is not safe for MySQL/TiDB. Add dialect-aware persistence:

- Keep existing behavior for SQLite/Postgres.
- Use MySQL-compatible duplicate-key update when the active dialect is MySQL/TiDB.
- Add regression coverage for MySQL upsert behavior.
- Preserve existing read/delete behavior and snapshot identity semantics.

### Dashboard balance overflow

Long balance strings can overflow dashboard stat cards. Apply a focused truncation style:

- Ensure dashboard stat values have `min-width: 0`, `overflow: hidden`, `text-overflow: ellipsis`, and `white-space: nowrap` where needed.
- Keep visual behavior unchanged for normal-length balances.
- Prefer CSS-only changes unless JSX needs a class hook.

## Verification

Run targeted tests first:

- `npm test -- --run src/server/services/adminSnapshotStore.test.ts`
- MySQL-specific admin snapshot test if available/added.
- Relevant web/UI test or build check for dashboard CSS.

Then run full verification:

- `npm test`

## Delivery

After tests pass:

1. Commit implementation.
2. Push `main` to the user's fork.
3. Build and push Docker images with `latest` and a commit-specific tag.
