# CodeRabbit Stock-Tracker Review #4 — Cleanup Plan

**Source:** PR #1, review submitted 2026-05-09T19:30:55Z, run ID 3c8efad6-7cbe-4c29-bc2c-a243a4b8c887.
**Base commit reviewed:** 7aefeaa.
**Triage rule:** apply Critical + Major NEW. Skip Duplicates, Trivial, Nitpick, Minor utility-only.

## Triage summary

| # | Severity | File:line | Decision | Reason |
|---|----------|-----------|----------|--------|
| 1 | 🔴 Critical | order-manager.ts:180 | APPLY | Cancel/expired branch must reconcile late fills before releasing reservation, else qty/pending/PnL drift |
| 2 | 🟠 Major | rebalancer.ts:67-79 | APPLY | Cross-fund full exits then re-queued in generic sell pass; submitMarketExit throws on pendingExitQty mid-run |
| 3 | 🟠 Major | position-monitor.ts:68 | APPLY | Hard-loss branch + softStopTriggered call exit() unconditionally; submitMarketExit guard now throws on queued half |
| 4 | 🟠 Major | schema.ts:173 + queries.ts | APPLY | `completed_at` defaulted on insert; failed run indistinguishable from success → split claim from completion |
| 5 | 🟠 Major | queries.ts:494-500 | APPLY | `markExecutionReconcileFailed` doesn't release sell reservation; pending_exit_qty stays inflated, blocks future exits |
| 6 | 🟠 Major | queries.ts:427-459 | APPLY | `closeStockPosition` doesn't reduce stored quantity; corrupts historical state and reporting |
| 7 | 🟠 Major | queries.ts:386-397 | APPLY | `coalesce(?, pnl_ratio)` blocks null clear; stale ratio survives invalid-ratio guard |
| — | 🟠 Major (Duplicate) | order-manager.ts:163-170 | SKIP | CodeRabbit flagged ♻️ Duplicate (same finding as prior review's slice-PnL discussion). Per stop rule. |
| — | 🔵 Trivial Nitpick | schema.ts:224 RENAME regex | SKIP | Already triaged Trivial in iter 3; CodeRabbit itself notes "fragile but acceptable". |

**NEW count:** 1 Critical + 6 Major = 7 to apply.

## Task 1 (Critical) — `order-manager.ts` reconcile late fills on cancelled/expired

**Problem.** When Alpaca returns terminal `cancelled`/`expired` with extra `filled_qty` after the prior poll, the cancel branch (current line 173-180) only releases the unfilled reservation. The delta between `previouslyFilledQty` and final `order.filled_qty` is never booked → quantity, pending_exit_qty, realized P&L drift.

**Fix.** Restructure `monitorOrders()` so the sell-reconciliation block also runs for `cancelled`/`expired`, then the existing cancel-by-end-of-day path becomes a residual-cleanup branch.

Replace the current sell branch (line 146) condition `(status === "filled" || status === "partial") && execution.direction === "sell"` with `execution.direction === "sell" && (status === "filled" || status === "partial" || status === "cancelled" || status === "expired")`. Inside, after booking `deltaQty`, add a residual cleanup if `status === "cancelled" || status === "expired"`:

```typescript
if (status === "cancelled" || status === "expired") {
  const unfilled = Math.max(0, execution.quantity - totalFilledQty);
  if (unfilled > 0) addPendingExit(this.db, execution.positionId, -unfilled);
  updateStockExecutionOrder(this.db, execution.id, {
    status: status,
    notes: status === "cancelled" ? "alpaca cancelled" : "alpaca expired"
  });
  continue;
}
```

Then keep the existing `else if (this.shouldCancelByEndOfDay(...))` branch as the *initiator* path (we send `cancelOrder`, then a future poll will hit the cancelled-status branch above to finalize). To avoid double-releasing on the cutoff path, change the cutoff branch to NOT release `addPendingExit` immediately — only call `cancelOrder` and update status to mark cancellation in flight (e.g. `notes: "cancelled at 15:45 ET cutoff (awaiting reconciliation)"`); the next monitor pass observes terminal status and runs the consolidated reconciliation. (If preserving the immediate release is preferred to avoid an extra poll, leave the cutoff branch as-is but make the new cancelled-status branch idempotent by tracking a flag in notes — pick the simpler restructure: defer release to terminal-status branch.)

**Concretely**, the structure becomes:

```typescript
if (status === "filled" && execution.direction === "buy") { /* unchanged */ }
else if (execution.direction === "sell" && (status === "filled" || status === "partial" || status === "cancelled" || status === "expired")) {
  // existing missing-positionId / position-not-found guards (unchanged)
  // existing deltaQty computation + closeStockPosition / applyPartialFill (unchanged)
  // NEW: residual cleanup for terminal cancelled/expired
  if (status === "cancelled" || status === "expired") {
    const unfilled = Math.max(0, execution.quantity - totalFilledQty);
    if (unfilled > 0) addPendingExit(this.db, execution.positionId!, -unfilled);
    updateStockExecutionOrder(this.db, execution.id, { status, notes: `alpaca ${status}` });
    continue;
  }
}
else if (this.shouldCancelByEndOfDay(execution.createdAt)) {
  await this.alpaca.cancelOrder(execution.alpacaOrderId);
  updateStockExecutionOrder(this.db, execution.id, { status: "cancelled", notes: "cancelled at 15:45 ET cutoff" });
  // deferred: actual reservation release happens when next poll observes terminal status
}
else if (this.shouldResubmit(execution.createdAt)) { /* unchanged */ }
```

**Tradeoff.** Deferring the cutoff release means one extra monitor cycle before pending_exit_qty is freed — acceptable since `pendingStockExecutions` keeps polling `submitted`/`partial` rows, and the cutoff path now writes status `cancelled` so the next pass picks it up via the new branch (NB: `pendingStockExecutions` filter must still include `cancelled` rows that have outstanding reservations — check if it does; if it filters them out, the simpler path is to *keep* the immediate `addPendingExit(-unfilled)` in the cutoff branch and SKIP the new cancelled-status reconciliation for cutoff-initiated cancellations by checking notes prefix). **Implementation guidance:** keep the existing cutoff branch's immediate release (it's safe — at cutoff time `filled_qty` has already been booked by prior partial-fill polls), and add the new cancelled/expired reconciliation branch ONLY for cases where Alpaca cancels independently (status terminal *without* our cutoff-initiated cancel). The cleanest discriminator is order origin: if `pendingStockExecutions` returns rows whose status was already updated to `cancelled` by our cutoff, they're filtered out (assume yes, since that mirrors the `submitted/partial` filter logic). So the new cancelled/expired branch only fires when Alpaca itself terminates the order while we still see it as `submitted/partial` — exactly the bug scenario. This means the cutoff branch can stay as-is.

**Final structure (recommended):**

```typescript
if (status === "filled" && execution.direction === "buy") { /* unchanged */ }
else if (execution.direction === "sell" && (status === "filled" || status === "partial" || status === "cancelled" || status === "expired")) {
  // guards + deltaQty booking unchanged
  if (status === "cancelled" || status === "expired") {
    const unfilled = Math.max(0, execution.quantity - totalFilledQty);
    if (unfilled > 0) addPendingExit(this.db, execution.positionId!, -unfilled);
    updateStockExecutionOrder(this.db, execution.id, { status, notes: `alpaca ${status}` });
    continue;
  }
}
else if (this.shouldCancelByEndOfDay(...)) { /* unchanged — cutoff path */ }
else if (this.shouldResubmit(...)) { /* unchanged */ }
```

Verify `updateStockExecutionOrder` accepts `status: "expired"` — it must. If the type union is narrower, widen it.

## Task 2 (Major) — `rebalancer.ts` exclude reserved tickers from sell pass

**Problem.** `executeDiffs` reserves cross-fund full exits via `exitTicker(...)` (which calls `submitMarketExit` for the position's full quantity, setting `pendingExitQty`). The same exit holdings still flow into the `sells` array → `rebalanceSell()` → `submitMarketExit` again → throws on `pendingExitQty` guard, aborting the rebalance with already-submitted partial work.

**Fix.** Track reserved tickers, filter them out of `sells`:

```diff
   private async executeDiffs(diffs: FundHoldingInput[], fundCik: string, reportDate: string) {
     const exitsByTicker = this.crossFundExits(diffs);
+    const fullyExitedTickers = new Set<string>();
     for (const [ticker, count] of exitsByTicker) {
-      if (count >= 2) await this.exitTicker(ticker, "fund_exit");
+      if (count >= 2) {
+        fullyExitedTickers.add(ticker);
+        await this.exitTicker(ticker, "fund_exit");
+      }
     }

-    const sells = diffs.filter((holding) => holding.changeType === "exit" || (holding.changeType === "decrease" && Math.abs(holding.changePct ?? 0) >= 0.25));
+    const sells = diffs.filter((holding) => {
+      const ticker = holding.ticker?.toUpperCase();
+      if (ticker && fullyExitedTickers.has(ticker)) return false;
+      return holding.changeType === "exit" || (holding.changeType === "decrease" && Math.abs(holding.changePct ?? 0) >= 0.25);
+    });
     const buys = diffs.filter((holding) => holding.changeType === "new" || (holding.changeType === "increase" && (holding.changePct ?? 0) >= 0.25));
```

`exitTicker` already passes `closeOnFill=true` and full quantity, so reserved tickers are fully accounted for. No other changes.

## Task 3 (Major) — `position-monitor.ts` gate hard-loss + softStopTriggered on pendingExitQty

**Problem.** Lines 64-67 (hard-loss branch) call `await this.exit(position, "time_stop")` unconditionally. `exit()` ultimately calls `submitMarketExit`, which now throws when `pendingExitQty > 0` (e.g. a queued day-60 half-sell is in flight). Same gap in `softStopTriggered()` (line 90-105) which calls `submitMarketExit` directly.

**Fix.** Add early-return guard `(position.pendingExitQty ?? 0) === 0` to both:

In `checkPosition` senator branch (around line 64):
```diff
-      if (pnlRatio !== null && pnlRatio <= -0.15) {
+      if (pnlRatio !== null && pnlRatio <= -0.15 && (position.pendingExitQty ?? 0) === 0) {
         await this.exit(position, "time_stop");
         return;
       }
```

In `softStopTriggered` (after the existing `stopLossOrderId/trailingStopOrderId` guard, line 92):
```diff
   private async softStopTriggered(position: StockPosition, currentPrice: number) {
     if (!position.stopLossPrice || currentPrice > position.stopLossPrice) return false;
     if (position.stopLossOrderId || position.trailingStopOrderId) return false;
+    if ((position.pendingExitQty ?? 0) > 0) return false;
     const reason = position.sleeve === "13f" ? "fund_exit" : "stop_loss";
```

Also audit `activateTrailingStop` and `sellHalf` — verify they already guard against pendingExitQty (the prior review #3 fix handled `sellHalf` indirectly via the take-profit gate). If `activateTrailingStop` calls `submitMarketExit` or anything that goes through the same guard, add the same check; otherwise leave it (it sets a stop order, not an exit submission). **Quick read first** — only add the guard if it actually risks throwing.

## Task 4 (Major) — `schema.ts` + `queries.ts` split rebalance claim from completion

**Problem.** `rebalance_runs.completed_at` defaults to `datetime('now')` on insert. `markRebalanceRun` does `INSERT OR IGNORE` → completed_at stamped at claim time. A failed rebalance is indistinguishable from a successful one in audit; retries via `clearRebalanceRun` work but the audit trail is wrong.

**Fix (schema, no migration needed for fresh DBs):**

`src/db/schema.ts` line 168-173:
```diff
 CREATE TABLE IF NOT EXISTS rebalance_runs (
   fund_cik TEXT NOT NULL,
   report_date TEXT NOT NULL,
-  completed_at TEXT DEFAULT (datetime('now')),
+  completed_at TEXT,
   PRIMARY KEY (fund_cik, report_date)
 );
```

**Fix (queries.ts):**

Modify `markRebalanceRun` to explicitly insert `completed_at = NULL`, overriding any existing DEFAULT in older DBs:
```diff
 export function markRebalanceRun(db: Database.Database, fundCik: string, reportDate: string): boolean {
-  const result = db.prepare("INSERT OR IGNORE INTO rebalance_runs (fund_cik, report_date) VALUES (?, ?)").run(fundCik, reportDate);
+  const result = db.prepare("INSERT OR IGNORE INTO rebalance_runs (fund_cik, report_date, completed_at) VALUES (?, ?, NULL)").run(fundCik, reportDate);
   return result.changes > 0;
 }
```

Add new helper next to `clearRebalanceRun`:
```typescript
export function completeRebalanceRun(db: Database.Database, fundCik: string, reportDate: string) {
  db.prepare("UPDATE rebalance_runs SET completed_at = datetime('now') WHERE fund_cik = ? AND report_date = ?").run(fundCik, reportDate);
}
```

**Fix (rebalancer.ts):**

Import the new helper, call it after `executeDiffs` succeeds in both call sites:

```diff
-import { clearRebalanceRun, markRebalanceRun, openStockPositions } from "../db/queries.js";
+import { clearRebalanceRun, completeRebalanceRun, markRebalanceRun, openStockPositions } from "../db/queries.js";
```

`onNewFiling`:
```diff
   if (!markRebalanceRun(this.db, first.fundCik, first.reportDate)) return;
   try {
     await this.executeDiffs(diffs, first.fundCik, first.reportDate);
+    completeRebalanceRun(this.db, first.fundCik, first.reportDate);
   } catch (error) {
     logger.error(...);
     clearRebalanceRun(...);
     throw error;
   }
```

`runDueRebalances`:
```diff
     try {
       await this.executeDiffs(diffs, row.fund_cik, row.report_date);
+      completeRebalanceRun(this.db, row.fund_cik, row.report_date);
     } catch (error) {
       logger.error(...);
       clearRebalanceRun(...);
     }
```

No DB migration needed: existing rows keep their default-stamped `completed_at` (harmless), new claims write NULL until completion. If audit cleanliness matters for old rows, that's a one-off ops concern, not a code change.

## Task 5 (Major) — `queries.ts` markExecutionReconcileFailed releases sell reservation

**Problem.** When reconciliation fails (sell fill missing position_id, or position not found), the execution is marked `failed`, but `pending_exit_qty` was never released. Future exits on that position are blocked.

**Note:** the position-not-found branch in `order-manager.ts` already calls `addPendingExit(this.db, execution.positionId, -execution.quantity)` after `markExecutionReconcileFailed` (line 156). The missing-position-id branch (line 149) does NOT — and can't, since there's no positionId. So this fix is for callers that don't manually release.

**Fix.** Make `markExecutionReconcileFailed` release the reservation atomically when applicable:

```diff
 export function markExecutionReconcileFailed(db: Database.Database, executionId: number, reason: string) {
+  const execution = db.prepare(
+    "SELECT direction, position_id, quantity FROM stock_executions WHERE id = ?"
+  ).get(executionId) as { direction: string; position_id: number | null; quantity: number } | undefined;
+
   db.prepare(
     `UPDATE stock_executions
      SET status = 'failed',
          notes = COALESCE(notes, '') || ' | RECONCILE_FAILED: ' || ?
      WHERE id = ?`
   ).run(reason, executionId);
+
+  if (execution?.direction === "sell" && execution.position_id) {
+    db.prepare(
+      `UPDATE stock_positions
+       SET pending_exit_qty = MAX(0, COALESCE(pending_exit_qty, 0) - ?)
+       WHERE id = ?`
+    ).run(execution.quantity, execution.position_id);
+  }
 }
```

**Then remove the now-redundant manual release in `order-manager.ts:156`** (the position-not-found branch) since the helper handles it:

```diff
         const position = findPositionById(this.db, execution.positionId);
         if (!position) {
           logger.error(...);
           markExecutionReconcileFailed(this.db, execution.id, `position ${execution.positionId} not found`);
-          addPendingExit(this.db, execution.positionId, -execution.quantity);
           continue;
         }
```

**Caveat:** the missing-position-id branch (line 147-150) has no `positionId` so the helper's reservation-release is a no-op there — correct.

## Task 6 (Major) — `queries.ts` closeStockPosition reduces quantity

**Problem.** `closeStockPosition` sets `status='closed'`, accumulates `realized_pnl_usd` and `realized_qty`, but never reduces `quantity` itself. Closed rows still show original share count in reporting/historical sums.

**Fix.** Add `quantity = MAX(0, quantity - COALESCE(?, quantity))` to the UPDATE. The COALESCE-fallback to `quantity` means: if `sliceFilledQty` is null, treat as full-exit (zero out). If non-null, subtract the slice.

```diff
 export function closeStockPosition(
   db: Database.Database,
   id: number,
   exitReason: string,
   slicePnlUsd?: number | null,
   sliceFilledQty?: number | null
 ) {
   db.prepare(
     `UPDATE stock_positions
-     SET status = 'closed',
+     SET quantity = MAX(0, quantity - COALESCE(?, quantity)),
+         status = 'closed',
          closed_at = datetime('now'),
          exit_reason = ?,
          realized_pnl_usd = COALESCE(realized_pnl_usd, 0) + COALESCE(?, 0),
          realized_qty = COALESCE(realized_qty, 0) + COALESCE(?, 0),
          pnl_usd = COALESCE(realized_pnl_usd, 0) + COALESCE(?, 0),
          pnl_ratio = CASE
            WHEN avg_entry_price > 0 AND (COALESCE(realized_qty, 0) + COALESCE(?, 0)) > 0
              THEN (COALESCE(realized_pnl_usd, 0) + COALESCE(?, 0))
                   / (avg_entry_price * (COALESCE(realized_qty, 0) + COALESCE(?, 0)))
            ELSE pnl_ratio
          END,
          pending_exit_qty = 0
      WHERE id = ?`
   ).run(
+    sliceFilledQty ?? null,
     exitReason,
     slicePnlUsd ?? null,
     sliceFilledQty ?? null,
     slicePnlUsd ?? null,
     sliceFilledQty ?? null,
     slicePnlUsd ?? null,
     sliceFilledQty ?? null,
     id
   );
 }
```

The new placeholder is the FIRST `?` in the SET list (matches `MAX(0, quantity - COALESCE(?, quantity))`), so it goes first in `.run(...)`.

## Task 7 (Major) — `queries.ts` updateStockPositionMarket allows null pnl_ratio

**Problem.** `coalesce(?, pnl_ratio)` preserves the prior value when `null` is passed. Callers that intentionally clear an invalid pnl_ratio (e.g. `avg_entry_price <= 0` guard from review #2) cannot do so → stale ratios survive in stop/alert logic.

**Fix.** Detect explicit `pnlRatio` property presence vs absence using `Object.prototype.hasOwnProperty.call`. Use a `CASE WHEN ? = 1 THEN ? ELSE pnl_ratio END` to write the new value (including null) only when explicitly provided:

```diff
 export function updateStockPositionMarket(
   db: Database.Database,
   id: number,
   input: { currentPrice?: number | null; pnlUsd?: number | null; pnlRatio?: number | null }
 ) {
+  const hasPnlRatio = Object.prototype.hasOwnProperty.call(input, "pnlRatio");
   db.prepare(
     `UPDATE stock_positions
      SET current_price = coalesce(?, current_price),
          pnl_usd = coalesce(?, pnl_usd),
-         pnl_ratio = coalesce(?, pnl_ratio)
+         pnl_ratio = CASE WHEN ? = 1 THEN ? ELSE pnl_ratio END
      WHERE id = ?`
-  ).run(input.currentPrice ?? null, input.pnlUsd ?? null, input.pnlRatio ?? null, id);
+  ).run(
+    input.currentPrice ?? null,
+    input.pnlUsd ?? null,
+    hasPnlRatio ? 1 : 0,
+    input.pnlRatio ?? null,
+    id
+  );
 }
```

Callers that previously did `updateStockPositionMarket(db, id, { ...m, pnlRatio: null })` to clear now succeed. Callers that pass `{ currentPrice, pnlUsd }` (no `pnlRatio` key) keep the prior value (omit semantics preserved).

## Verification

1. `npm test` — must remain 2/2 green.
2. `npm run build` — typecheck + emit, must pass.
3. **DO NOT commit, push, or restart services.** Report which files changed and final test count.

## Stop conditions

- Any test failure unexplained by these tasks → stop and report.
- Honor preserved decisions from prior reviews:
  - atomic markRebalanceRun claim (review #2) — preserved, augmented with completion stamp split (this review)
  - reconcile-failed status semantics — preserved, helper now releases reservation
  - SSE broadcast path + named heartbeat (review #3) — preserved
  - existing wash-sale ownership — preserved
- Skipped findings:
  - ♻️ Duplicate `closeStockPosition` cumulative slice-PnL — per stop rule (Duplicates ignored). Quantity fix in Task 6 partially addresses the "quantity not updated" angle of the duplicate finding, which is acceptable.
  - 🔵 Trivial Nitpick `schema.ts:224` RENAME regex — already triaged Trivial in iter 3.
