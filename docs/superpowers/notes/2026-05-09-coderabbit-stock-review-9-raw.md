**Actionable comments posted: 1**

<details>
<summary>♻️ Duplicate comments (3)</summary><blockquote>

<details>
<summary>src/api/server.ts (1)</summary><blockquote>

`15-16`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Guard SSE payload serialization before building the frame.**

`JSON.stringify(data)` at Line 16 can throw (e.g., circular refs/BigInt) and abort the whole broadcast path before any `client.write`, so live updates are dropped for all connected clients.






<details>
<summary>Suggested fix</summary>

```diff
 export function broadcastSSE(event: string, data: unknown) {
-  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
+  let serialized = "null";
+  try {
+    serialized = JSON.stringify(data);
+  } catch {
+    // Keep broadcast path alive even on non-serializable payloads.
+  }
+  const payload = `event: ${event}\ndata: ${serialized}\n\n`;
   for (const client of sseClients) {
     try {
       client.write(payload);
     } catch {
       sseClients.delete(client);
     }
   }
 }
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/api/server.ts` around lines 15 - 16, In broadcastSSE,
JSON.stringify(data) can throw and abort broadcasting; wrap the serialization in
a try/catch and only build the SSE frame after successful serialization, using a
safe fallback when stringify fails (e.g., use a non-throwing serializer or
fallback to String(data) / an error-indicating payload) so the function still
writes something to connected clients instead of dropping updates; update the
code around broadcastSSE to compute serializedData inside a try/catch and then
construct payload = `event: ${event}\ndata: ${serializedData}\n\n`.
```

</details>

</blockquote></details>
<details>
<summary>src/db/schema.ts (1)</summary><blockquote>

`99-99`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Add an index for `stock_executions.position_id`.**

Line 99 introduces a new FK used for execution→position reconciliation, but there is no corresponding index. This will force table scans on a growing `stock_executions` table.





<details>
<summary>Suggested fix</summary>

```diff
 CREATE INDEX IF NOT EXISTS idx_stock_exec_status ON stock_executions(status);
 CREATE INDEX IF NOT EXISTS idx_stock_exec_ticker ON stock_executions(ticker);
+CREATE INDEX IF NOT EXISTS idx_stock_exec_position_id ON stock_executions(position_id);
 CREATE INDEX IF NOT EXISTS idx_stock_pos_status ON stock_positions(status);
 CREATE INDEX IF NOT EXISTS idx_stock_pos_ticker ON stock_positions(ticker);
```
</details>

As per coding guidelines, `src/db/**`: "Schema and queries. Flag missing indexes on hot paths, non-idempotent migrations, and SQL that could lock the DB during writes."

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/db/schema.ts` at line 99, Add a non-unique index on the new foreign-key
column stock_executions.position_id to avoid full table scans during
execution→position reconciliation: create an index (e.g.,
idx_stock_executions_position_id) for column stock_executions.position_id in the
schema/migration surrounding the schema.ts change; implement it as CREATE INDEX
CONCURRENTLY (or the equivalent in your migration framework) and make the
migration idempotent so it won’t error if the index already exists.
```

</details>

</blockquote></details>
<details>
<summary>scripts/test-migration.ts (1)</summary><blockquote>

`2-2`: _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_

**Use a fresh DB file per migration test run.**

Line 2 reuses `/tmp/stocktracker-test.db`, so reruns can pass against stale migrated state and hide first-run migration regressions.





<details>
<summary>Suggested fix</summary>

```diff
+import { rmSync } from "node:fs";
 import { openDatabase } from "../src/db/schema.js";
-const db = openDatabase("/tmp/stocktracker-test.db");
+const dbPath = "/tmp/stocktracker-test.db";
+rmSync(dbPath, { force: true });
+const db = openDatabase(dbPath);
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@scripts/test-migration.ts` at line 2, The test currently reuses a fixed DB
file by calling openDatabase with a hardcoded path, causing stale migrated state
across runs; change the call in scripts/test-migration.ts to create a fresh
per-run database (e.g., generate a unique temp filename in the system temp dir
or use an in-memory DB) and pass that to openDatabase, ensuring the test either
cleans up the temp file after completion or uses a uniquely-named file for each
run to avoid reuse.
```

</details>

</blockquote></details>

</blockquote></details>

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

Inline comments:
In `@docs/superpowers/notes/2026-05-09-coderabbit-stock-review-8-inline.md`:
- Line 1: Update the stale NDJSON filename references in the markdown note
coderabbit-stock-review-8-inline by replacing all occurrences of the old ".json"
filename with the new ".jsonl" extension (these appear in the PATH/inline
reference block and additional occurrences around lines 59-65); ensure every
literal reference and any suggested-patch snippets now point to the renamed
NDJSON file using ".jsonl" so follow-up fixes and verification prompts route
correctly.

---

Duplicate comments:
In `@scripts/test-migration.ts`:
- Line 2: The test currently reuses a fixed DB file by calling openDatabase with
a hardcoded path, causing stale migrated state across runs; change the call in
scripts/test-migration.ts to create a fresh per-run database (e.g., generate a
unique temp filename in the system temp dir or use an in-memory DB) and pass
that to openDatabase, ensuring the test either cleans up the temp file after
completion or uses a uniquely-named file for each run to avoid reuse.

In `@src/api/server.ts`:
- Around line 15-16: In broadcastSSE, JSON.stringify(data) can throw and abort
broadcasting; wrap the serialization in a try/catch and only build the SSE frame
after successful serialization, using a safe fallback when stringify fails
(e.g., use a non-throwing serializer or fallback to String(data) / an
error-indicating payload) so the function still writes something to connected
clients instead of dropping updates; update the code around broadcastSSE to
compute serializedData inside a try/catch and then construct payload = `event:
${event}\ndata: ${serializedData}\n\n`.

In `@src/db/schema.ts`:
- Line 99: Add a non-unique index on the new foreign-key column
stock_executions.position_id to avoid full table scans during execution→position
reconciliation: create an index (e.g., idx_stock_executions_position_id) for
column stock_executions.position_id in the schema/migration surrounding the
schema.ts change; implement it as CREATE INDEX CONCURRENTLY (or the equivalent
in your migration framework) and make the migration idempotent so it won’t error
if the index already exists.
```

</details>

<details>
<summary>🪄 Autofix (Beta)</summary>

Fix all unresolved CodeRabbit comments on this PR:

- [ ] <!-- {"checkboxId": "4b0d0e0a-96d7-4f10-b296-3a18ea78f0b9"} --> Push a commit to this branch (recommended)
- [ ] <!-- {"checkboxId": "ff5b1114-7d8c-49e6-8ac1-43f82af23a33"} --> Create a new PR with the fixes

</details>

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: Path: .coderabbit.yaml

**Review profile**: ASSERTIVE

**Plan**: Pro Plus

**Run ID**: `4d8d1922-65f3-4762-b4d0-4b9cb22e2f71`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 80f071a6ddb588d38925e3e9bdc7231a64c13a05 and b0aab31e0327426804e6c30facfc2ddf320c1177.

</details>

<details>
<summary>⛔ Files ignored due to path filters (3)</summary>

* `data/launchd-stderr.log` is excluded by `!**/*.log`, `!**/*.log`, `!data/**`
* `data/launchd-stdout.log` is excluded by `!**/*.log`, `!**/*.log`, `!data/**`
* `data/stock-tracker.sqlite` is excluded by `!data/**`

</details>

<details>
<summary>📒 Files selected for processing (41)</summary>

* `.coderabbit.yaml`
* `.env.example`
* `.gitignore`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-2-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-3-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-4-inline.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-4-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-5-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-6-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-7-inline.jsonl`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-7-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-8-inline.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-8-raw.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-2.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-3.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-4.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-5.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-6.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-7.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-8.md`
* `package.json`
* `scripts/backtest.ts`
* `scripts/test-migration.ts`
* `src/api/server.ts`
* `src/config.ts`
* `src/db/queries.ts`
* `src/db/schema.ts`
* `src/execution/order-manager.ts`
* `src/execution/position-monitor.ts`
* `src/execution/rebalancer.ts`
* `src/execution/risk-engine.ts`
* `src/index.ts`
* `src/ingestion/capitol-trades.ts`
* `src/ingestion/senate-efd.ts`
* `src/ingestion/unusual-whales.ts`
* `src/parsing/form4-parser.ts`
* `src/parsing/ptr-parser.ts`
* `src/ranking/backtester.ts`
* `src/tracking/portfolio-diff.ts`
* `src/types.ts`
* `tests/parsing/form4-parser.test.ts`

</details>

<details>
<summary>💤 Files with no reviewable changes (12)</summary>

* src/ingestion/unusual-whales.ts
* .env.example
* src/ingestion/capitol-trades.ts
* src/parsing/form4-parser.ts
* scripts/backtest.ts
* tests/parsing/form4-parser.test.ts
* src/parsing/ptr-parser.ts
* src/ingestion/senate-efd.ts
* src/ranking/backtester.ts
* package.json
* src/config.ts
* src/tracking/portfolio-diff.ts

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
