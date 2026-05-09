# CodeRabbit Stock-Tracker Review #2 — Codex Execution Plan

**Trigger:** PR #1 review submitted 2026-05-09 18:57:59Z against commit `bf44752`.
**Review payload:** `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-2-raw.md`.
**Counts:** 5 actionable Major + 1 duplicate (which is the same finding as task 2 below — addressed by combining with task 2).

## Triage — all 5 APPLY

| # | Path | Severity | Reason |
|---|------|----------|--------|
| 1 | `src/db/queries.ts:466-481` | 🟠 Major | `applyPartialFill` flips `status='closed'` when remaining=0, but never sets `closed_at`. Closed-at remains NULL on positions closed via partial-fill aggregation, breaking close-time reporting and any time-based analytics. |
| 2 | `src/execution/order-manager.ts:188-228` | 🟠 Major | Race condition: `findPositionById` reads `pendingExitQty`, then `await submitOrder` yields, then `addPendingExit` runs. Two concurrent `submitMarketExit` for the same position can both read `pending=0`, both pass the availability check, both submit, both increment pending → oversubscribed exit. Fix: reserve before submit, rollback on failure. |
| 3 | `src/execution/position-monitor.ts:97-99` | 🟠 Major | `softStopTriggered` divides `(currentPrice - avgEntryPrice) / position.avgEntryPrice` without guarding `avgEntryPrice <= 0`, producing NaN/Infinity in the alert payload. Mirror the guard pattern at line 123 (`pnlRatio = avgEntryPrice > 0 ? ... : null`). |
| 4 | `src/execution/position-monitor.ts:39-40` | 🟠 Major | Same issue in `checkPosition`: pnlRatio division-by-zero, then NaN gets persisted via `updateStockPositionMarket` and propagates to all downstream comparisons (`pnlRatio >= 0.15`, etc). Same fix. |
| 5 | `src/execution/rebalancer.ts:27` | 🟠 Major | TOCTOU: `hasRebalanceRun` check is separate from `markRebalanceRun` claim, with order submission in between. Two scheduler processes can both pass the check and both submit orders. Fix: make `markRebalanceRun` return whether it actually claimed (INSERT OR IGNORE → changes > 0), call it BEFORE order submission, abort if not claimed. |

The "duplicate" comment about reconcile-failed paths needing to release `pending_exit_qty` is naturally subsumed by task 2 — since the new flow reserves *before* submit, both reconcile-failed branches in `monitorOrders` (line 147-157) must release the reservation. Task 2 covers it.

## Tasks

### Task 1 — `db/queries.ts:466-481` set `closed_at` on partial-fill close

Modify the SQL inside `applyPartialFill` to set `closed_at` when the position becomes closed:

```diff
 export function applyPartialFill(
   db: Database.Database,
   positionId: number,
   filledQuantity: number,
   slicePnlUsd?: number | null
 ) {
   db.prepare(
     `UPDATE stock_positions
      SET quantity = MAX(0, quantity - ?),
          pending_exit_qty = MAX(0, COALESCE(pending_exit_qty, 0) - ?),
          realized_pnl_usd = COALESCE(realized_pnl_usd, 0) + COALESCE(?, 0),
          realized_qty = COALESCE(realized_qty, 0) + ?,
-         status = CASE WHEN MAX(0, quantity - ?) <= 0 THEN 'closed' ELSE 'partial' END
+         status = CASE WHEN MAX(0, quantity - ?) <= 0 THEN 'closed' ELSE 'partial' END,
+         closed_at = CASE WHEN MAX(0, quantity - ?) <= 0 THEN CURRENT_TIMESTAMP ELSE closed_at END
      WHERE id = ?`
-  ).run(filledQuantity, filledQuantity, slicePnlUsd ?? null, filledQuantity, filledQuantity, positionId);
+  ).run(filledQuantity, filledQuantity, slicePnlUsd ?? null, filledQuantity, filledQuantity, filledQuantity, positionId);
 }
```

Note one extra `filledQuantity` placeholder added to `.run(...)` to match the new CASE expression.

### Task 2 — `order-manager.ts:179-248` reserve-before-submit + rollback + reconcile release

Two pieces:

**(a) `submitMarketExit` (lines 179-248)** — reserve `addPendingExit` immediately after `insertStockExecution`, BEFORE awaiting `submitOrder`. On submit failure, rollback the reservation. Restructure:

```typescript
async submitMarketExit(
  positionId: number,
  ticker: string,
  quantity: number,
  reason: string,
  sleeve: ExecutionSleeve = "senator",
  closeOnFill = true,
  postFillAction: string | null = null
) {
  const position = findPositionById(this.db, positionId);
  if (!position) {
    throw new Error(`submitMarketExit: position ${positionId} not found`);
  }
  const available = Math.max(0, position.quantity - (position.pendingExitQty ?? 0));
  if (quantity > available + 1e-9) {
    throw new Error(`submitMarketExit: requested ${quantity} exceeds available ${available} (qty=${position.quantity}, pending=${position.pendingExitQty ?? 0})`);
  }

  const executionId = insertStockExecution(this.db, {
    triggerType: reasonToTrigger(reason),
    positionId,
    sleeve,
    ticker,
    direction: "sell",
    quantity,
    status: "pending",
    notes: reason,
    postFillAction
  });

  // Reserve the quantity BEFORE yielding to submitOrder, so concurrent calls
  // see the reservation when they read pendingExitQty.
  addPendingExit(this.db, positionId, quantity);

  const isFractional = quantity % 1 !== 0;
  let order: AlpacaOrder;
  try {
    order = await this.alpaca.submitOrder({
      symbol: ticker,
      qty: quantity.toString(),
      side: "sell",
      type: "market",
      time_in_force: isFractional ? "day" : "gtc",
      client_order_id: `st-exit-${executionId}-${Date.now()}`
    });
  } catch (error) {
    // Rollback the reservation — the order never made it to Alpaca.
    addPendingExit(this.db, positionId, -quantity);
    updateStockExecutionOrder(this.db, executionId, {
      status: "failed",
      notes: `submit failed: ${error instanceof Error ? error.message : String(error)}`
    });
    throw error;
  }

  updateStockExecutionOrder(this.db, executionId, {
    alpacaOrderId: order.id,
    alpacaClientOrderId: order.client_order_id,
    status: mapOrderStatus(order.status)
  });

  if (mapOrderStatus(order.status) === "filled") {
    const filledPrice = money(order.filled_avg_price ?? undefined);
    const filledQty = money(order.filled_qty) || quantity;
    const slicePnlUsd = filledPrice > 0 ? (filledPrice - position.avgEntryPrice) * filledQty : null;
    if (slicePnlUsd !== null && slicePnlUsd < 0) this.trackWashSaleIfNeeded(ticker, slicePnlUsd);
    if (closeOnFill) {
      closeStockPosition(this.db, positionId, reason, slicePnlUsd, filledQty);
    } else {
      applyPartialFill(this.db, positionId, filledQty, slicePnlUsd);
      applyPostFillAction(this.db, executionId);
    }
  }
  return order;
}
```

`addPendingExit(... -quantity)` works because the helper does `pending_exit_qty = COALESCE(pending_exit_qty, 0) + ?` — passing a negative subtracts. The DB column is REAL/INTEGER so negative arithmetic is fine; clamping is unnecessary because we only ever subtract what we just added.

**(b) `monitorOrders` reconcile-failed branches (lines 145-157)** — when reconcile fails on a sell with reserved pending, release it. Both branches now look like:

```diff
         } else if (execution.direction === "sell") {
           if (!execution.positionId) {
             logger.error({ executionId: execution.id, ticker: execution.ticker }, "sell fill missing position_id; flagging for manual reconciliation");
             markExecutionReconcileFailed(this.db, execution.id, "sell fill missing position_id");
             continue;
           }
           const position = findPositionById(this.db, execution.positionId);
           if (!position) {
             logger.error({ executionId: execution.id, positionId: execution.positionId }, "sell fill references unknown position; flagging for manual reconciliation");
             markExecutionReconcileFailed(this.db, execution.id, `position ${execution.positionId} not found`);
+            addPendingExit(this.db, execution.positionId, -execution.quantity);
             continue;
           }
```

The first branch (no `positionId`) cannot release because we don't have a position id to update — the reservation was never tied to an unknown position; this branch is unreachable in practice because `submitMarketExit` always sets `positionId`. Leave it as-is.

The second branch (positionId exists, position not found) DOES need release. Add the line shown.

### Task 3 — `position-monitor.ts:39` guarded pnlRatio in checkPosition

```diff
   private async checkPosition(position: StockPosition) {
     const alpacaPosition = await this.alpaca.getPosition(position.ticker);
     const currentPrice = alpacaPosition ? money(alpacaPosition.current_price) : position.currentPrice ?? position.avgEntryPrice;
     const pnlUsd = (currentPrice - position.avgEntryPrice) * position.quantity;
-    const pnlRatio = (currentPrice - position.avgEntryPrice) / position.avgEntryPrice;
+    const pnlRatio = position.avgEntryPrice > 0
+      ? (currentPrice - position.avgEntryPrice) / position.avgEntryPrice
+      : null;
     updateStockPositionMarket(this.db, position.id, { currentPrice, pnlUsd, pnlRatio });
```

Then downstream comparisons (`pnlRatio >= 0.15`, `pnlRatio <= -0.15`, `pnlRatio >= 0.25`, `pnlRatio >= 0.2`) need a null-guard. Currently they read `pnlRatio` as `number`; with the new `number | null` type, TypeScript will complain. Wrap each:

```diff
     if (position.sleeve === "senator") {
-      if (pnlRatio >= 0.15 && !position.trailingStopActive) await this.activateTrailingStop(position, 8);
-      if (pnlRatio >= 0.25 && position.status === "open") {
+      if (pnlRatio !== null && pnlRatio >= 0.15 && !position.trailingStopActive) await this.activateTrailingStop(position, 8);
+      if (pnlRatio !== null && pnlRatio >= 0.25 && position.status === "open") {
         await this.sellHalf(position, "take_profit");
         return;
       }
-      if (pnlRatio <= -0.15) {
+      if (pnlRatio !== null && pnlRatio <= -0.15) {
         await this.exit(position, "time_stop");
         return;
       }
-      await this.checkSenatorTimeStops(position, pnlRatio);
+      if (pnlRatio !== null) await this.checkSenatorTimeStops(position, pnlRatio);
     } else {
-      if (pnlRatio >= 0.2 && !position.trailingStopActive) await this.activateTrailingStop(position, 8);
+      if (pnlRatio !== null && pnlRatio >= 0.2 && !position.trailingStopActive) await this.activateTrailingStop(position, 8);
     }
```

If `updateStockPositionMarket` signature requires `pnlRatio: number`, widen it to `number | null` in `db/queries.ts` (the column is nullable in schema).

### Task 4 — `position-monitor.ts:97-99` guarded pnlRatio in softStopTriggered

```diff
   private async softStopTriggered(position: StockPosition, currentPrice: number) {
     if (!position.stopLossPrice || currentPrice > position.stopLossPrice) return false;
     if (position.stopLossOrderId || position.trailingStopOrderId) return false;
     const reason = position.sleeve === "13f" ? "fund_exit" : "stop_loss";
     logger.warn(
       { positionId: position.id, ticker: position.ticker, currentPrice, stopLossPrice: position.stopLossPrice },
       "soft-stop: position has no Alpaca stop order; triggering exit at stop price",
     );
     await this.orderManager.submitMarketExit(position.id, position.ticker, position.quantity, reason, position.sleeve, true);
     const pnlUsd = (currentPrice - position.avgEntryPrice) * position.quantity;
-    const pnlRatio = (currentPrice - position.avgEntryPrice) / position.avgEntryPrice;
+    const pnlRatio = position.avgEntryPrice > 0
+      ? (currentPrice - position.avgEntryPrice) / position.avgEntryPrice
+      : null;
     await this.alert("stop_triggered", position, { exitReason: "soft_stop", pnlUsd, pnlRatio });
     return true;
   }
```

The `alert(...)` payload accepts `pnlRatio` via `data` (a `Record<string, unknown>`), so `null` is fine.

### Task 5 — `rebalancer.ts` atomic claim before submission

**(a) `db/queries.ts:512-514` — make `markRebalanceRun` return whether it actually claimed:**

```diff
-export function markRebalanceRun(db: Database.Database, fundCik: string, reportDate: string) {
-  db.prepare("INSERT OR IGNORE INTO rebalance_runs (fund_cik, report_date) VALUES (?, ?)").run(fundCik, reportDate);
+export function markRebalanceRun(db: Database.Database, fundCik: string, reportDate: string): boolean {
+  const result = db.prepare("INSERT OR IGNORE INTO rebalance_runs (fund_cik, report_date) VALUES (?, ?)").run(fundCik, reportDate);
+  return result.changes > 0;
 }
```

**(b) `rebalancer.ts:23-89` — claim before submission, drop the trailing call:**

```typescript
async onNewFiling(diffs: FundHoldingInput[]) {
  if (diffs.length === 0) return;
  const first = diffs[0];
  if (!first) return;
  if (!this.isRebalanceWindow(first.filingDate)) {
    logger.info({ filingDate: first.filingDate, fundName: first.fundName, fundCik: first.fundCik }, "13F filing queued until delayed rebalance window");
    return;
  }
  // Atomic claim — if another process already ran this filing, abort.
  if (!markRebalanceRun(this.db, first.fundCik, first.reportDate)) return;
  await this.executeDiffs(diffs, first.fundCik, first.reportDate);
}

async runDueRebalances() {
  const rows = this.db
    .prepare(
      `SELECT DISTINCT fund_cik, report_date
       FROM fund_holdings
       WHERE change_type IS NOT NULL
         AND date('now') BETWEEN date(filing_date, '+3 days') AND date(filing_date, '+5 days')`
    )
    .all() as { fund_cik: string; report_date: string }[];

  for (const row of rows) {
    if (!markRebalanceRun(this.db, row.fund_cik, row.report_date)) continue;
    const diffs = this.db
      .prepare("SELECT * FROM fund_holdings WHERE fund_cik = ? AND report_date = ? AND change_type IS NOT NULL")
      .all(row.fund_cik, row.report_date)
      .map(mapHolding);
    await this.executeDiffs(diffs, row.fund_cik, row.report_date);
  }
}
```

And in `executeDiffs`, drop the now-redundant `markRebalanceRun(...)` call (line 77). Keep the alert try/catch — it's still needed for alert-engine fault tolerance:

```diff
   private async executeDiffs(diffs: FundHoldingInput[], fundCik: string, reportDate: string) {
     // ... existing exit/sell/buy logic ...
     for (const holding of buys) {
       const decision = await this.signalFilter.evaluate13FDiff(holding);
       if (!decision.copy) continue;
       decision.metadata = { ...decision.metadata, dailyFraction: 0.2, fundSignalCount: this.fundSignalCount(diffs, decision.ticker) };
       await this.orderManager.submitSignal(decision);
     }

-    markRebalanceRun(this.db, fundCik, reportDate);
     try {
       await this.alertEngine?.executionNotification({
         type: "rebalance",
         ticker: "13F",
         direction: "buy",
         size: buys.length,
         reason: `processed ${sells.length} sells and ${buys.length} buys`
       });
     } catch (error) {
       logger.warn({ error, fundCik, reportDate }, "rebalance alert failed (run already persisted)");
     }
   }
```

Drop the `hasRebalanceRun` import since it's no longer used. Keep the import for `markRebalanceRun`.

Note: also remove `hasRebalanceRun` from `db/queries.ts` if it has no other callers — check with grep before deleting. If it has callers, leave the function in place.

The 30-second sleep (line 68) widens the window between sells and buys to let cash settle. With atomic claim now protecting against duplicate runs, the sleep no longer affects correctness — keep it for cash-settlement realism.

## Verification & Ship Sequence

1. `npm run typecheck`
2. `npm test` — must remain green; if any test stubs `pnlRatio` as `number`, update to `number | null`.
3. `npm run build`
4. **DO NOT commit, push, or restart services.** Stop and report which files changed and final test count.

## Stop conditions

- Any unexpected behavioural test failure not explained by tasks above → stop and report.
- Honor prior decisions: existing wash-sale flow ownership (fill path), reconcile-failed status semantics, OTO bracket entry params.
