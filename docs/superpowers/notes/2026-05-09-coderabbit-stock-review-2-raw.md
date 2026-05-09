**Actionable comments posted: 5**

<details>
<summary>♻️ Duplicate comments (1)</summary><blockquote>

<details>
<summary>src/execution/order-manager.ts (1)</summary><blockquote>

`147-157`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Reconciliation failures now mark the execution but do not release `pending_exit_qty`.**

This partially addresses the past review. The execution status is correctly set to `failed` (line 149/155), but the position's `pending_exit_qty` remains inflated from the prior `addPendingExit` call. This blocks future exits from that quantity until manual cleanup.

Consider decrementing `pending_exit_qty` when reconciliation fails:

```ts
markExecutionReconcileFailed(this.db, execution.id, "...");
// Also release the pending quantity
this.db.prepare("UPDATE stock_positions SET pending_exit_qty = MAX(0, pending_exit_qty - ?) WHERE id = ?")
  .run(execution.quantity, execution.positionId);
```

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/order-manager.ts` around lines 147 - 157, The reconciliation
failure paths (when execution.positionId is missing or when findPositionById
returns null) currently call markExecutionReconcileFailed but do not release the
previously reserved pending exit quantity, leaving pending_exit_qty inflated;
after calling markExecutionReconcileFailed in those branches, execute a DB
update that decrements the position's pending_exit_qty by execution.quantity
(clamped at zero) for the position id (use this.db and the positionId from
execution) so the pending_exit_qty is reduced (e.g., UPDATE stock_positions SET
pending_exit_qty = MAX(0, pending_exit_qty - ?) WHERE id = ?) to avoid blocking
future exits — apply this in both places where markExecutionReconcileFailed is
invoked for sells.
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
- Around line 466-481: The update in applyPartialFill must also set closed_at
when the position becomes closed; modify the SET clause in the SQL inside
applyPartialFill to include closed_at = CASE WHEN MAX(0, quantity - ?) <= 0 THEN
CURRENT_TIMESTAMP ELSE closed_at END so closed_at is populated on full close and
preserved on partial fills, keeping the existing run(...) parameters
(filledQuantity, filledQuantity, slicePnlUsd ?? null, filledQuantity,
filledQuantity, positionId) in the same order.

In `@src/execution/order-manager.ts`:
- Around line 188-228: The code has a race where findPositionById reads
pendingExitQty and addPendingExit is only called after awaiting
this.alpaca.submitOrder, allowing concurrent exits to oversubscribe a position;
to fix, reserve the quantity before yielding by calling addPendingExit(this.db,
positionId, quantity) immediately after insertStockExecution (and before
awaiting this.alpaca.submitOrder), and if submitOrder throws rollback that
reservation (call an existing removePendingExit or addPendingExit with
-quantity, or implement removePendingExit) inside the catch before
updateStockExecutionOrder; keep the existing availability check
(findPositionById) but ensure the reservation step and rollback reference the
same executionId/positionId so concurrent submitMarketExit invocations are
serialized logically.

In `@src/execution/position-monitor.ts`:
- Around line 97-99: The soft-stop path computes pnlRatio by dividing by
position.avgEntryPrice without a zero/null guard; update the code in
position-monitor (the block that calls this.alert("stop_triggered", position, {
exitReason: "soft_stop", pnlUsd, pnlRatio })) to check position.avgEntryPrice
for null/undefined/zero before dividing (same approach used earlier around line
39), and set pnlRatio to a safe fallback (e.g., 0 or null) when avgEntryPrice is
falsy to avoid division-by-zero; keep pnlUsd calculation as-is but ensure the
alert payload uses the guarded pnlRatio.
- Around line 39-40: The pnlRatio calculation divides by position.avgEntryPrice
without guarding against zero, producing NaN/Infinity and breaking downstream
comparisons; change the logic in position-monitor.ts so that before dividing you
check position.avgEntryPrice (e.g., if it's null/undefined or <= 0) and set
pnlRatio to null (same fallback used at line 123) instead of performing the
division, then pass that safe pnlRatio into updateStockPositionMarket along with
currentPrice, pnlUsd, and position.id; reference symbols: pnlRatio,
position.avgEntryPrice, updateStockPositionMarket, position.id, currentPrice,
pnlUsd.

In `@src/execution/rebalancer.ts`:
- Line 27: The current flow checks hasRebalanceRun early and only calls
markRebalanceRun after orders complete, causing a TOCTOU race where multiple
processes can submit orders; instead perform an atomic "claim" before any order
submission by calling markRebalanceRun (which should perform the INSERT and
return whether it succeeded) at the start of the rebalance path and only proceed
to submitOrders if markRebalanceRun returned true; remove reliance on the
earlier hasRebalanceRun check as the claim covers it, and eliminate or shorten
the 30-second sleep that widens the window (adjust code paths around
hasRebalanceRun, markRebalanceRun, and submitOrders to enforce
claim-before-execute atomicity).

---

Duplicate comments:
In `@src/execution/order-manager.ts`:
- Around line 147-157: The reconciliation failure paths (when
execution.positionId is missing or when findPositionById returns null) currently
call markExecutionReconcileFailed but do not release the previously reserved
pending exit quantity, leaving pending_exit_qty inflated; after calling
markExecutionReconcileFailed in those branches, execute a DB update that
decrements the position's pending_exit_qty by execution.quantity (clamped at
zero) for the position id (use this.db and the positionId from execution) so the
pending_exit_qty is reduced (e.g., UPDATE stock_positions SET pending_exit_qty =
MAX(0, pending_exit_qty - ?) WHERE id = ?) to avoid blocking future exits —
apply this in both places where markExecutionReconcileFailed is invoked for
sells.
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

**Run ID**: `b7436c2b-d2c7-4e23-a3f2-2f33b6c4d126`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 80f071a6ddb588d38925e3e9bdc7231a64c13a05 and bf44752ebce1da05a18d1f69e9781b1d4362fa52.

</details>

<details>
<summary>⛔ Files ignored due to path filters (3)</summary>

* `data/launchd-stderr.log` is excluded by `!**/*.log`, `!**/*.log`, `!data/**`
* `data/launchd-stdout.log` is excluded by `!**/*.log`, `!**/*.log`, `!data/**`
* `data/stock-tracker.sqlite` is excluded by `!data/**`

</details>

<details>
<summary>📒 Files selected for processing (24)</summary>

* `.coderabbit.yaml`
* `.env.example`
* `.gitignore`
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

* tests/parsing/form4-parser.test.ts
* src/ranking/backtester.ts
* src/ingestion/unusual-whales.ts
* .env.example
* scripts/backtest.ts
* src/parsing/form4-parser.ts
* src/tracking/portfolio-diff.ts
* src/ingestion/senate-efd.ts
* src/ingestion/capitol-trades.ts
* src/config.ts
* src/parsing/ptr-parser.ts
* package.json

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
