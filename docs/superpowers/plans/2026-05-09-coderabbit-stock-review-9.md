# CodeRabbit review #9 — execution plan

**PR:** MeNass89/stock-tracker#1 — review submitted 2026-05-09T21:00:34Z against `b0aab31`.
**Findings:** 2 🟠 Major + 1 🟡 Minor (skipped per stop conditions).
**Stop conditions:** 0 Critical + 0 Major NEW. Honor preserved decisions from reviews #1–#8.

## Preserved decisions (do not regress)

- Atomic `markRebalanceRun` claim, `completeRebalanceRun`, `markRebalanceRunFailed` (durable failed state).
- SSE broadcast helper + named `heartbeat` event with try/catch + clearInterval + sseClients delete on write failure.
- `pendingExitQty` reservation, `applyPartialFill`, `applyPostFillAction`, `markExecutionReconcileFailed`.
- `addPendingExit` SQL clamps at zero via `MAX(0, COALESCE(pending_exit_qty, 0) + ?)` (iter 8).
- `softStopTriggered` gates: `!stopLossOrderId && !trailingStopOrderId && !pendingExitQty`.
- `stopLossFilled` rejected/expired clears stale ids via direct prepared statement + mirrors mutation onto `position`.
- `activateTrailingStop` returns on cancelOrder failure; clears `stop_loss_order_id` in single prepared UPDATE.
- Senator/13f branches: bail out of discretionary actions when `stopLossOrderId || trailingStopOrderId` is present.
- `stopLossFilled` filled branch: route through `applyPartialFill` when `filledQty < position.quantity`.
- `monitorOrders` EOD: cancelOrder request marks notes only, defers reconciliation.
- `handleFlashCrash` persists DB only after Alpaca confirms.
- `trackWashSaleIfNeeded` cooldown anchored to fill date in UTC.
- `updateHealth` try/catch per source + canonical kebab-case source IDs `[["edgar"], ["quiver"], ["house-clerk"]] as const` (iter 8).
- `checkSenatorTimeStops` day-60 branch bounded to `60 ≤ ageDays < 90` (iter 8).

## Task 1 (🟠 Major) — `src/api/server.ts:15-24` guard SSE serialization

**Problem.** `broadcastSSE(event, data)` calls `JSON.stringify(data)` *before* the per-client write loop. If `data` contains non-serializable content (BigInt, circular refs, custom objects with throwing toJSON), the throw aborts the whole broadcast — every connected SSE client misses the update, not just the one with bad data. SSE delivery is the live-update channel for the dashboard; silent serialization-induced drops are a real regression.

**Fix.** Serialize inside try/catch *before* building the frame, fall back to `"null"` on failure so the frame is still well-formed and the loop still runs:

```diff
 export function broadcastSSE(event: string, data: unknown) {
-  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
+  let serialized = "null";
+  try {
+    serialized = JSON.stringify(data);
+  } catch {
+    // Keep the broadcast path alive on non-serializable payloads.
+  }
+  const payload = `event: ${event}\ndata: ${serialized}\n\n`;
   for (const client of sseClients) {
     try {
       client.write(payload);
     } catch {
       sseClients.delete(client);
     }
   }
 }
```

**Why `"null"` is safe.** SSE consumers parse `data` as JSON via `JSON.parse(event.data)`. `null` is a valid JSON value; the consumer sees the named event fire with payload `null` and can skip it. Better than dropping the entire fan-out.

## Task 2 (🟠 Major) — `src/db/schema.ts:193-197` add index on `stock_executions.position_id`

**Problem.** `position_id` was added as a foreign key on `stock_executions` (line 99) used for execution→position reconciliation lookups (e.g., `pendingStockExecutions` joins, `applyPartialFill` lookups by execution). No index exists on this column. As `stock_executions` grows (one row per submitted/filled order), every reconcile pass forces a full table scan. SQLite does **not** auto-create indexes on FK columns — only on the parent's PRIMARY KEY.

**Fix.** Add the index in the bootstrap `schemaSql` block alongside the other `idx_stock_exec_*` indexes, and append a matching `CREATE INDEX IF NOT EXISTS` to `idempotentMigrations` so existing prod DBs (e.g., `data/stock-tracker.sqlite`) get the index on next `openDatabase()`.

Bootstrap (line ~194):

```diff
 CREATE INDEX IF NOT EXISTS idx_stock_exec_status ON stock_executions(status);
 CREATE INDEX IF NOT EXISTS idx_stock_exec_ticker ON stock_executions(ticker);
+CREATE INDEX IF NOT EXISTS idx_stock_exec_position_id ON stock_executions(position_id);
 CREATE INDEX IF NOT EXISTS idx_stock_pos_status ON stock_positions(status);
```

Idempotent migrations array (after the existing rebalance_runs entries, before the closing `];`):

```diff
   "ALTER TABLE rebalance_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'in_progress'",
-  "ALTER TABLE rebalance_runs ADD COLUMN last_error TEXT"
+  "ALTER TABLE rebalance_runs ADD COLUMN last_error TEXT",
+  "CREATE INDEX IF NOT EXISTS idx_stock_exec_position_id ON stock_executions(position_id)"
 ];
```

**Why both places.** `db.exec(schemaSql)` runs first (CREATE TABLE … IF NOT EXISTS skips for existing tables), so the new index line in `schemaSql` only fires for fresh DBs. `runIdempotentMigrations` runs after; `CREATE INDEX IF NOT EXISTS` is itself idempotent and the `benign` regex in `runIdempotentMigrations` catches any benign-shaped failure. Adding to both keeps fresh DBs and migrated DBs in lockstep.

## Skipped finding

- 🟡 **Minor** — `scripts/test-migration.ts:2` reuses `/tmp/stocktracker-test.db` across runs. Test-script-only hygiene; doesn't affect product correctness. Defer per stop conditions (Minor not counted).

## Verification

1. `npm test` — must remain 2/2 green.
2. `npm run build` — typecheck + emit, must pass.
3. **DO NOT commit, push, or restart services.** Report which files changed and final test count.

## Stop conditions

- Any test failure unexplained by these tasks → stop and report.
- Honor preserved decisions across all prior reviews.
- Files touched: `src/api/server.ts`, `src/db/schema.ts`.
