**Actionable comments posted: 6**

> [!CAUTION]
> Some comments are outside the diff and can’t be posted inline due to platform limitations.
> 
> 
> 
> <details>
> <summary>⚠️ Outside diff range comments (1)</summary><blockquote>
> 
> <details>
> <summary>src/execution/rebalancer.ts (1)</summary><blockquote>
> 
> `67-79`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
> 
> **Cross-fund full exits are re-queued in the generic sell pass.**
> 
> `exitTicker()` can reserve full exits for a ticker, and then the same `exit` holdings still flow into `sells`/`rebalanceSell()`. With the new `submitMarketExit()` availability check, that second pass throws on `pendingExitQty` and aborts the rebalance after some orders were already submitted.
> 
> <details>
> <summary>Suggested direction</summary>
> 
> ```diff
>    private async executeDiffs(diffs: FundHoldingInput[], fundCik: string, reportDate: string) {
> -    const exitsByTicker = this.crossFundExits(diffs);
> +    const exitsByTicker = this.crossFundExits(diffs);
> +    const fullyExitedTickers = new Set<string>();
>      for (const [ticker, count] of exitsByTicker) {
> -      if (count >= 2) await this.exitTicker(ticker, "fund_exit");
> +      if (count >= 2) {
> +        fullyExitedTickers.add(ticker);
> +        await this.exitTicker(ticker, "fund_exit");
> +      }
>      }
>  
> -    const sells = diffs.filter((holding) => holding.changeType === "exit" || (holding.changeType === "decrease" && Math.abs(holding.changePct ?? 0) >= 0.25));
> +    const sells = diffs.filter((holding) => {
> +      const ticker = holding.ticker?.toUpperCase();
> +      if (ticker && fullyExitedTickers.has(ticker)) return false;
> +      return holding.changeType === "exit" || (holding.changeType === "decrease" && Math.abs(holding.changePct ?? 0) >= 0.25);
> +    });
> ```
> </details>
> 
>  
> 
> As per coding guidelines, `src/execution/**`: "This handles real money (paper trading but live execution path). Flag any logic that could corrupt P&L tracking, double-execute orders, or mis-attribute fills to wrong positions. Position lifecycle invariants are critical."
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/execution/rebalancer.ts` around lines 67 - 79, The loop that calls
> exitTicker after computing exitsByTicker can reserve full exits, but the
> subsequent sells array still includes those same exit holdings and they get
> passed to rebalanceSell, causing submitMarketExit() to error on pendingExitQty;
> fix by tracking which tickers were reserved and removing those holdings from the
> sells pass: when iterating exitsByTicker and calling exitTicker(ticker,
> "fund_exit"), add that ticker to a reservedTickers Set (use the exitsByTicker
> variable and the exitTicker call), then redefine/filter the sells array to
> exclude holdings whose holding.ticker is in reservedTickers before calling
> rebalanceSell; ensure symbols mentioned (crossFundExits, exitsByTicker,
> exitTicker, reservedTickers, sells, rebalanceSell, submitMarketExit,
> pendingExitQty) are used so the change is easy to locate.
> ```
> 
> </details>
> 
> </blockquote></details>
> 
> </blockquote></details>

<details>
<summary>♻️ Duplicate comments (1)</summary><blockquote>

<details>
<summary>src/execution/order-manager.ts (1)</summary><blockquote>

`163-170`: _⚠️ Potential issue_ | _🟠 Major_ | _🏗️ Heavy lift_

**Final close still records only the last fill slice.**

`closeStockPosition()` is still fed `slicePnlUsd` and `deltaQty` from the current increment only. After one or more `applyPartialFill()` calls, that understates the closed position's realized P&L/performance because the earlier realized slices are not included in the final close payload. The same bug is repeated in Lines 246-255 for immediately filled exits.

  

As per coding guidelines, `src/execution/**`: "This handles real money (paper trading but live execution path). Flag any logic that could corrupt P&L tracking, double-execute orders, or mis-attribute fills to wrong positions. Position lifecycle invariants are critical."

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/order-manager.ts` around lines 163 - 170, The final close is
using only the current slice (slicePnlUsd, deltaQty) so earlier partial-fill
amounts are omitted; before calling closeStockPosition you must compute
cumulative closed quantity and cumulative realized P&L for this position
(including prior partial fills) and pass those totals instead of the
single-slice values. Concretely: in the branch where remainingAfter <= 0, fetch
the up-to-date position/fills state (or compute totalClosedQty =
originalPositionQty - remainingAfter and totalClosedPnl = sum of all slice pnl
for this position/exit by querying the DB or position realized fields) and call
closeStockPosition(this.db, position.id, execution.triggerType ?? "manual",
totalClosedPnl, totalClosedQty); keep applyPartialFill/use of slice values for
partial branches and still call applyPostFillAction(execution.id) when status
=== "filled".
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
- Around line 386-397: The updateStockPositionMarket function currently uses
coalesce(?, pnl_ratio) which prevents callers from clearing pnl_ratio by passing
explicit null; change the function to build the UPDATE dynamically: collect SET
clauses and parameters for each field only if the input object actually has that
property (use Object.prototype.hasOwnProperty.call(input, 'pnlRatio') to detect
explicit null vs omitted), for pnl_ratio add the clause "pnl_ratio = ?" with the
parameter input.pnlRatio (allowing null to be written), and if the property is
absent leave the column out of the SET list; then prepare the assembled SQL and
run with the ordered params plus id. Ensure the same pattern is applied to other
fields if you need the same omit-vs-clear semantics.
- Around line 494-500: The function markExecutionReconcileFailed currently marks
stock_executions as failed but doesn't release the sell reservation, leaving
pending_exit_qty inflated; update the SQL in markExecutionReconcileFailed to
also decrement pending_exit_qty by the reservation and clear that reservation on
the same row (for example: SET status='failed', notes=..., pending_exit_qty =
GREATEST(0, pending_exit_qty - COALESCE(reserved_exit_qty,0)), reserved_exit_qty
= 0) so the pending exit is released atomically; keep the same parameters
(reason, executionId) and use COALESCE/GREATEST to avoid negative values when
updating stock_executions.
- Around line 427-459: The update in closeStockPosition currently closes the
position but never updates the stored quantity, leaving the original share count
intact; modify the SQL in closeStockPosition to set quantity =
COALESCE(realized_qty, 0) + COALESCE(?, 0) (or an equivalent expression using
the incoming sliceFilledQty) in the same UPDATE so the final persisted quantity
matches the new realized_qty, and adjust the parameter placeholders and
.run(...) arguments to pass sliceFilledQty at that placeholder (keep the
existing usages for realized_qty, pnl and pnl_ratio calculations but add the
extra sliceFilledQty parameter reference where you set quantity).

In `@src/db/schema.ts`:
- Around line 168-173: The schema sets completed_at to datetime('now') on insert
in the rebalance_runs table, which wrongly stamps runs as completed when they
are only claimed; modify the CREATE TABLE for rebalance_runs so completed_at is
nullable with no default (i.e. remove DEFAULT (datetime('now'))), and update the
execution layer so markRebalanceRun() only inserts the claim without setting
completed_at, then write completed_at (UPDATE ... SET completed_at =
datetime('now')) from the rebalance completion path after success; ensure the
claim/insert and the completion update use the same primary key (fund_cik,
report_date) to correlate rows.

In `@src/execution/order-manager.ts`:
- Around line 146-180: The cancel/expired branch doesn't reconcile any late
fills — compute totalFilledQty = money(order.filled_qty) and deltaQty =
Math.max(0, totalFilledQty - previouslyFilledQty) (same as the filled/partial
branch) before releasing unfilled reservations; if deltaQty>0 apply the same
logic: compute filledPrice, slicePnlUsd, call
trackWashSaleIfNeeded(position.ticker, slicePnlUsd) if needed, adjust
remainingAfter and then either closeStockPosition(this.db, position.id,
execution.triggerType ?? "manual", slicePnlUsd, deltaQty) or
applyPartialFill(this.db, position.id, deltaQty, slicePnlUsd) and if status was
filled call applyPostFillAction(this.db, execution.id); only after reconciling
delta apply addPendingExit and updateStockExecutionOrder and still call
alpaca.cancelOrder as appropriate.

In `@src/execution/position-monitor.ts`:
- Around line 58-68: The hard-loss branch and the downstream softStopTriggered()
path call exit() unconditionally even when a pending exit is already queued;
modify the senator branches in positionMonitor (around activateTrailingStop,
sellHalf, exit, checkSenatorTimeStops) and the softStopTriggered() logic to
first check that (position.pendingExitQty ?? 0) === 0 and that
submitMarketExit() (or the equivalent market-exit availability check) permits
submitting an exit before calling exit() or sellHalf(); ensure the same
pending-exit guard is applied everywhere that could double-submit exits to
preserve position lifecycle invariants.

---

Outside diff comments:
In `@src/execution/rebalancer.ts`:
- Around line 67-79: The loop that calls exitTicker after computing
exitsByTicker can reserve full exits, but the subsequent sells array still
includes those same exit holdings and they get passed to rebalanceSell, causing
submitMarketExit() to error on pendingExitQty; fix by tracking which tickers
were reserved and removing those holdings from the sells pass: when iterating
exitsByTicker and calling exitTicker(ticker, "fund_exit"), add that ticker to a
reservedTickers Set (use the exitsByTicker variable and the exitTicker call),
then redefine/filter the sells array to exclude holdings whose holding.ticker is
in reservedTickers before calling rebalanceSell; ensure symbols mentioned
(crossFundExits, exitsByTicker, exitTicker, reservedTickers, sells,
rebalanceSell, submitMarketExit, pendingExitQty) are used so the change is easy
to locate.

---

Duplicate comments:
In `@src/execution/order-manager.ts`:
- Around line 163-170: The final close is using only the current slice
(slicePnlUsd, deltaQty) so earlier partial-fill amounts are omitted; before
calling closeStockPosition you must compute cumulative closed quantity and
cumulative realized P&L for this position (including prior partial fills) and
pass those totals instead of the single-slice values. Concretely: in the branch
where remainingAfter <= 0, fetch the up-to-date position/fills state (or compute
totalClosedQty = originalPositionQty - remainingAfter and totalClosedPnl = sum
of all slice pnl for this position/exit by querying the DB or position realized
fields) and call closeStockPosition(this.db, position.id, execution.triggerType
?? "manual", totalClosedPnl, totalClosedQty); keep applyPartialFill/use of slice
values for partial branches and still call applyPostFillAction(execution.id)
when status === "filled".
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

**Run ID**: `3c8efad6-7cbe-4c29-bc2c-a243a4b8c887`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 80f071a6ddb588d38925e3e9bdc7231a64c13a05 and 7aefeaa4d52b02844d43066ed85180bc75a77c38.

</details>

<details>
<summary>⛔ Files ignored due to path filters (3)</summary>

* `data/launchd-stderr.log` is excluded by `!**/*.log`, `!**/*.log`, `!data/**`
* `data/launchd-stdout.log` is excluded by `!**/*.log`, `!**/*.log`, `!data/**`
* `data/stock-tracker.sqlite` is excluded by `!data/**`

</details>

<details>
<summary>📒 Files selected for processing (28)</summary>

* `.coderabbit.yaml`
* `.env.example`
* `.gitignore`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-2-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-3-raw.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-2.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-3.md`
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
* src/ingestion/capitol-trades.ts
* src/parsing/form4-parser.ts
* scripts/backtest.ts
* src/parsing/ptr-parser.ts
* src/ingestion/senate-efd.ts
* package.json
* src/tracking/portfolio-diff.ts
* src/ranking/backtester.ts
* src/ingestion/unusual-whales.ts
* src/config.ts
* .env.example

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
