=== src/db/queries.ts:397 ===
_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Allow `pnl_ratio` to be cleared when the caller passes `null`.**

`coalesce(?, pnl_ratio)` preserves the old ratio, so any guard that intentionally downgrades an invalid ratio to `null` can never clear a stale value from the row. That leaves bad ratios live in downstream stop/alert logic.

 
<details>
<summary>One safe way to preserve “omit” vs “explicitly clear” semantics</summary>

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
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/db/queries.ts` around lines 386 - 397, The updateStockPositionMarket
function currently uses coalesce(?, pnl_ratio) which prevents callers from
clearing pnl_ratio by passing explicit null; change the function to build the
UPDATE dynamically: collect SET clauses and parameters for each field only if
the input object actually has that property (use
Object.prototype.hasOwnProperty.call(input, 'pnlRatio') to detect explicit null
vs omitted), for pnl_ratio add the clause "pnl_ratio = ?" with the parameter
input.pnlRatio (allowing null to be written), and if the property is absent
leave the column out of the SET list; then prepare the assembled SQL and run
with the ordered params plus id. Ensure the same pattern is applied to other
fields if you need the same omit-vs-clear semantics.
```

</details>

<!-- fingerprinting:phantom:medusa:grasshopper -->

<!-- 4e71b3a2 -->

<!-- This is an auto-generated comment by CodeRabbit -->

=== src/db/queries.ts:459 ===
_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**`closeStockPosition()` closes the row without reducing `quantity`.**

A filled full exit ends up with `status = 'closed'` but the original share count still stored on the position. That corrupts historical position state and any reporting that sums quantities across closed positions.

 
<details>
<summary>Persist the final quantity transition in the same update</summary>

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
@@
-  ).run(
+  ).run(
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
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/db/queries.ts` around lines 427 - 459, The update in closeStockPosition
currently closes the position but never updates the stored quantity, leaving the
original share count intact; modify the SQL in closeStockPosition to set
quantity = COALESCE(realized_qty, 0) + COALESCE(?, 0) (or an equivalent
expression using the incoming sliceFilledQty) in the same UPDATE so the final
persisted quantity matches the new realized_qty, and adjust the parameter
placeholders and .run(...) arguments to pass sliceFilledQty at that placeholder
(keep the existing usages for realized_qty, pnl and pnl_ratio calculations but
add the extra sliceFilledQty parameter reference where you set quantity).
```

</details>

<!-- fingerprinting:phantom:medusa:grasshopper -->

<!-- 4e71b3a2 -->

<!-- This is an auto-generated comment by CodeRabbit -->

=== src/db/queries.ts:500 ===
_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Release reserved exit quantity when reconciliation fails.**

This helper marks the execution `failed`, but it never gives back the sell reservation. After a reconcile failure, `pending_exit_qty` stays inflated and can block later exits on the same position.

 
<details>
<summary>Centralize the reservation release here</summary>

```diff
 export function markExecutionReconcileFailed(db: Database.Database, executionId: number, reason: string) {
+  const execution = db.prepare(
+    "SELECT direction, position_id, quantity FROM stock_executions WHERE id = ?"
+  ).get(executionId) as
+    | { direction: string; position_id: number | null; quantity: number }
+    | undefined;
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
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/db/queries.ts` around lines 494 - 500, The function
markExecutionReconcileFailed currently marks stock_executions as failed but
doesn't release the sell reservation, leaving pending_exit_qty inflated; update
the SQL in markExecutionReconcileFailed to also decrement pending_exit_qty by
the reservation and clear that reservation on the same row (for example: SET
status='failed', notes=..., pending_exit_qty = GREATEST(0, pending_exit_qty -
COALESCE(reserved_exit_qty,0)), reserved_exit_qty = 0) so the pending exit is
released atomically; keep the same parameters (reason, executionId) and use
COALESCE/GREATEST to avoid negative values when updating stock_executions.
```

</details>

<!-- fingerprinting:phantom:medusa:grasshopper -->

<!-- 4e71b3a2 -->

<!-- This is an auto-generated comment by CodeRabbit -->

=== src/db/schema.ts:173 ===
_⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**Don’t stamp `completed_at` when the run is only being claimed.**

This row is marked completed at insert time, so a rebalance that fails after `markRebalanceRun()` is indistinguishable from one that finished successfully. That makes retries and audit state incorrect. Make `completed_at` nullable on insert and set it only after the rebalance actually completes.

 
<details>
<summary>Suggested schema direction</summary>

```diff
 CREATE TABLE IF NOT EXISTS rebalance_runs (
   fund_cik TEXT NOT NULL,
   report_date TEXT NOT NULL,
-  completed_at TEXT DEFAULT (datetime('now')),
+  completed_at TEXT,
   PRIMARY KEY (fund_cik, report_date)
 );
```

This needs a matching follow-up in the query/execution layer so the claim insert happens first, then `completed_at` is written only on success.
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/db/schema.ts` around lines 168 - 173, The schema sets completed_at to
datetime('now') on insert in the rebalance_runs table, which wrongly stamps runs
as completed when they are only claimed; modify the CREATE TABLE for
rebalance_runs so completed_at is nullable with no default (i.e. remove DEFAULT
(datetime('now'))), and update the execution layer so markRebalanceRun() only
inserts the claim without setting completed_at, then write completed_at (UPDATE
... SET completed_at = datetime('now')) from the rebalance completion path after
success; ensure the claim/insert and the completion update use the same primary
key (fund_cik, report_date) to correlate rows.
```

</details>

<!-- fingerprinting:phantom:medusa:grasshopper -->

<!-- 4e71b3a2 -->

<!-- This is an auto-generated comment by CodeRabbit -->

=== src/execution/order-manager.ts:180 ===
_⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_

**Reconcile late fills even when the terminal status is `cancelled` or `expired`.**

This only books sell deltas when `status === "filled" || status === "partial"`. If Alpaca returns a terminal order with extra `filled_qty` after the last poll, this branch releases the unfilled reservation but never applies the final delta to the position, so quantity, `pending_exit_qty`, and realized P&L drift out of sync.

<details>
<summary>Suggested direction</summary>

```diff
-      } else if ((status === "filled" || status === "partial") && execution.direction === "sell") {
+      } else if (execution.direction === "sell") {
         if (!execution.positionId) {
           ...
         }
         const position = findPositionById(this.db, execution.positionId);
         ...
         const totalFilledQty = money(order.filled_qty);
         const deltaQty = Math.max(0, totalFilledQty - previouslyFilledQty);
         if (deltaQty > 0) {
           ...
         }
+        if (status === "cancelled" || status === "expired") {
+          const unfilled = Math.max(0, execution.quantity - totalFilledQty);
+          if (unfilled > 0) addPendingExit(this.db, execution.positionId, -unfilled);
+          continue;
+        }
       } else if (this.shouldCancelByEndOfDay(execution.createdAt)) {
```
</details>

 

As per coding guidelines, `src/execution/**`: "This handles real money (paper trading but live execution path). Flag any logic that could corrupt P&L tracking, double-execute orders, or mis-attribute fills to wrong positions. Position lifecycle invariants are critical."

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/order-manager.ts` around lines 146 - 180, The cancel/expired
branch doesn't reconcile any late fills — compute totalFilledQty =
money(order.filled_qty) and deltaQty = Math.max(0, totalFilledQty -
previouslyFilledQty) (same as the filled/partial branch) before releasing
unfilled reservations; if deltaQty>0 apply the same logic: compute filledPrice,
slicePnlUsd, call trackWashSaleIfNeeded(position.ticker, slicePnlUsd) if needed,
adjust remainingAfter and then either closeStockPosition(this.db, position.id,
execution.triggerType ?? "manual", slicePnlUsd, deltaQty) or
applyPartialFill(this.db, position.id, deltaQty, slicePnlUsd) and if status was
filled call applyPostFillAction(this.db, execution.id); only after reconciling
delta apply addPendingExit and updateStockExecutionOrder and still call
alpaca.cancelOrder as appropriate.
```

</details>

<!-- fingerprinting:phantom:medusa:grasshopper -->

<!-- 4e71b3a2 -->

<!-- This is an auto-generated comment by CodeRabbit -->

=== src/execution/position-monitor.ts:68 ===
_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**The new pending-exit guard is incomplete.**

You gated take-profit/day60, but the hard-loss branch still calls `exit()` unconditionally. With the new `submitMarketExit()` availability check, a queued half-sell makes this throw instead of treating the position as already exiting. The same gap exists in `softStopTriggered()` below.

 

As per coding guidelines, `src/execution/**`: "This handles real money (paper trading but live execution path). Flag any logic that could corrupt P&L tracking, double-execute orders, or mis-attribute fills to wrong positions. Position lifecycle invariants are critical."

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-monitor.ts` around lines 58 - 68, The hard-loss branch
and the downstream softStopTriggered() path call exit() unconditionally even
when a pending exit is already queued; modify the senator branches in
positionMonitor (around activateTrailingStop, sellHalf, exit,
checkSenatorTimeStops) and the softStopTriggered() logic to first check that
(position.pendingExitQty ?? 0) === 0 and that submitMarketExit() (or the
equivalent market-exit availability check) permits submitting an exit before
calling exit() or sellHalf(); ensure the same pending-exit guard is applied
everywhere that could double-submit exits to preserve position lifecycle
invariants.
```

</details>

<!-- fingerprinting:phantom:medusa:grasshopper -->

<!-- 4e71b3a2 -->

<!-- This is an auto-generated comment by CodeRabbit -->

