# Selective Upstream PR Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate only the necessary low-risk upstream PR fixes: MySQL admin snapshot upsert support from PR #575 and dashboard balance truncation from PR #470.

**Architecture:** Add dialect-aware admin snapshot writes without changing snapshot read/delete semantics. Apply a minimal reusable CSS truncation utility and attach it only to the dashboard balance value, avoiding upstream PR #470's broad formatting diff.

**Tech Stack:** TypeScript, Vitest, Drizzle ORM proxy drivers, React, CSS, npm scripts.

---

## File Structure

- Modify `src/server/services/adminSnapshotStore.ts`: branch write upsert behavior on `runtimeDbDialect`; use `onDuplicateKeyUpdate` only for MySQL/TiDB-compatible runtime.
- Modify `src/server/services/adminSnapshotStore.test.ts`: close DB connections in cleanup before deleting temporary SQLite data.
- Create `src/server/services/adminSnapshotStore.mysql.test.ts`: mock DB dialect as `mysql` and verify writes use duplicate-key upsert and update an existing row.
- Modify `src/web/index.css`: add `.text-truncate` utility near `.stat-value` styles.
- Modify `src/web/pages/Dashboard.tsx`: add `text-truncate` to the current-balance stat value only.

---

### Task 1: MySQL-safe admin snapshot upsert

**Files:**
- Modify: `src/server/services/adminSnapshotStore.ts`
- Modify: `src/server/services/adminSnapshotStore.test.ts`
- Create: `src/server/services/adminSnapshotStore.mysql.test.ts`

- [ ] **Step 1: Write the MySQL regression test**

Create `src/server/services/adminSnapshotStore.mysql.test.ts` with this content:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const adminSnapshots = sqliteTable("admin_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  namespace: text("namespace").notNull(),
  snapshotKey: text("snapshot_key").notNull(),
  payload: text("payload").notNull(),
  generatedAt: text("generated_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  staleUntil: text("stale_until").notNull(),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

const schema = { adminSnapshots };

type SnapshotRow = {
  id: number;
  namespace: string;
  snapshotKey: string;
  payload: string;
  generatedAt: string;
  expiresAt: string;
  staleUntil: string;
  createdAt?: string | null;
  updatedAt?: string | null;
};

const state: {
  rows: SnapshotRow[];
  onDuplicateKeyUpdateCalls: number;
} = {
  rows: [],
  onDuplicateKeyUpdateCalls: 0,
};

function resetMockState() {
  state.rows = [];
  state.onDuplicateKeyUpdateCalls = 0;
}

function makeInsertChain() {
  let values: Omit<SnapshotRow, "id"> | null = null;
  let duplicateSet: Partial<SnapshotRow> | null = null;

  const chain = {
    values(nextValues: Omit<SnapshotRow, "id">) {
      values = nextValues;
      return chain;
    },
    onDuplicateKeyUpdate(input: { set: Partial<SnapshotRow> }) {
      state.onDuplicateKeyUpdateCalls += 1;
      duplicateSet = input.set;
      return chain;
    },
    run: vi.fn(async () => {
      if (!values) throw new Error("values() must be called before run()");

      const existingIndex = state.rows.findIndex((row) =>
        row.namespace === values!.namespace
        && row.snapshotKey === values!.snapshotKey,
      );

      if (existingIndex === -1) {
        state.rows.push({
          id: state.rows.length + 1,
          ...values,
        });
        return { changes: 1 };
      }

      state.rows[existingIndex] = {
        ...state.rows[existingIndex],
        ...(duplicateSet ?? {}),
      };
      return { changes: 1 };
    }),
  };

  return chain;
}

function makeSelectChain() {
  const chain = {
    from() {
      return chain;
    },
    where() {
      return chain;
    },
    get: vi.fn(async () => {
      const row = state.rows[0];
      return row ? { ...row } : undefined;
    }),
  };

  return chain;
}

const db = {
  insert: vi.fn(() => makeInsertChain()),
  select: vi.fn(() => makeSelectChain()),
};

vi.mock("../db/index.js", () => ({
  db,
  runtimeDbDialect: "mysql",
  schema,
}));

type AdminSnapshotStoreModule = typeof import("./adminSnapshotStore.js");

describe("adminSnapshotStore mysql conflict handling", () => {
  let storeModule: AdminSnapshotStoreModule;

  beforeEach(async () => {
    resetMockState();
    vi.resetModules();
    storeModule = await import("./adminSnapshotStore.js");
  });

  it("uses mysql duplicate-key upsert when persisting snapshot rows", async () => {
    await storeModule.writeAdminSnapshot(
      { namespace: "dashboard-summary", key: "default" },
      {
        payload: { totalBalance: 12.5, totalAccounts: 3 },
        generatedAt: "2026-04-09T00:00:00.000Z",
        expiresAt: "2026-04-09T00:00:10.000Z",
        staleUntil: "2026-04-09T00:01:00.000Z",
      },
    );

    await storeModule.writeAdminSnapshot(
      { namespace: "dashboard-summary", key: "default" },
      {
        payload: { totalBalance: 18.75, totalAccounts: 4 },
        generatedAt: "2026-04-09T00:02:00.000Z",
        expiresAt: "2026-04-09T00:02:10.000Z",
        staleUntil: "2026-04-09T00:03:00.000Z",
      },
    );

    const record = await storeModule.readAdminSnapshot<{
      totalBalance: number;
      totalAccounts: number;
    }>({
      namespace: "dashboard-summary",
      key: "default",
    });

    expect(state.onDuplicateKeyUpdateCalls).toBe(2);
    expect(state.rows).toHaveLength(1);
    expect(record).toEqual({
      payload: { totalBalance: 18.75, totalAccounts: 4 },
      generatedAt: "2026-04-09T00:02:00.000Z",
      expiresAt: "2026-04-09T00:02:10.000Z",
      staleUntil: "2026-04-09T00:03:00.000Z",
    });
  });
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
npm test -- --run src/server/services/adminSnapshotStore.mysql.test.ts
```

Expected: FAIL because `writeAdminSnapshot()` still calls `onConflictDoUpdate()` instead of `onDuplicateKeyUpdate()` when the mocked runtime dialect is `mysql`.

- [ ] **Step 3: Implement dialect-aware upsert**

In `src/server/services/adminSnapshotStore.ts`, change the import:

```ts
import { db, runtimeDbDialect, schema } from "../db/index.js";
```

Then in `writeAdminSnapshot()`, after the `values` object and before the current `onConflictDoUpdate()` chain, add:

```ts
  if (runtimeDbDialect === "mysql") {
    await (db
      .insert(schema.adminSnapshots)
      .values(values) as any)
      .onDuplicateKeyUpdate({
        set: {
          payload: values.payload,
          generatedAt: values.generatedAt,
          expiresAt: values.expiresAt,
          staleUntil: values.staleUntil,
          updatedAt: values.updatedAt,
        },
      })
      .run();
    return;
  }
```

Keep the existing `onConflictDoUpdate()` block unchanged for non-MySQL dialects.

- [ ] **Step 4: Improve SQLite test cleanup**

In `src/server/services/adminSnapshotStore.test.ts`, add a variable beside `db`:

```ts
  let closeDbConnections: DbModule["closeDbConnections"];
```

In `beforeAll`, after assigning `db`, add:

```ts
    closeDbConnections = dbModule.closeDbConnections;
```

Replace `afterAll(() => { ... })` with:

```ts
  afterAll(async () => {
    await closeDbConnections();
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });
```

- [ ] **Step 5: Run targeted admin snapshot tests**

Run:

```bash
npm test -- --run src/server/services/adminSnapshotStore.test.ts src/server/services/adminSnapshotStore.mysql.test.ts
```

Expected: PASS, including the new MySQL conflict handling test.

- [ ] **Step 6: Commit backend fix**

Run:

```bash
git add src/server/services/adminSnapshotStore.ts src/server/services/adminSnapshotStore.test.ts src/server/services/adminSnapshotStore.mysql.test.ts
git commit -m "fix: support mysql admin snapshot upsert"
```

---

### Task 2: Dashboard balance overflow truncation

**Files:**
- Modify: `src/web/index.css`
- Modify: `src/web/pages/Dashboard.tsx`

- [ ] **Step 1: Add truncation utility CSS**

In `src/web/index.css`, immediately after the base `.stat-value` block, add:

```css
.text-truncate {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

- [ ] **Step 2: Apply utility to current balance**

In `src/web/pages/Dashboard.tsx`, find the current balance stat:

```tsx
              <div className="stat-value animate-count-up">
                ${totalBalance.toFixed(2)}
              </div>
```

Change it to:

```tsx
              <div className="stat-value animate-count-up text-truncate">
                ${totalBalance.toFixed(2)}
              </div>
```

- [ ] **Step 3: Verify web build still succeeds**

Run:

```bash
npm run build:web
```

Expected: PASS. Vite may emit the existing large chunk warning; that warning is acceptable if the command exits 0.

- [ ] **Step 4: Commit UI fix**

Run:

```bash
git add src/web/index.css src/web/pages/Dashboard.tsx
git commit -m "fix: truncate dashboard balance value"
```

---

### Task 3: Final verification, push, and Docker image

**Files:**
- No source file changes expected beyond Tasks 1-2.

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS with 0 failed tests.

- [ ] **Step 2: Check git state**

Run:

```bash
git status --short --branch
git log --oneline -n 5
```

Expected: on `main`, ahead of `origin/main` and containing the spec commit plus the two implementation commits. Pre-existing uncommitted docs/template changes may remain; do not include them unless explicitly requested.

- [ ] **Step 3: Push to the user's fork**

Run:

```bash
git push fork main
```

Expected: push succeeds to `https://github.com/yswlww/metapi.git`.

- [ ] **Step 4: Build Docker image**

Use the new short commit SHA from `git rev-parse --short HEAD` and package version from `package.json`. If version remains `1.3.0` and SHA is `abcdef0`, build:

```bash
docker build -f docker/Dockerfile -t kennethww/metapi:latest -t kennethww/metapi:1.3.0-pr-sync-abcdef0 .
```

Expected: image build succeeds. Existing `EBADENGINE` warning about Node 22 vs package engines may appear and is not a build failure.

- [ ] **Step 5: Push Docker tags**

Replace `abcdef0` with the actual short SHA used in Step 4:

```bash
docker push kennethww/metapi:1.3.0-pr-sync-abcdef0
docker push kennethww/metapi:latest
```

Expected: both tags push successfully and Docker reports image digests.

