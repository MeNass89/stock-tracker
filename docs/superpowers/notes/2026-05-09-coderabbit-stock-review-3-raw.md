**Actionable comments posted: 3**

> [!CAUTION]
> Some comments are outside the diff and can’t be posted inline due to platform limitations.
> 
> 
> 
> <details>
> <summary>⚠️ Outside diff range comments (3)</summary><blockquote>
> 
> <details>
> <summary>src/api/server.ts (1)</summary><blockquote>
> 
> `32-44`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
> 
> **SSE stream became heartbeat-only and lost real event delivery**
> 
> From Line [32] to Line [43], the route emits only heartbeat frames, and with the removed shared client registry/broadcast helper there is no path left to push actual updates. That breaks live event semantics.
> 
>  
> 
> <details>
> <summary>Proposed fix (restore broadcast path + cleanup on disconnect)</summary>
> 
> ```diff
> +import type { ServerResponse } from "node:http";
> +
> +const sseClients = new Set<ServerResponse>();
> +
> +export function broadcastSSE(data: unknown) {
> +  const payload = `data: ${JSON.stringify(data)}\n\n`;
> +  for (const client of sseClients) {
> +    client.write(payload);
> +  }
> +}
> +
>  export function buildServer() {
>    const server = Fastify({ logger: true, ignoreTrailingSlash: true });
> @@
>    server.get("/api/events", (_request, reply) => {
>      reply.hijack();
> @@
>      const timer = setInterval(() => {
>        reply.raw.write(`data: ${JSON.stringify({ type: "heartbeat", at: new Date().toISOString() })}\n\n`);
>      }, 15_000);
> -    reply.raw.on("close", () => { clearInterval(timer); });
> +    sseClients.add(reply.raw);
> +    reply.raw.on("close", () => {
> +      clearInterval(timer);
> +      sseClients.delete(reply.raw);
> +    });
>    });
> ```
> </details>
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/api/server.ts` around lines 32 - 44, The SSE route currently only sends
> heartbeats (in server.get("/api/events")) and no longer supports broadcasting
> real events; restore a client registry (e.g., a Set or Map named clients or
> sseClients) and a broadcast helper (e.g., broadcastEvent(event)) that iterates
> over registered reply.raw streams and writes proper SSE frames, register each
> new reply.raw when the connection opens, and on reply.raw "close" remove it from
> the registry and clearInterval(timer); ensure broadcastEvent formats messages
> like `data: JSON.stringify(...) \n\n` and handles broken streams by removing
> failed clients.
> ```
> 
> </details>
> 
> </blockquote></details>
> <details>
> <summary>src/execution/position-monitor.ts (1)</summary><blockquote>
> 
> `166-183`: _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_
> 
> **The senator time-stop path can queue duplicate exits.**
> 
> `day60ExitedHalf` is only flipped after fill, but `sellHalf()` always requests `position.quantity / 2`. On the next pass, that same half exit still passes `submitMarketExit` because `available` has only fallen to half. For 90+ day flat positions this method can then submit that half exit and immediately try a full `time_stop`, which now collides with the pending reservation. Make the day-90 branch exclusive and compute the day-60 sell against `pendingExitQty` (or skip while a `day60_half` exit is already pending).
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
> In `@src/execution/position-monitor.ts` around lines 166 - 183, The day-60
> half-sell and the day-90 full exit can both submit overlapping orders because
> sellHalf() always uses position.quantity/2 and day60ExitedHalf is only flipped
> after fill; update checkSenatorTimeStops so the day-90 branch is exclusive with
> the day-60 branch and compute the day-60 sell against outstanding pending exit
> quantity (or skip if a day60_half exit is already pending) before calling
> submitMarketExit. Concretely: in checkSenatorTimeStops, when ageDays >= 60
> verify pendingExitQty for the position (or a helper like
> orderManager.getPendingExitQty/position.pendingExitQty) and compute quantity =
> max(0, (position.quantity - pendingExitQty) / 2) or simply return/skip if a
> day60_half reservation exists; also mark the day60ExitedHalf sentinel
> (day60ExitedHalf or set markStockPositionTimeCheck with "day60_half" or call the
> same updater used elsewhere) at the time you submit the market exit (not only on
> fill) so subsequent runs won't re-submit the same half exit, and ensure the
> ageDays >= 90 full exit path checks that no day60_half reservation/pending exit
> exists before calling exit().
> ```
> 
> </details>
> 
> </blockquote></details>
> <details>
> <summary>src/execution/order-manager.ts (1)</summary><blockquote>
> 
> `128-175`: _⚠️ Potential issue_ | _🔴 Critical_ | _🏗️ Heavy lift_
> 
> **Partial sell fills are never booked until the order reaches `filled`.**
> 
> On a `partial` status, this updates the execution row but never applies the filled delta to the position or releases that slice of `pending_exit_qty`. If the order is cancelled or replaced before final fill, the already-filled shares remain unrecorded, so quantity/P&L drift and the replacement path can oversell or block later exits. Reconcile incremental sell fills before cancel/resubmit, and only replace the remaining quantity.
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
> In `@src/execution/order-manager.ts` around lines 128 - 175, The partial sell
> branch currently only updates the execution row and then may cancel/resubmit,
> leaving already-filled shares unrecorded; add handling for status === "partial"
> (when execution.direction === "sell") mirroring the filled-sell logic: after
> updateStockExecutionFill, look up the position with
> findPositionById(execution.positionId), log/flag if missing, compute filledPrice
> = money(order.filled_avg_price ?? undefined) and filledQty =
> money(order.filled_qty), compute slicePnlUsd and call
> trackWashSaleIfNeeded(position.ticker, slicePnlUsd) when negative, adjust
> pending exit quantities (use addPendingExit with the appropriate negative delta
> for the filledQty), then if remainingAfter <= 0 call closeStockPosition(this.db,
> position.id, execution.triggerType ?? "manual", slicePnlUsd, filledQty) else
> call applyPartialFill(this.db, position.id, filledQty, slicePnlUsd) and
> applyPostFillAction(this.db, execution.id); ensure this handling runs before any
> cancel/resubmit logic so partial fills are reconciled incrementally.
> ```
> 
> </details>
> 
> </blockquote></details>
> 
> </blockquote></details>

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

Inline comments:
In `@scripts/test-migration.ts`:
- Line 2: The script currently reuses a persistent path by calling
openDatabase("/tmp/stocktracker-test.db") which preserves schema state across
runs; change the migration probe to create a fresh temp file each run (or unlink
the existing file before opening) so the database starts empty—modify the
openDatabase call (the line that assigns db) to use a newly generated temp path
or delete the old file first to ensure each run tests migration from a clean DB
state.

In `@src/db/schema.ts`:
- Around line 198-224: The current runIdempotentMigrations loop relies on
parsing error messages for RENAME COLUMN statements; instead add an explicit
existence check for rename operations: before executing any RENAME COLUMN
statement in idempotentMigrations (e.g., the "ALTER TABLE stock_positions RENAME
COLUMN pnl_pct TO pnl_ratio" and "ALTER TABLE portfolio_snapshots RENAME COLUMN
daily_pnl_pct TO daily_pnl_ratio"), query pragma_table_info('<table>') to see if
the old column name exists and only execute the ALTER if present; leave other
statements to db.exec as-is inside runIdempotentMigrations and keep the existing
benign-error regex fallback for non-rename statements.

In `@src/execution/rebalancer.ts`:
- Around line 31-32: The current flow calls markRebalanceRun(this.db, fundCik,
reportDate) and then executeDiffs(...), but never marks completion or clears the
claim on failure, which causes permanent half-applied rebalances; modify the
logic so the claim is marked as "started" and then updated to "completed" on
success (or "failed"/cleared on error). Specifically, add a try/catch around
executeDiffs in rebalancer.ts where after markRebalanceRun(...) you call
executeDiffs(...); on success call a new/appropriate function (e.g.,
markRebalanceCompleted or updateRebalanceStatus) to record completion, and in
the catch call markRebalanceFailed or clear the claim (or revert the started
flag) before rethrowing so retries are possible; update usages near the existing
markRebalanceRun and executeDiffs calls (including the similar blocks at the
other ranges noted) to ensure every started claim is either completed or cleared
on error.

---

Outside diff comments:
In `@src/api/server.ts`:
- Around line 32-44: The SSE route currently only sends heartbeats (in
server.get("/api/events")) and no longer supports broadcasting real events;
restore a client registry (e.g., a Set or Map named clients or sseClients) and a
broadcast helper (e.g., broadcastEvent(event)) that iterates over registered
reply.raw streams and writes proper SSE frames, register each new reply.raw when
the connection opens, and on reply.raw "close" remove it from the registry and
clearInterval(timer); ensure broadcastEvent formats messages like `data:
JSON.stringify(...) \n\n` and handles broken streams by removing failed clients.

In `@src/execution/order-manager.ts`:
- Around line 128-175: The partial sell branch currently only updates the
execution row and then may cancel/resubmit, leaving already-filled shares
unrecorded; add handling for status === "partial" (when execution.direction ===
"sell") mirroring the filled-sell logic: after updateStockExecutionFill, look up
the position with findPositionById(execution.positionId), log/flag if missing,
compute filledPrice = money(order.filled_avg_price ?? undefined) and filledQty =
money(order.filled_qty), compute slicePnlUsd and call
trackWashSaleIfNeeded(position.ticker, slicePnlUsd) when negative, adjust
pending exit quantities (use addPendingExit with the appropriate negative delta
for the filledQty), then if remainingAfter <= 0 call closeStockPosition(this.db,
position.id, execution.triggerType ?? "manual", slicePnlUsd, filledQty) else
call applyPartialFill(this.db, position.id, filledQty, slicePnlUsd) and
applyPostFillAction(this.db, execution.id); ensure this handling runs before any
cancel/resubmit logic so partial fills are reconciled incrementally.

In `@src/execution/position-monitor.ts`:
- Around line 166-183: The day-60 half-sell and the day-90 full exit can both
submit overlapping orders because sellHalf() always uses position.quantity/2 and
day60ExitedHalf is only flipped after fill; update checkSenatorTimeStops so the
day-90 branch is exclusive with the day-60 branch and compute the day-60 sell
against outstanding pending exit quantity (or skip if a day60_half exit is
already pending) before calling submitMarketExit. Concretely: in
checkSenatorTimeStops, when ageDays >= 60 verify pendingExitQty for the position
(or a helper like orderManager.getPendingExitQty/position.pendingExitQty) and
compute quantity = max(0, (position.quantity - pendingExitQty) / 2) or simply
return/skip if a day60_half reservation exists; also mark the day60ExitedHalf
sentinel (day60ExitedHalf or set markStockPositionTimeCheck with "day60_half" or
call the same updater used elsewhere) at the time you submit the market exit
(not only on fill) so subsequent runs won't re-submit the same half exit, and
ensure the ageDays >= 90 full exit path checks that no day60_half
reservation/pending exit exists before calling exit().
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

**Run ID**: `dcb29916-4818-4556-b98b-bc1d51d39325`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 80f071a6ddb588d38925e3e9bdc7231a64c13a05 and d19060ad6ecde7305854397c0de19f4a8c622f76.

</details>

<details>
<summary>⛔ Files ignored due to path filters (3)</summary>

* `data/launchd-stderr.log` is excluded by `!**/*.log`, `!**/*.log`, `!data/**`
* `data/launchd-stdout.log` is excluded by `!**/*.log`, `!**/*.log`, `!data/**`
* `data/stock-tracker.sqlite` is excluded by `!data/**`

</details>

<details>
<summary>📒 Files selected for processing (26)</summary>

* `.coderabbit.yaml`
* `.env.example`
* `.gitignore`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-2-raw.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-2.md`
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

* src/ranking/backtester.ts
* tests/parsing/form4-parser.test.ts
* src/ingestion/capitol-trades.ts
* package.json
* src/ingestion/unusual-whales.ts
* src/parsing/form4-parser.ts
* src/ingestion/senate-efd.ts
* src/config.ts
* .env.example
* src/tracking/portfolio-diff.ts
* src/parsing/ptr-parser.ts
* scripts/backtest.ts

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
