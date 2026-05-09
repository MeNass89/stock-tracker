# CodeRabbit review #10 — execution plan

**PR:** MeNass89/stock-tracker#1 — review submitted 2026-05-09T21:15:16Z against `cbbd565`.
**Findings:** 3 inline NEW (treat as 🟠 Major — correctness in position lifecycle / rebalance state machine) + 2 Duplicates (skipped per stop conditions: 1 Minor test-migration, 1 Major schema.completed_at-legacy-default).
**Stop conditions:** 0 Critical + 0 Major NEW. Duplicates ignored. Honor preserved decisions from reviews #1–#9.

## Preserved decisions (do not regress)

- Atomic `markRebalanceRun` claim (INSERT pattern), `completeRebalanceRun`, **`markRebalanceRunFailed` writes durable failed state via UPDATE** (iter 7 — must NOT DELETE).
- SSE broadcast helper with try/catch JSON.stringify fallback "null" (iter 9), named heartbeat event, sseClients delete on write failure.
- `pendingExitQty` reservation discipline. `applyPartialFill` decrements `pending_exit_qty` for **discretionary exits only** (this iter formalizes that contract).
- `addPendingExit` clamps at zero via `MAX(0, COALESCE(pending_exit_qty, 0) + ?)` (iter 8).
- `markExecutionReconcileFailed` releases via `MAX(0, COALESCE(...) - ?)` clamp (iter 7) — this iter narrows the release amount to the still-reserved slice.
- `softStopTriggered` gates: `!stopLossOrderId && !trailingStopOrderId && !pendingExitQty`.
- `stopLossFilled` rejected/expired clears stale ids via direct prepared statement + mirrors mutation onto `position`.
- `activateTrailingStop` returns on cancelOrder failure; clears `stop_loss_order_id` in single prepared UPDATE.
- Senator/13f branches: bail out of discretionary actions when `stopLossOrderId || trailingStopOrderId` is present.
- `stopLossFilled` filled branch: route through `applyPartialFill` when `filledQty < position.quantity` — but this iter passes `releaseReservation=false` because stops never reserved.
- `monitorOrders` EOD: cancelOrder request marks notes only, defers reconciliation.
- `handleFlashCrash` persists DB only after Alpaca confirms.
- `trackWashSaleIfNeeded` cooldown anchored to fill date in UTC.
- `updateHealth` try/catch per source + canonical kebab-case source IDs (iter 8).
- `checkSenatorTimeStops` day-60 branch bounded to `60 ≤ ageDays < 90` (iter 8).
- `idx_stock_exec_position_id` exists in schemaSql + idempotentMigrations (iter 9).

## Task 1 (🟠 Major) — `applyPartialFill` opt-out for stop-origin fills

**Problem.** `applyPartialFill(db, positionId, filledQuantity, slicePnlUsd)` unconditionally decrements `pending_exit_qty` by `filledQuantity` (with `MAX(0,…)` clamp, iter 8). But stop-loss / trailing-stop fills never reserved via `addPendingExit` — those orders are submitted directly to Alpaca without a reservation step. When `stopLossFilled`'s filled branch routes a partial-fill stop through `applyPartialFill` (added iter 6 Task 3), it effectively releases reservations belonging to *unrelated discretionary exits* on the same position. With the iter 8 clamp this can't go negative, but it still erodes legitimate pending counts for in-flight `submitMarketExit` / sellHalf operations.

**Fix.** Add an explicit `releaseReservation` boolean parameter (default `true` to keep all existing call sites correct), and branch the SQL so the `pending_exit_qty` line is only updated when `releaseReservation` is true. Pass `false` from the only stop-origin call site (`stopLossFilled`'s partial branch).

`src/db/queries.ts` — modify `applyPartialFill`:

```diff
 export function applyPartialFill(
   db: Database.Database,
   positionId: number,
   filledQuantity: number,
-  slicePnlUsd?: number | null
+  slicePnlUsd?: number | null,
+  releaseReservation: boolean = true
 ) {
-  db.prepare(
-    `UPDATE stock_positions
-     SET quantity = MAX(0, quantity - ?),
-         pending_exit_qty = MAX(0, COALESCE(pending_exit_qty, 0) - ?),
-         realized_pnl_usd = COALESCE(realized_pnl_usd, 0) + COALESCE(?, 0),
-         realized_qty = COALESCE(realized_qty, 0) + ?,
+  const pendingClause = releaseReservation
+    ? "pending_exit_qty = MAX(0, COALESCE(pending_exit_qty, 0) - ?),"
+    : "";
+  db.prepare(
+    `UPDATE stock_positions
+     SET quantity = MAX(0, quantity - ?),
+         ${pendingClause}
+         realized_pnl_usd = COALESCE(realized_pnl_usd, 0) + COALESCE(?, 0),
+         realized_qty = COALESCE(realized_qty, 0) + ?,
          status = CASE WHEN MAX(0, quantity - ?) <= 0 THEN 'closed' ELSE 'partial' END,
          closed_at = CASE WHEN MAX(0, quantity - ?) <= 0 THEN CURRENT_TIMESTAMP ELSE closed_at END,
          pnl_usd = CASE
            WHEN MAX(0, quantity - ?) <= 0
              THEN COALESCE(realized_pnl_usd, 0) + COALESCE(?, 0)
            ELSE pnl_usd
          END,
          pnl_ratio = CASE
            WHEN MAX(0, quantity - ?) <= 0
              AND avg_entry_price > 0
              AND (COALESCE(realized_qty, 0) + ?) > 0
              THEN (COALESCE(realized_pnl_usd, 0) + COALESCE(?, 0))
                   / (avg_entry_price * (COALESCE(realized_qty, 0) + ?))
            ELSE pnl_ratio
          END
      WHERE id = ?`
-   ).run(
-     filledQuantity,
-     filledQuantity,
+   );
+   const params: unknown[] = [filledQuantity];
+   if (releaseReservation) params.push(filledQuantity);
+   params.push(
      slicePnlUsd ?? null,
      filledQuantity,
      filledQuantity,
      filledQuantity,
      filledQuantity,
      slicePnlUsd ?? null,
      filledQuantity,
      filledQuantity,
      slicePnlUsd ?? null,
      filledQuantity,
      positionId
    );
+  // Re-prepare with the conditional clause string each call (template literal already evaluated above).
+  // Better: keep two prepared statements cached. Implement with a stmt cache (see below).
 }
```

**Cleaner implementation — cache two prepared statements at module scope.** The dynamic SQL string approach above re-prepares the statement on every call, which is wasteful. Better: keep two prepared statements at module scope (or inside a closure), one with the `pending_exit_qty` clause and one without, and select between them at call time.

Codex's freedom: implement with whichever variant is most idiomatic for this codebase (stmt caching via `db.prepare(…)` per call is fine since better-sqlite3 caches prepared statements internally by SQL text, so re-`prepare(sameSql)` is effectively free). Goal: same SQL text per branch, no string concat per call. Verify `better-sqlite3` prepared statement caching by reading [its docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#prepare) if uncertain — last reference: it does cache.

**Param array shape change.** When `releaseReservation === false`, the `pending_exit_qty = MAX(0, COALESCE(pending_exit_qty, 0) - ?),` line is gone, so the second `?` in the original (also `filledQuantity`) is no longer bound. The `params` array drops one entry. **Verify the param positions count matches `?` count in the SQL** before claiming the change works.

`src/execution/position-monitor.ts:149` — pass `false` from the stop-origin call site:

```diff
       if (filledQty < position.quantity) {
-        applyPartialFill(this.db, position.id, filledQty, pnlUsd);
+        applyPartialFill(this.db, position.id, filledQty, pnlUsd, false);
       } else {
         closeStockPosition(this.db, position.id, exitReason, pnlUsd, filledQty);
       }
```

**Audit other call sites.** Run `grep -rn "applyPartialFill(" src/` and confirm every other call site is for *discretionary* exits (where `addPendingExit` was called first). If any other stop-origin caller exists, pass `false` there too. If unsure, leave default (`true`) — that matches today's behavior.

## Task 2 (🟠 Major) — `markExecutionReconcileFailed` release only the still-reserved slice

**Problem.** `markExecutionReconcileFailed` subtracts the entire `execution.quantity` from `pending_exit_qty`. If `applyPartialFill` already consumed part of that reservation before reconcile failure (broker partial-fill, then later cancel/expire), this over-releases — eating into reservations belonging to *other* in-flight executions on the same position. The iter 8 `MAX(0,…)` clamp prevents underflow but doesn't prevent the over-release from corrupting other concurrent reservations on the same row.

**Fix.** Compute the actual still-reserved slice for this execution by reading `executions.filled_qty` (or equivalent) from the broker and only releasing the unfilled remainder. If the schema doesn't track per-execution filled qty, the safe approximation is `min(execution.quantity, current_pending_exit_qty)` so we never release more than what's currently reserved.

```diff
 export function markExecutionReconcileFailed(db: Database.Database, executionId: number, reason: string) {
   const tx = db.transaction(() => {
-    const execution = db.prepare(
-      "SELECT direction, position_id, quantity FROM stock_executions WHERE id = ?"
-    ).get(executionId) as { direction: string; position_id: number | null; quantity: number } | undefined;
+    const execution = db.prepare(
+      "SELECT direction, position_id, quantity FROM stock_executions WHERE id = ?"
+    ).get(executionId) as { direction: string; position_id: number | null; quantity: number } | undefined;
 
     db.prepare(
       `UPDATE stock_executions
        SET status = 'failed',
            notes = COALESCE(notes, '') || ' | RECONCILE_FAILED: ' || ?
        WHERE id = ?`
     ).run(reason, executionId);
 
     if (execution?.direction === "sell" && execution.position_id) {
+      const row = db.prepare(
+        "SELECT COALESCE(pending_exit_qty, 0) AS pending FROM stock_positions WHERE id = ?"
+      ).get(execution.position_id) as { pending: number } | undefined;
+      const currentPending = row?.pending ?? 0;
+      const releaseAmount = Math.min(execution.quantity, currentPending);
       db.prepare(
         `UPDATE stock_positions
          SET pending_exit_qty = MAX(0, COALESCE(pending_exit_qty, 0) - ?)
          WHERE id = ?`
-      ).run(execution.quantity, execution.position_id);
+      ).run(releaseAmount, execution.position_id);
     }
   });
   tx();
 }
```

**Why this is correct.** The transaction wraps the SELECT and UPDATE so no other writer can change `pending_exit_qty` between them. `Math.min(execution.quantity, currentPending)` ensures we never release more than what's currently reserved across all executions — strictly safer than blindly subtracting the original quantity. The `MAX(0,…)` clamp remains as belt-and-suspenders.

## Task 3 (🟠 Major) — `markRebalanceRun` reclaim a failed run via UPSERT (preserve durable failed state)

**Problem.** `markRebalanceRun` uses `INSERT OR IGNORE`. After iter 7 made `markRebalanceRunFailed` UPDATE `status='failed'` instead of DELETE, the row stays in the table — and `INSERT OR IGNORE` cannot reclaim it on retry. Every subsequent rebalance attempt for that `(fund_cik, report_date)` silently noops. CodeRabbit suggests reverting `markRebalanceRunFailed` to DELETE, but that loses the durable failed-state audit trail (iter 7 PRESERVED DECISION).

**Fix — keep iter 7 contract, allow re-claim via UPSERT.** Change `markRebalanceRun` to `INSERT … ON CONFLICT(fund_cik, report_date) DO UPDATE SET status='in_progress', last_error=NULL, completed_at=NULL WHERE rebalance_runs.status='failed'` so a row in `failed` state can be re-claimed for a fresh attempt. Rows in `in_progress` (still running elsewhere) or `completed` (success — don't redo) reject the claim, returning `changes=0` from the surrounding `result.changes > 0` check. The audit trail of past failures is preserved by `last_error` + `status` history if you want to keep prior errors on a separate audit table — but the simplest semantics: reclaim resets `last_error` to NULL, which is fine because the new attempt will write its own `last_error` if it also fails.

```diff
 export function markRebalanceRun(db: Database.Database, fundCik: string, reportDate: string): boolean {
-  const result = db
-    .prepare(
-      "INSERT OR IGNORE INTO rebalance_runs (fund_cik, report_date, status, completed_at) VALUES (?, ?, 'in_progress', NULL)"
-    )
-    .run(fundCik, reportDate);
+  const result = db
+    .prepare(
+      `INSERT INTO rebalance_runs (fund_cik, report_date, status, completed_at, last_error)
+       VALUES (?, ?, 'in_progress', NULL, NULL)
+       ON CONFLICT(fund_cik, report_date) DO UPDATE
+         SET status = 'in_progress',
+             completed_at = NULL,
+             last_error = NULL
+         WHERE rebalance_runs.status = 'failed'`
+    )
+    .run(fundCik, reportDate);
   return result.changes > 0;
 }
```

**Verify SQLite UPSERT support.** `ON CONFLICT … DO UPDATE` requires SQLite ≥ 3.24.0 (June 2018). better-sqlite3 ships modern SQLite. Verify by running `node -e "console.log(require('better-sqlite3').VERSION)"` and checking SQLite version if uncertain. If for any reason UPSERT is unavailable, fall back to: `DELETE FROM rebalance_runs WHERE fund_cik=? AND report_date=? AND status='failed'` then `INSERT OR IGNORE`. Two SQL roundtrips but same effect — atomic if wrapped in a `db.transaction(…)`.

**Why not change `markRebalanceRunFailed` to DELETE.** Iter 7 made it durable specifically so operators can post-mortem failed rebalances by querying `SELECT * FROM rebalance_runs WHERE status='failed'`. DELETE-on-fail loses that. UPSERT on re-claim keeps both: durable state for as long as nobody retries, and ergonomic re-claim when an operator (or scheduler) does retry.

## Skipped findings

- 🟡 **Minor (Duplicate)** — `scripts/test-migration.ts:2` reuses `/tmp/stocktracker-test.db`. Test-script-only hygiene; defer per stop conditions.
- 🟠 **Major (Duplicate)** — `src/db/schema.ts:201-220` legacy `rebalance_runs.completed_at DEFAULT (datetime('now'))` not normalized on upgrade. Per stop conditions duplicates are ignored. Real concern but: (a) iter 7 already migrated to add `status NOT NULL DEFAULT 'in_progress'` + `last_error TEXT`; (b) `completeRebalanceRun` writes `completed_at = datetime('now')` only when `status='completed'`, so the legacy DEFAULT only fires when the row is INSERTed without `completed_at` — but our `markRebalanceRun` INSERT explicitly writes `completed_at = NULL` (and now does so via UPSERT in Task 3), neutralizing the legacy DEFAULT path on writes from this codebase. The remaining risk window is rows inserted by *other* tools/scripts on the legacy schema. Defer to a future iter for the heavy-lift table-rebuild migration.

## Verification

1. `npm test` — must remain 2/2 green.
2. `npm run build` — typecheck + emit, must pass.
3. **DO NOT commit, push, or restart services.** Report which files changed and final test count.

## Stop conditions

- Any test failure unexplained by these tasks → stop and report.
- Honor preserved decisions across all prior reviews — especially: `markRebalanceRunFailed` stays as UPDATE-to-failed; do **not** revert to DELETE.
- Files touched: `src/db/queries.ts`, `src/execution/position-monitor.ts`.
