# CodeRabbit review #7 — execution plan

**PR:** MeNass89/stock-tracker#1 — review submitted 2026-05-09T20:27:26Z against `52ec113`.
**Findings:** 4 🔴 Critical + 2 🟠 Major + 1 🟡 Minor (skipped).
**Stop conditions:** 0 Critical + 0 Major NEW. Honor preserved decisions from reviews #1–#6.

## Preserved decisions (do not regress)

- Atomic `markRebalanceRun` claim, `completeRebalanceRun` on success.
- SSE broadcast helper + named `heartbeat` event, `sseClients` Set, write try/catch in `broadcastSSE`.
- `pendingExitQty` reservation, `closeStockPosition` reduces `quantity`, `applyPartialFill`, `applyPostFillAction`, `markExecutionReconcileFailed` releases reservation.
- `softStopTriggered` gates: `!stopLossOrderId && !trailingStopOrderId && !pendingExitQty`.
- `stopLossFilled` rejected/expired clears stale ids via direct prepared statement + mirrors mutation onto in-memory `position`.
- `activateTrailingStop` returns on cancelOrder failure; clears `stop_loss_order_id` in single prepared UPDATE alongside trailing fields.
- `handleFlashCrash` persists DB only after Alpaca confirms `replaceOrder`.
- `trackWashSaleIfNeeded(ticker, pnlUsd, fillTimestamp)` cooldown anchored to fill date in UTC.
- `updateHealth` try/catch per source.

## Task 1 (🔴 Critical) — `position-monitor.ts:58-68` block discretionary exits while resting stop is active

**Problem.** After `stopLossFilled()` returns `false`, the senator branch at lines 58–68 can still arm a trailing stop, queue `sellHalf()`, or call `exit()` while `stopLossOrderId` or `trailingStopOrderId` is still working at Alpaca. That layers a second sell on top of the unfilled stop order, double-selling the same shares.

**Fix.** Bail out of all discretionary actions when either resting-stop id is present. The trailing-stop *activation* path is the exception — it explicitly cancels the existing stop before placing the trailing one, so it must stay. Wrap the sellHalf/exit/checkSenatorTimeStops calls (not the activation):

```diff
     if (position.sleeve === "senator") {
       if (pnlRatio !== null && pnlRatio >= 0.15 && !position.trailingStopActive) await this.activateTrailingStop(position, 8);
+      const restingStop = Boolean(position.stopLossOrderId || position.trailingStopOrderId);
+      if (restingStop) return;
       if (pnlRatio !== null && pnlRatio >= 0.25 && position.status === "open" && (position.pendingExitQty ?? 0) === 0) {
         await this.sellHalf(position, "take_profit");
         return;
       }
       if (pnlRatio !== null && pnlRatio <= -0.15 && (position.pendingExitQty ?? 0) === 0) {
         await this.exit(position, "time_stop");
         return;
       }
       if (pnlRatio !== null) await this.checkSenatorTimeStops(position, pnlRatio);
     } else {
       if (pnlRatio !== null && pnlRatio >= 0.2 && !position.trailingStopActive) await this.activateTrailingStop(position, 8);
+      const restingStop = Boolean(position.stopLossOrderId || position.trailingStopOrderId);
+      if (restingStop) return;
     }
```

**Why position is current.** After the iter-6 fix, `activateTrailingStop` mutates `position.stopLossOrderId = null` and `position.trailingStopOrderId = order.id` before returning, so the post-activation guard correctly sees the trailing-stop id and bails out of any `sellHalf`/`exit` for this poll. On the *next* poll, the trailing stop will still be present and the guard fires before any discretionary action.

**Note on 13f branch.** Lines 70-72 currently only call `activateTrailingStop`. Add the same guard to be defensive: a 13f position with a working stop must not race into other discretionary paths added later.

## Task 2 (🔴 Critical) — `position-monitor.ts:131-145` partial-fill when stop fills less than position quantity

**Problem.** `submitStopLoss()` and `activateTrailingStop()` only place `Math.floor(position.quantity)` shares (whole-share orders for stop types). For a 1.5-share fractional position, the resting stop is for 1 share. When that 1-share stop fills, the current code in `stopLossFilled()` calls `closeStockPosition()`, marking the row `closed` while 0.5 shares remain open and unprotected.

**Fix.** When `filledQty < position.quantity`, route through `applyPartialFill` (which decrements `quantity`, books realized P&L, and only flips status to `closed` when remainder reaches zero). Only call `closeStockPosition` when the fill consumes the full position.

```diff
       if (order.status !== "filled") continue;

       const filledPrice = money(order.filled_avg_price ?? undefined) || position.stopLossPrice || position.currentPrice || position.avgEntryPrice;
       const filledQty = money(order.filled_qty) || position.quantity;
       const pnlUsd = (filledPrice - position.avgEntryPrice) * filledQty;
       const pnlRatio = position.avgEntryPrice > 0 ? (filledPrice - position.avgEntryPrice) / position.avgEntryPrice : null;
       const exitReason = orderId === position.trailingStopOrderId ? "trailing_stop" : "stop_loss";
-      closeStockPosition(this.db, position.id, exitReason, pnlUsd, filledQty);
+      if (filledQty < position.quantity) {
+        applyPartialFill(this.db, position.id, filledQty, pnlUsd);
+      } else {
+        closeStockPosition(this.db, position.id, exitReason, pnlUsd, filledQty);
+      }
       this.trackWashSaleIfNeeded(position.ticker, pnlUsd, order.filled_at ?? new Date().toISOString());
       await this.alert("stop_triggered", position, { exitReason, pnlUsd, pnlRatio });
       return true;
```

**Import update.** Add `applyPartialFill` to the existing import from `../db/queries.js` at the top of `position-monitor.ts`.

**`exitReason` in partial path.** `applyPartialFill` doesn't take `exitReason` (the original closeStockPosition does). The CR comment notes "exitReason still recorded via the alert"; that's fine — the alert at the bottom of the block carries `exitReason`, which is what the alert engine consumes for downstream notifications. The partial row's `closed_at` is left null until the remainder closes.

**Wash sale on partial.** `trackWashSaleIfNeeded` is keyed on `(ticker, fillTimestamp)`. On a partial it records the realized loss for the slice; on the next slice (e.g., remaining 0.5 shares closed via soft-stop later), a different `loss_sale_date`/`loss_amount` may be recorded. Keep current behavior — wash-sale invariant is per-fill not per-position.

## Task 3 (🔴 Critical) — `order-manager.ts:180-187` don't mark cancelled before broker confirms terminal state

**Problem.** Around line 180-187 in `monitorOrders()`, when `shouldCancelByEndOfDay(execution.createdAt)` is true, the code calls `alpaca.cancelOrder(execution.alpacaOrderId)` then immediately writes `status = "cancelled"` to the execution row. That removes the row from `pendingStockExecutions()`. If the broker fills the order *between* our cancel request and Alpaca processing it (last-second fill race), the late fill never gets reconciled — `monitorOrders()` won't see this execution again, so:
- The fill is recorded by Alpaca but our DB shows `cancelled` with no `filled_qty`, no realized P&L row update, no `pendingExitQty` release for the actual filled portion.
- `addPendingExit(this.db, execution.positionId, -unfilled)` releases the *requested* unfilled quantity, but if any portion did fill, the position's quantity isn't decremented.

**Fix.** Issue the cancel but leave the execution in a transient state so the next `monitorOrders()` tick picks up the broker's terminal response (`cancelled` / `expired` / `filled` / `partially_filled`). The simplest transient encoding: keep `status = "submitted"` (or `"partial"` if already partially filled), and append a note marker so we don't re-issue the cancel. The next tick will read the order, observe Alpaca's terminal state, and run the existing reconciliation in the upper branch (lines ~150–179 — the `if (status === "cancelled" || status === "expired")` block).

```diff
       } else if (this.shouldCancelByEndOfDay(execution.createdAt)) {
-        await this.alpaca.cancelOrder(execution.alpacaOrderId);
-        if (execution.direction === "sell" && execution.positionId) {
-          const totalFilled = money(order.filled_qty);
-          const unfilled = Math.max(0, execution.quantity - totalFilled);
-          if (unfilled > 0) addPendingExit(this.db, execution.positionId, -unfilled);
-        }
-        updateStockExecutionOrder(this.db, execution.id, { status: "cancelled", notes: "cancelled at 15:45 ET cutoff" });
+        if (!execution.notes?.includes("cancel-requested")) {
+          try {
+            await this.alpaca.cancelOrder(execution.alpacaOrderId);
+          } catch (error) {
+            logger.warn(
+              { error, executionId: execution.id, alpacaOrderId: execution.alpacaOrderId },
+              "EOD cancel request failed; will retry next tick if execution still pending"
+            );
+            continue;
+          }
+          updateStockExecutionOrder(this.db, execution.id, {
+            notes: `${execution.notes ?? ""} | cancel-requested at 15:45 ET cutoff`.trim()
+          });
+        }
+        // Leave execution in submitted/partial; next monitorOrders() tick will observe
+        // Alpaca's terminal status (cancelled/expired/filled/partially_filled) and route
+        // through the upper reconciliation branch which releases pending qty correctly.
       } else if (this.shouldResubmit(execution.createdAt)) {
```

**Verify.** `updateStockExecutionOrder` accepts `notes` updates without changing `status` — check the signature. If it always overwrites status to undefined → null, pass the current `execution.status` explicitly. The marker `cancel-requested` prevents repeat cancel calls on subsequent ticks. `pendingStockExecutions()` returns rows where `status IN ('pending','submitted','partial')` (verify in queries.ts) — leaving status untouched keeps the row in that result.

**Note on `pendingStockExecutions` filter.** Open `src/db/queries.ts`, find `pendingStockExecutions`, confirm it filters on `status IN (...)` not on a notes field. If the filter set excludes `submitted` somehow, adjust accordingly (likely it includes `submitted` since orders are submitted by default). Don't add a new transient status enum — that would ripple through types and migrations.

## Task 4 (🔴 Critical) — `rebalancer.ts:36-37,62-63` durable failed state instead of deleting claim

**Problem.** `clearRebalanceRun()` deletes the `rebalance_runs` row in the catch block. After deletion, the row no longer blocks future `markRebalanceRun()` claims, so the same `(fund_cik, report_date)` can be retried automatically. If `executeDiffs()` already submitted some sells/buys before throwing, the retry replays the *full* diff list from the top — re-submitting the orders that already executed. That's a double-execution risk on partial-failure paths.

**Fix.** Add a durable `status` column to `rebalance_runs` (default `'in_progress'` on insert via `markRebalanceRun`, set to `'completed'` on `completeRebalanceRun`, set to `'failed'` on a new `markRebalanceRunFailed`). Replace `clearRebalanceRun` with `markRebalanceRunFailed`. The PK constraint on `(fund_cik, report_date)` already prevents future `INSERT OR IGNORE` claims, so a failed row blocks automatic retry — manual intervention (delete the row or change status) is required to resubmit, which matches the "no automatic re-execution after partial side effects" invariant.

### Schema migration

Append to `src/db/schema.ts` `idempotentMigrations` array:

```ts
"ALTER TABLE rebalance_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'in_progress'",
"ALTER TABLE rebalance_runs ADD COLUMN last_error TEXT",
```

Update the inline `CREATE TABLE` (both the schema declaration around `schema.ts:168` and the second copy in `idempotentMigrations` around line 206) to include `status TEXT NOT NULL DEFAULT 'in_progress'` and `last_error TEXT`. Keep them aligned so fresh installs and migrated installs match.

### Queries — `src/db/queries.ts`

```diff
 export function markRebalanceRun(db: Database.Database, fundCik: string, reportDate: string): boolean {
-  const result = db.prepare("INSERT OR IGNORE INTO rebalance_runs (fund_cik, report_date, completed_at) VALUES (?, ?, NULL)").run(fundCik, reportDate);
+  const result = db
+    .prepare(
+      "INSERT OR IGNORE INTO rebalance_runs (fund_cik, report_date, status, completed_at) VALUES (?, ?, 'in_progress', NULL)"
+    )
+    .run(fundCik, reportDate);
   return result.changes > 0;
 }

-export function clearRebalanceRun(db: Database.Database, fundCik: string, reportDate: string) {
-  db.prepare("DELETE FROM rebalance_runs WHERE fund_cik = ? AND report_date = ?").run(fundCik, reportDate);
+export function markRebalanceRunFailed(
+  db: Database.Database,
+  fundCik: string,
+  reportDate: string,
+  lastError: string
+) {
+  db.prepare(
+    "UPDATE rebalance_runs SET status = 'failed', last_error = ? WHERE fund_cik = ? AND report_date = ?"
+  ).run(lastError, fundCik, reportDate);
 }

 export function completeRebalanceRun(db: Database.Database, fundCik: string, reportDate: string) {
-  db.prepare("UPDATE rebalance_runs SET completed_at = datetime('now') WHERE fund_cik = ? AND report_date = ?").run(fundCik, reportDate);
+  db.prepare(
+    "UPDATE rebalance_runs SET status = 'completed', completed_at = datetime('now') WHERE fund_cik = ? AND report_date = ?"
+  ).run(fundCik, reportDate);
 }
```

### Rebalancer — `src/execution/rebalancer.ts`

```diff
-import { clearRebalanceRun, completeRebalanceRun, markRebalanceRun, openStockPositions } from "../db/queries.js";
+import { completeRebalanceRun, markRebalanceRun, markRebalanceRunFailed, openStockPositions } from "../db/queries.js";
@@
   async onNewFiling(diffs: FundHoldingInput[]) {
     // ...
     if (!markRebalanceRun(this.db, first.fundCik, first.reportDate)) return;
     try {
       await this.executeDiffs(diffs, first.fundCik, first.reportDate);
       completeRebalanceRun(this.db, first.fundCik, first.reportDate);
     } catch (error) {
-      logger.error({ error, fundCik: first.fundCik, reportDate: first.reportDate }, "rebalance failed; clearing claim so it can be retried");
-      clearRebalanceRun(this.db, first.fundCik, first.reportDate);
+      const message = error instanceof Error ? error.message : String(error);
+      logger.error(
+        { error, fundCik: first.fundCik, reportDate: first.reportDate },
+        "rebalance failed; persisting failed claim (manual intervention required to retry)"
+      );
+      markRebalanceRunFailed(this.db, first.fundCik, first.reportDate, message);
       throw error;
     }
   }
@@
       try {
         await this.executeDiffs(diffs, row.fund_cik, row.report_date);
         completeRebalanceRun(this.db, row.fund_cik, row.report_date);
       } catch (error) {
-        logger.error({ error, fundCik: row.fund_cik, reportDate: row.report_date }, "rebalance failed; clearing claim so it can be retried");
-        clearRebalanceRun(this.db, row.fund_cik, row.report_date);
+        const message = error instanceof Error ? error.message : String(error);
+        logger.error(
+          { error, fundCik: row.fund_cik, reportDate: row.report_date },
+          "rebalance failed; persisting failed claim (manual intervention required to retry)"
+        );
+        markRebalanceRunFailed(this.db, row.fund_cik, row.report_date, message);
       }
```

**Defer checkpointing inside executeDiffs** — the CR comment also suggests checkpointing partial side effects (e.g., recording which `(fund_cik, report_date)` sells already executed). That's a heavier refactor: it requires adding a checkpoint table or columns, plus replay logic that skips completed sub-steps. Out of scope for a Critical correctness fix — the durable failed state alone prevents double-execution on retry by simply blocking the retry. Document the deferral in commit message.

## Task 5 (🟠 Major) — `queries.ts:475-490` refresh pnl_usd / pnl_ratio when applyPartialFill closes the row

**Problem.** When `applyPartialFill` closes the position (`MAX(0, quantity - filledQuantity) <= 0`), it sets `status = 'closed'` and `closed_at` but leaves `pnl_usd` and `pnl_ratio` at their last mark-to-market values. Downstream consumers reading the row's `pnl_usd` see stale unrealized P&L instead of the realized total.

**Fix.** Mirror `closeStockPosition`'s realized-totals expressions: when closing, set `pnl_usd = realized_pnl_usd + slicePnlUsd` and `pnl_ratio = total_realized_pnl / (avg_entry_price * total_realized_qty)` (guard against divide-by-zero). When not closing, leave `pnl_usd` / `pnl_ratio` untouched (the next `updateStockPositionMarket` poll refreshes them).

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
          status = CASE WHEN MAX(0, quantity - ?) <= 0 THEN 'closed' ELSE 'partial' END,
-         closed_at = CASE WHEN MAX(0, quantity - ?) <= 0 THEN CURRENT_TIMESTAMP ELSE closed_at END
+         closed_at = CASE WHEN MAX(0, quantity - ?) <= 0 THEN CURRENT_TIMESTAMP ELSE closed_at END,
+         pnl_usd = CASE
+           WHEN MAX(0, quantity - ?) <= 0
+             THEN COALESCE(realized_pnl_usd, 0) + COALESCE(?, 0)
+           ELSE pnl_usd
+         END,
+         pnl_ratio = CASE
+           WHEN MAX(0, quantity - ?) <= 0
+             AND avg_entry_price > 0
+             AND (COALESCE(realized_qty, 0) + ?) > 0
+             THEN (COALESCE(realized_pnl_usd, 0) + COALESCE(?, 0))
+                  / (avg_entry_price * (COALESCE(realized_qty, 0) + ?))
+           ELSE pnl_ratio
+         END
      WHERE id = ?`
-  ).run(filledQuantity, filledQuantity, slicePnlUsd ?? null, filledQuantity, filledQuantity, filledQuantity, positionId);
+  ).run(
+    filledQuantity,
+    filledQuantity,
+    slicePnlUsd ?? null,
+    filledQuantity,
+    filledQuantity,
+    filledQuantity,
+    filledQuantity,
+    slicePnlUsd ?? null,
+    filledQuantity,
+    filledQuantity,
+    slicePnlUsd ?? null,
+    filledQuantity,
+    positionId
+  );
 }
```

**Parameter count check.** Count `?` placeholders carefully and match the `.run()` argument list. If miscount → SQLite throws `RangeError: too many parameter values`. Run `npm test` to validate.

## Task 6 (🟠 Major) — `server.ts:54-56` heartbeat write failures must not crash process

**Problem.** Inside the `setInterval` callback at `server.ts:54-56`, `reply.raw.write(...)` is unguarded. When a client disconnects mid-heartbeat, the write throws, escapes the `setInterval` callback, and bubbles to the Node process — uncaught exception → crash. The `broadcastSSE` helper above already demonstrates the pattern: try/write, catch → remove client.

**Fix.** Wrap the heartbeat write in try/catch. On error: log, clear the timer, remove the client from `sseClients`. Mirror the cleanup the `close` handler does.

```diff
     const timer = setInterval(() => {
-      reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
+      try {
+        reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
+      } catch {
+        clearInterval(timer);
+        sseClients.delete(reply.raw);
+      }
     }, 15_000);
```

**No logger import added.** Fastify already logs through `server.log` and the catch is a known cleanup path on disconnect — silent removal matches `broadcastSSE`'s existing behavior at line 20-22. Don't introduce `logger` here just for symmetry; that's outside the scope of this finding.

## Skipped finding

- 🟡 **Minor** — `server.ts:15-16` (broadcastSSE JSON.stringify try/catch + logger.error). Not Critical/Major; payloads passed to broadcastSSE are constructed internally from typed inputs, not user data — `JSON.stringify` throwing is a developer bug, not a runtime hazard. Defer per stop rule.

## Verification

1. `npm test` — must remain 2/2 green.
2. `npm run build` — typecheck + emit, must pass.
3. **DO NOT commit, push, or restart services.** Report which files changed and final test count.

## Stop conditions

- Any test failure unexplained by these tasks → stop and report.
- Honor preserved decisions across all prior reviews.
- Files touched: `src/api/server.ts`, `src/db/queries.ts`, `src/db/schema.ts`, `src/execution/order-manager.ts`, `src/execution/position-monitor.ts`, `src/execution/rebalancer.ts`.
