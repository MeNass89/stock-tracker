**Actionable comments posted: 3**

<details>
<summary>♻️ Duplicate comments (2)</summary><blockquote>

<details>
<summary>scripts/test-migration.ts (1)</summary><blockquote>

`2-2`: _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_

**Use a fresh temporary DB path per run to keep migration checks trustworthy.**

Reusing `/tmp/stocktracker-test.db` allows prior schema state to leak across runs, so a broken migration can appear healthy.

  

<details>
<summary>Suggested fix</summary>

```diff
+import { mkdtempSync, rmSync } from "node:fs";
+import { join } from "node:path";
+import { tmpdir } from "node:os";
 import { openDatabase } from "../src/db/schema.js";
-const db = openDatabase("/tmp/stocktracker-test.db");
+const dir = mkdtempSync(join(tmpdir(), "stocktracker-migration-"));
+const dbPath = join(dir, "test.db");
+const db = openDatabase(dbPath);
@@
 db.close();
+rmSync(dir, { recursive: true, force: true });
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@scripts/test-migration.ts` at line 2, The test currently reuses a fixed DB
path ("/tmp/stocktracker-test.db") when calling openDatabase which allows prior
schema state to leak; replace that static path with a fresh temporary file path
per run (e.g., generate a unique filename using os.tmpdir()/fs.mkdtemp or a UUID
and join it to form the DB path) and pass that into openDatabase, and ensure the
test cleans up the temp DB after the run so migrations start from a clean slate;
locate the usage in scripts/test-migration.ts where openDatabase is called and
swap the hard-coded string for the generated temp path and add teardown cleanup
logic.
```

</details>

</blockquote></details>
<details>
<summary>src/db/schema.ts (1)</summary><blockquote>

`201-220`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**Legacy `rebalance_runs.completed_at` default is not normalized during upgrade.**

Existing databases that previously had `completed_at DEFAULT (datetime('now'))` can still auto-mark newly claimed runs as completed after migration, because the idempotent migration set doesn’t rewrite that legacy table shape. This can corrupt rebalance lifecycle state on upgraded installs.

  

As per coding guidelines, `src/db/**`: "Schema and queries. Flag missing indexes on hot paths, non-idempotent migrations, and SQL that could lock the DB during writes."

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/db/schema.ts` around lines 201 - 220, The migration list in
idempotentMigrations leaves a legacy DEFAULT on rebalance_runs.completed_at
(e.g. DEFAULT (datetime('now'))), which can auto-complete runs after upgrade;
update the migration logic that creates/patches the rebalance_runs table to
ensure completed_at has no default and existing rows are normalized: detect if
rebalance_runs exists with a DEFAULT on completed_at, copy rows to a temp table
(or ALTER/RECREATE table) with completed_at NULLABLE and no DEFAULT, migrate
data back while clearing any default-generated timestamps for in-progress runs,
and replace the idempotentMigrations entry for rebalance_runs
creation/alteration in src/db/schema.ts so the final schema defines completed_at
without a DEFAULT (refer to the rebalance_runs CREATE TABLE string and the
idempotentMigrations array).
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
In `@src/db/queries.ts`:
- Around line 532-550: markExecutionReconcileFailed currently subtracts the
original stock_executions.quantity from stock_positions.pending_exit_qty which
can release reservations already consumed by partial fills; instead, inside
markExecutionReconcileFailed (and keeping applyPartialFill behavior untouched)
first SELECT the current pending_exit_qty for the position_id, compute
releaseAmount = Math.min(execution.quantity, COALESCE(pending_exit_qty,0)) in
JS, and then UPDATE stock_positions by subtracting releaseAmount (e.g. SET
pending_exit_qty = MAX(0, COALESCE(pending_exit_qty,0) - ?)) so you only release
the unfilled reservation for that execution.
- Around line 561-578: markRebalanceRun currently uses INSERT OR IGNORE so a
failed run left as a row by markRebalanceRunFailed prevents future claims;
change markRebalanceRunFailed (the function named markRebalanceRunFailed) to
remove the row for that fund_cik/report_date (DELETE FROM rebalance_runs WHERE
fund_cik = ? AND report_date = ?) instead of doing the UPDATE, so subsequent
calls to markRebalanceRun can successfully insert and reclaim the rebalance;
ensure you pass fundCik and reportDate to the DELETE statement and keep any
error logging elsewhere if needed.

In `@src/execution/position-monitor.ts`:
- Around line 149-156: applyPartialFill is decrementing pending_exit_qty for
fills that originate from stop orders (submitted via
submitStopLoss/activateTrailingStop) even though those stops never call
addPendingExit; detect stop-origin fills by checking position.stopLossOrderId or
position.trailingStopOrderId (or add an explicit flag on the call) and avoid
mutating pending_exit_qty for those cases — either add a boolean parameter to
applyPartialFill (e.g., skipPendingDecrement) and branch inside applyPartialFill
to only adjust pending_exit_qty when false, or create a separate helper (e.g.,
applyStopFill) that records qty/P&L without touching pending_exit_qty; keep the
rest of the code path (trackWashSaleIfNeeded, alert, closeStockPosition)
unchanged.

---

Duplicate comments:
In `@scripts/test-migration.ts`:
- Line 2: The test currently reuses a fixed DB path
("/tmp/stocktracker-test.db") when calling openDatabase which allows prior
schema state to leak; replace that static path with a fresh temporary file path
per run (e.g., generate a unique filename using os.tmpdir()/fs.mkdtemp or a UUID
and join it to form the DB path) and pass that into openDatabase, and ensure the
test cleans up the temp DB after the run so migrations start from a clean slate;
locate the usage in scripts/test-migration.ts where openDatabase is called and
swap the hard-coded string for the generated temp path and add teardown cleanup
logic.

In `@src/db/schema.ts`:
- Around line 201-220: The migration list in idempotentMigrations leaves a
legacy DEFAULT on rebalance_runs.completed_at (e.g. DEFAULT (datetime('now'))),
which can auto-complete runs after upgrade; update the migration logic that
creates/patches the rebalance_runs table to ensure completed_at has no default
and existing rows are normalized: detect if rebalance_runs exists with a DEFAULT
on completed_at, copy rows to a temp table (or ALTER/RECREATE table) with
completed_at NULLABLE and no DEFAULT, migrate data back while clearing any
default-generated timestamps for in-progress runs, and replace the
idempotentMigrations entry for rebalance_runs creation/alteration in
src/db/schema.ts so the final schema defines completed_at without a DEFAULT
(refer to the rebalance_runs CREATE TABLE string and the idempotentMigrations
array).
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

**Run ID**: `7913d8c5-51b7-4263-96f9-87bbf57745ad`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 80f071a6ddb588d38925e3e9bdc7231a64c13a05 and cbbd5658d23d7245931230e96972d628585ad950.

</details>

<details>
<summary>⛔ Files ignored due to path filters (3)</summary>

* `data/launchd-stderr.log` is excluded by `!**/*.log`, `!**/*.log`, `!data/**`
* `data/launchd-stdout.log` is excluded by `!**/*.log`, `!**/*.log`, `!data/**`
* `data/stock-tracker.sqlite` is excluded by `!data/**`

</details>

<details>
<summary>📒 Files selected for processing (43)</summary>

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
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-9-raw.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-2.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-3.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-4.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-5.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-6.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-7.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-8.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-9.md`
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

* .env.example
* src/ingestion/unusual-whales.ts
* tests/parsing/form4-parser.test.ts
* scripts/backtest.ts
* src/ingestion/capitol-trades.ts
* src/tracking/portfolio-diff.ts
* src/ranking/backtester.ts
* src/parsing/form4-parser.ts
* package.json
* src/config.ts
* src/parsing/ptr-parser.ts
* src/ingestion/senate-efd.ts

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
