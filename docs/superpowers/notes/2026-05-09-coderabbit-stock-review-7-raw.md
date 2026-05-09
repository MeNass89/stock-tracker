**Actionable comments posted: 7**

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

Inline comments:
In `@src/api/server.ts`:
- Line 55: The heartbeat setInterval callback currently calls
reply.raw.write(...) unguarded; wrap that write in a try-catch like
broadcastSSE() does: inside the interval callback catch any errors from
reply.raw.write, clear the interval timer, and remove the client from your SSE
client tracking collection so the failed connection is cleaned up; reference the
setInterval callback that uses reply.raw.write and mirror the error-handling
pattern used in broadcastSSE() to avoid uncaught exceptions.
- Around line 15-16: The broadcastSSE function's JSON.stringify(data) can throw
and abort broadcasting; import the logger used across the project at the top of
the file and wrap the serialization in a try/catch inside broadcastSSE
(referencing broadcastSSE and the payload variable), on catch call logger.error
with the error and a clear message, then fall back to a safe serialized
representation (e.g., "{}" or "null") so you still build a valid payload and
continue the broadcast to clients.

In `@src/db/queries.ts`:
- Around line 475-490: applyPartialFill currently marks a position 'closed' and
sets closed_at when quantity reaches zero but does not refresh mark-to-market
metrics (pnl_usd, pnl_ratio), leaving stale values; modify applyPartialFill's
UPDATE to mirror closeStockPosition by updating pnl_usd and pnl_ratio to the
realized totals in the CASE branch that closes the row (use the same
expressions/columns closeStockPosition uses and pass slicePnlUsd and any
required ratio parameter into the prepared statement) so the row's
pnl_usd/pnl_ratio reflect the realized values when status becomes 'closed'.

In `@src/execution/order-manager.ts`:
- Around line 180-187: The code currently treats alpaca.cancelOrder(...) as
terminal and immediately calls updateStockExecutionOrder(..., {status:
"cancelled", ...}), which removes the row from pendingStockExecutions() and
prevents monitorOrders() from reconciling late fills; instead, when
shouldCancelByEndOfDay(execution.createdAt) is true call
alpaca.cancelOrder(execution.alpacaOrderId) but do NOT update status to
"cancelled" or release reserves yet—leave the execution in "submitted" or
"partial" (or mark a transient "cancelling" flag) so it remains returned by
pendingStockExecutions(), then let monitorOrders() observe the broker's terminal
response (cancelled/expired/filled) and only in that code path call
updateStockExecutionOrder(...) and addPendingExit(...) to release any unfilled
quantity; modify the branch around alpaca.cancelOrder,
updateStockExecutionOrder, and addPendingExit accordingly and ensure
monitorOrders() handles the new transient state.

In `@src/execution/position-monitor.ts`:
- Around line 58-68: The senator branch can submit overlapping sell orders
because it may activateTrailingStop or call sellHalf/exit while a live stop is
still present; update the logic in the position.sleeve === "senator" block to
first check for active resting stops (use stopLossOrderId and
trailingStopOrderId and the stopLossFilled() helper) and bail out early if
either stop id exists or stopLossFilled() is still pending, or explicitly cancel
the existing stop order(s) before performing any discretionary action; apply
this guard before calling activateTrailingStop, sellHalf, exit, or
checkSenatorTimeStops so no discretionary exit is queued while a working stop
order is present.
- Around line 139-145: The code always calls closeStockPosition(...) which fully
closes the position even when only a floor(quantity) stop was submitted; change
the logic in the block that computes filledPrice/filledQty/pnlUsd/pnlRatio so
that if filledQty < position.quantity you call applyPartialFill(this.db,
position.id, filledQty, pnlUsd, exitReason) (or an equivalent partial-fill
helper) and only call closeStockPosition(this.db, position.id, exitReason,
pnlUsd, filledQty) when filledQty >= position.quantity (or remaining quantity
after the fill is zero); keep the existing wash-sale tracking call
(this.trackWashSaleIfNeeded) but pass the fill timestamp and ensure you use the
same filledQty used for the partial/full handling, and reference the existing
symbols filled_qty/order.filled_qty, position.quantity, closeStockPosition,
applyPartialFill, submitStopLoss, and activateTrailingStop when making the fix.

In `@src/execution/rebalancer.ts`:
- Around line 31-38: The current flow calls clearRebalanceRun(...) in the catch
block which deletes the claim and allows retries that can double-submit orders;
instead, change the claim lifecycle to use durable states (e.g.,
markRebalanceRun(...) -> set status "in_progress", on success call
completeRebalanceRun(...), and on failure update the row to status "failed" with
an error/checkpoint) and add checkpointing inside executeDiffs(...) so partial
external side effects are recorded; update the catch path to persist a
failed/in_progress state (and last successful checkpoint) rather than calling
clearRebalanceRun(...) so retries can resume safely without re-submitting
completed buys/sells.
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

**Run ID**: `ce60a948-485a-4799-85e1-570986c60ca0`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 80f071a6ddb588d38925e3e9bdc7231a64c13a05 and 52ec11363de4a1c7c35a8ca526e6e934c47eb470.

</details>

<details>
<summary>⛔ Files ignored due to path filters (3)</summary>

* `data/launchd-stderr.log` is excluded by `!**/*.log`, `!**/*.log`, `!data/**`
* `data/launchd-stdout.log` is excluded by `!**/*.log`, `!**/*.log`, `!data/**`
* `data/stock-tracker.sqlite` is excluded by `!data/**`

</details>

<details>
<summary>📒 Files selected for processing (35)</summary>

* `.coderabbit.yaml`
* `.env.example`
* `.gitignore`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-2-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-3-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-4-inline.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-4-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-5-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-6-raw.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-2.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-3.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-4.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-5.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-6.md`
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
* scripts/backtest.ts
* src/config.ts
* package.json
* src/parsing/ptr-parser.ts
* src/ranking/backtester.ts
* src/parsing/form4-parser.ts
* .env.example
* src/ingestion/senate-efd.ts
* src/ingestion/capitol-trades.ts
* src/ingestion/unusual-whales.ts
* src/tracking/portfolio-diff.ts

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
