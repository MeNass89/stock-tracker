# CodeRabbit Stock-Tracker Review #3 — Codex Execution Plan

**Trigger:** PR #1 review submitted 2026-05-09 19:13:45Z against commit `d19060a`.
**Review payload:** `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-3-raw.md`.
**Counts:** 3 outside-diff actionable + 3 inline. Severity: 2 Critical, 2 Major, 1 Minor, 1 Trivial-Nitpick.

## Triage

| # | Path | Severity | Decision |
|---|------|----------|----------|
| 1 | `src/api/server.ts:32-44` | 🟠 Major | APPLY — SSE stream is heartbeat-only, frontend `useRealTime.ts:9` consumes `/api/events` and uses `onmessage` for query invalidation; without a broadcast path live updates never fire AND every 15s heartbeat needlessly invalidates all queries. |
| 2 | `src/execution/position-monitor.ts:166-183` | 🔴 Critical | APPLY — day-60 half-sell + day-90 full-exit can submit overlapping orders. Fix: gate time-stop branches on `pendingExitQty > 0`. |
| 3 | `src/execution/order-manager.ts:128-175` | 🔴 Critical | APPLY — partial-status sell fills are never booked to the position. Reconcile incremental fills via cumulative-filled delta. |
| 4 | `src/execution/rebalancer.ts:31-32` | 🟠 Major | APPLY — failed rebalance permanently claimed; on `executeDiffs` throw, clear the run row so retries work. |
| 5 | `scripts/test-migration.ts:2` | 🟡 Minor | SKIP — utility probe script, fresh-temp on each run is polish, not correctness-affecting. |
| 6 | `src/db/schema.ts:198-224` | 🔵 Trivial / 🧹 Nitpick | SKIP — error-message regex for idempotent RENAME COLUMN is fragile but works; CodeRabbit itself flags as "acceptable". |

## Tasks

### Task 1 — `src/api/server.ts` restore SSE broadcast path + named heartbeat event

The frontend (`frontend/src/hooks/useRealTime.ts`) registers `events.onmessage` AND `events.addEventListener("heartbeat", ...)`. Currently the heartbeat frame is sent without a `event:` line, so it triggers `onmessage` (which calls `queryClient.invalidateQueries()` every 15s — an unintended cache thrash).

Two fixes in one:
- Add a named heartbeat event (`event: heartbeat\n`) so it fires the dedicated listener instead of `onmessage`.
- Re-introduce `sseClients` registry + `broadcastSSE` helper for real events to be pushable from elsewhere in the codebase (e.g., on order fill, on position close — wiring those callers is out of scope for this review).

```typescript
import Fastify from "fastify";
import type { ServerResponse } from "node:http";
import { config } from "../config.js";
import { getDb } from "../db/queries.js";
import { alertsRoutes } from "./routes/alerts.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { portfolioRoutes } from "./routes/portfolio.js";
import { rankingsRoutes } from "./routes/rankings.js";
import { senatorsRoutes } from "./routes/senators.js";
import { tradesRoutes } from "./routes/trades.js";
import { FUND_MANAGERS } from "../tracking/fund-manager-tracker.js";

const sseClients = new Set<ServerResponse>();

export function broadcastSSE(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

export function buildServer() {
  const server = Fastify({ logger: true, ignoreTrailingSlash: true });
  const db = getDb();

  server.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (request.headers.authorization !== `Bearer ${config.API_AUTH_TOKEN}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  server.get("/health", async () => ({ ok: true, uptime: process.uptime() }));
  server.register(dashboardRoutes(db), { prefix: "/api/dashboard" });
  server.register(rankingsRoutes(db), { prefix: "/api/rankings" });
  server.register(tradesRoutes(db), { prefix: "/api/trades" });
  server.register(portfolioRoutes(db), { prefix: "/api/portfolio" });
  server.register(senatorsRoutes(db), { prefix: "/api/senators" });
  server.register(alertsRoutes(db), { prefix: "/api/alerts" });
  server.get("/api/funds", async () => FUND_MANAGERS);

  server.get("/api/events", (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "http://localhost:5173"
    });
    const timer = setInterval(() => {
      reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    }, 15_000);
    sseClients.add(reply.raw);
    reply.raw.on("close", () => {
      clearInterval(timer);
      sseClients.delete(reply.raw);
    });
  });

  return server;
}

export async function startApi() {
  const server = buildServer();
  await server.listen({ port: config.API_PORT, host: config.API_HOST });
  return server;
}
```

### Task 2 — `position-monitor.ts:checkSenatorTimeStops` gate on pendingExitQty

Replace the body of `checkSenatorTimeStops` so day-60 and day-90 are mutually exclusive AND skipped while any sell is already in flight:

```diff
   private async checkSenatorTimeStops(position: StockPosition, pnlRatio: number) {
     const ageDays = Math.floor((Date.now() - new Date(position.openedAt).getTime()) / 86_400_000);
     if (ageDays >= 30 && !position.day30Checked && pnlRatio < -0.05) {
       markStockPositionTimeCheck(this.db, position.id, "day30_checked");
       await this.alert("time_stop", position, { action: "day30_flag", pnlRatio });
     }
-    if (ageDays >= 60 && !position.day60ExitedHalf && pnlRatio >= -0.05 && pnlRatio <= 0.05) {
-      await this.sellHalf(position, "time_stop");
-    }
-    if (ageDays >= 90 && !position.trailingStopActive) {
-      await this.exit(position, "time_stop");
-    }
+
+    // Skip time-stop actions while any sell is already pending for this position.
+    // Prevents day-60 half-sell and day-90 full-exit from queueing overlapping orders,
+    // and prevents re-queueing the same half-exit before its fill flips day60_exited_half.
+    if ((position.pendingExitQty ?? 0) > 0) return;
+
+    if (ageDays >= 90 && !position.trailingStopActive) {
+      await this.exit(position, "time_stop");
+      return;
+    }
+    if (ageDays >= 60 && !position.day60ExitedHalf && pnlRatio >= -0.05 && pnlRatio <= 0.05) {
+      await this.sellHalf(position, "time_stop");
+    }
   }
```

Day-90 is checked first; if a 90+ day position has no pending exit and trailing stop isn't active, full-exit takes priority. Day-60 only fires for positions in the 60-90 window.

Day30 marking still happens unconditionally — it's just a sentinel write, no order submission.

Also gate the take-profit branch in `checkPosition` against pending exits to avoid the same race:

```diff
     if (position.sleeve === "senator") {
       if (pnlRatio !== null && pnlRatio >= 0.15 && !position.trailingStopActive) await this.activateTrailingStop(position, 8);
-      if (pnlRatio !== null && pnlRatio >= 0.25 && position.status === "open") {
+      if (pnlRatio !== null && pnlRatio >= 0.25 && position.status === "open" && (position.pendingExitQty ?? 0) === 0) {
         await this.sellHalf(position, "take_profit");
         return;
       }
       if (pnlRatio !== null && pnlRatio <= -0.15) {
         await this.exit(position, "time_stop");
         return;
       }
       if (pnlRatio !== null) await this.checkSenatorTimeStops(position, pnlRatio);
     } else {
       if (pnlRatio !== null && pnlRatio >= 0.2 && !position.trailingStopActive) await this.activateTrailingStop(position, 8);
     }
```

### Task 3 — `order-manager.ts:monitorOrders` book partial sell fills incrementally

Rewrite the sell-fill section so any new filled-delta (whether status is `partial` or `filled`) is reconciled to the position; the close decision uses the actual position remainder. Capture `previouslyFilledQty` BEFORE `updateStockExecutionFill` overwrites it.

```diff
   async monitorOrders() {
     for (const execution of pendingStockExecutions(this.db)) {
       if (!execution.alpacaOrderId) continue;
       const order = await this.alpaca.getOrder(execution.alpacaOrderId);
       const status = mapOrderStatus(order.status);
+      const previouslyFilledQty = execution.filledQuantity ?? 0;
       updateStockExecutionFill(this.db, execution.id, {
         status,
         filledPrice: money(order.filled_avg_price ?? undefined) || null,
         filledQuantity: money(order.filled_qty),
         amountUsd: order.notional ? money(order.notional) : execution.amountUsd
       });
 
-      if (status === "filled") {
-        if (execution.direction === "buy") {
+      if (status === "filled" && execution.direction === "buy") {
+        await this.createPositionIfNeeded(execution.id, order, {
+          sleeve: execution.sleeve,
+          triggerType: execution.triggerType,
+          ticker: execution.ticker,
+          senatorName: execution.senatorName,
+          senatorRank: execution.senatorRank,
+          fundName: execution.fundName,
+          sector: null
+        });
+      } else if ((status === "filled" || status === "partial") && execution.direction === "sell") {
+        if (!execution.positionId) {
+          logger.error({ executionId: execution.id, ticker: execution.ticker }, "sell fill missing position_id; flagging for manual reconciliation");
+          markExecutionReconcileFailed(this.db, execution.id, "sell fill missing position_id");
+          continue;
+        }
+        const position = findPositionById(this.db, execution.positionId);
+        if (!position) {
+          logger.error({ executionId: execution.id, positionId: execution.positionId }, "sell fill references unknown position; flagging for manual reconciliation");
+          markExecutionReconcileFailed(this.db, execution.id, `position ${execution.positionId} not found`);
+          addPendingExit(this.db, execution.positionId, -execution.quantity);
+          continue;
+        }
+        const totalFilledQty = money(order.filled_qty);
+        const deltaQty = Math.max(0, totalFilledQty - previouslyFilledQty);
+        if (deltaQty > 0) {
+          const filledPrice = money(order.filled_avg_price ?? undefined);
+          const slicePnlUsd = filledPrice > 0 ? (filledPrice - position.avgEntryPrice) * deltaQty : null;
+          if (slicePnlUsd !== null && slicePnlUsd < 0) this.trackWashSaleIfNeeded(position.ticker, slicePnlUsd);
+          const remainingAfter = Math.max(0, position.quantity - deltaQty);
+          if (status === "filled" && remainingAfter <= 0) {
+            closeStockPosition(this.db, position.id, execution.triggerType ?? "manual", slicePnlUsd, deltaQty);
+          } else {
+            applyPartialFill(this.db, position.id, deltaQty, slicePnlUsd);
+            if (status === "filled") applyPostFillAction(this.db, execution.id);
+          }
+        }
+      } else if (this.shouldCancelByEndOfDay(execution.createdAt)) {
+        await this.alpaca.cancelOrder(execution.alpacaOrderId);
+        if (execution.direction === "sell" && execution.positionId) {
+          const totalFilled = money(order.filled_qty);
+          const unfilled = Math.max(0, execution.quantity - totalFilled);
+          if (unfilled > 0) addPendingExit(this.db, execution.positionId, -unfilled);
+        }
+        updateStockExecutionOrder(this.db, execution.id, { status: "cancelled", notes: "cancelled at 15:45 ET cutoff" });
+      } else if (this.shouldResubmit(execution.createdAt)) {
+        await this.resubmitLimit(execution.id, order);
+      }
+    }
+  }
-          await this.createPositionIfNeeded(execution.id, order, {
-            sleeve: execution.sleeve,
-            triggerType: execution.triggerType,
-            ticker: execution.ticker,
-            senatorName: execution.senatorName,
-            senatorRank: execution.senatorRank,
-            fundName: execution.fundName,
-            sector: null
-          });
-        } else if (execution.direction === "sell") {
-          if (!execution.positionId) {
-            logger.error({ executionId: execution.id, ticker: execution.ticker }, "sell fill missing position_id; flagging for manual reconciliation");
-            markExecutionReconcileFailed(this.db, execution.id, "sell fill missing position_id");
-            continue;
-          }
-          const position = findPositionById(this.db, execution.positionId);
-          if (!position) {
-            logger.error({ executionId: execution.id, positionId: execution.positionId }, "sell fill references unknown position; flagging for manual reconciliation");
-            markExecutionReconcileFailed(this.db, execution.id, `position ${execution.positionId} not found`);
-            addPendingExit(this.db, execution.positionId, -execution.quantity);
-            continue;
-          }
-          const filledPrice = money(order.filled_avg_price ?? undefined);
-          const filledQty = money(order.filled_qty);
-          const slicePnlUsd = filledPrice > 0 ? (filledPrice - position.avgEntryPrice) * filledQty : null;
-          if (slicePnlUsd !== null && slicePnlUsd < 0) this.trackWashSaleIfNeeded(position.ticker, slicePnlUsd);
-          const remainingAfter = Math.max(0, position.quantity - filledQty);
-          if (remainingAfter <= 0) {
-            closeStockPosition(this.db, position.id, execution.triggerType ?? "manual", slicePnlUsd, filledQty);
-          } else {
-            applyPartialFill(this.db, position.id, filledQty, slicePnlUsd);
-            applyPostFillAction(this.db, execution.id);
-          }
-        }
-      } else if (this.shouldCancelByEndOfDay(execution.createdAt)) {
-        await this.alpaca.cancelOrder(execution.alpacaOrderId);
-        updateStockExecutionOrder(this.db, execution.id, { status: "cancelled", notes: "cancelled at 15:45 ET cutoff" });
-      } else if (this.shouldResubmit(execution.createdAt)) {
-        await this.resubmitLimit(execution.id, order);
-      }
-    }
-  }
```

The diff above is messy because it's a deep restructure. To avoid Codex applying this as a textual patch (which would fail because of the inverted block ordering), execute this as: **replace the entire body of `monitorOrders()` (lines 123-178) with the snippet below.**

```typescript
  async monitorOrders() {
    for (const execution of pendingStockExecutions(this.db)) {
      if (!execution.alpacaOrderId) continue;
      const order = await this.alpaca.getOrder(execution.alpacaOrderId);
      const status = mapOrderStatus(order.status);
      const previouslyFilledQty = execution.filledQuantity ?? 0;
      updateStockExecutionFill(this.db, execution.id, {
        status,
        filledPrice: money(order.filled_avg_price ?? undefined) || null,
        filledQuantity: money(order.filled_qty),
        amountUsd: order.notional ? money(order.notional) : execution.amountUsd
      });

      if (status === "filled" && execution.direction === "buy") {
        await this.createPositionIfNeeded(execution.id, order, {
          sleeve: execution.sleeve,
          triggerType: execution.triggerType,
          ticker: execution.ticker,
          senatorName: execution.senatorName,
          senatorRank: execution.senatorRank,
          fundName: execution.fundName,
          sector: null
        });
      } else if ((status === "filled" || status === "partial") && execution.direction === "sell") {
        if (!execution.positionId) {
          logger.error({ executionId: execution.id, ticker: execution.ticker }, "sell fill missing position_id; flagging for manual reconciliation");
          markExecutionReconcileFailed(this.db, execution.id, "sell fill missing position_id");
          continue;
        }
        const position = findPositionById(this.db, execution.positionId);
        if (!position) {
          logger.error({ executionId: execution.id, positionId: execution.positionId }, "sell fill references unknown position; flagging for manual reconciliation");
          markExecutionReconcileFailed(this.db, execution.id, `position ${execution.positionId} not found`);
          addPendingExit(this.db, execution.positionId, -execution.quantity);
          continue;
        }
        const totalFilledQty = money(order.filled_qty);
        const deltaQty = Math.max(0, totalFilledQty - previouslyFilledQty);
        if (deltaQty > 0) {
          const filledPrice = money(order.filled_avg_price ?? undefined);
          const slicePnlUsd = filledPrice > 0 ? (filledPrice - position.avgEntryPrice) * deltaQty : null;
          if (slicePnlUsd !== null && slicePnlUsd < 0) this.trackWashSaleIfNeeded(position.ticker, slicePnlUsd);
          const remainingAfter = Math.max(0, position.quantity - deltaQty);
          if (status === "filled" && remainingAfter <= 0) {
            closeStockPosition(this.db, position.id, execution.triggerType ?? "manual", slicePnlUsd, deltaQty);
          } else {
            applyPartialFill(this.db, position.id, deltaQty, slicePnlUsd);
            if (status === "filled") applyPostFillAction(this.db, execution.id);
          }
        }
      } else if (this.shouldCancelByEndOfDay(execution.createdAt)) {
        await this.alpaca.cancelOrder(execution.alpacaOrderId);
        if (execution.direction === "sell" && execution.positionId) {
          const totalFilled = money(order.filled_qty);
          const unfilled = Math.max(0, execution.quantity - totalFilled);
          if (unfilled > 0) addPendingExit(this.db, execution.positionId, -unfilled);
        }
        updateStockExecutionOrder(this.db, execution.id, { status: "cancelled", notes: "cancelled at 15:45 ET cutoff" });
      } else if (this.shouldResubmit(execution.createdAt)) {
        await this.resubmitLimit(execution.id, order);
      }
    }
  }
```

### Task 4 — `rebalancer.ts` clear claim on executeDiffs failure

**(a) Add `clearRebalanceRun` helper to `src/db/queries.ts`** (next to `markRebalanceRun`):

```typescript
export function clearRebalanceRun(db: Database.Database, fundCik: string, reportDate: string) {
  db.prepare("DELETE FROM rebalance_runs WHERE fund_cik = ? AND report_date = ?").run(fundCik, reportDate);
}
```

**(b) `rebalancer.ts` — wrap `executeDiffs` in try/catch in both call sites:**

Update the import:
```diff
-import { markRebalanceRun, openStockPositions } from "../db/queries.js";
+import { clearRebalanceRun, markRebalanceRun, openStockPositions } from "../db/queries.js";
```

`onNewFiling`:
```diff
   async onNewFiling(diffs: FundHoldingInput[]) {
     if (diffs.length === 0) return;
     const first = diffs[0];
     if (!first) return;
     if (!this.isRebalanceWindow(first.filingDate)) {
       logger.info({ filingDate: first.filingDate, fundName: first.fundName, fundCik: first.fundCik }, "13F filing queued until delayed rebalance window");
       return;
     }
     if (!markRebalanceRun(this.db, first.fundCik, first.reportDate)) return;
-    await this.executeDiffs(diffs, first.fundCik, first.reportDate);
+    try {
+      await this.executeDiffs(diffs, first.fundCik, first.reportDate);
+    } catch (error) {
+      logger.error({ error, fundCik: first.fundCik, reportDate: first.reportDate }, "rebalance failed; clearing claim so it can be retried");
+      clearRebalanceRun(this.db, first.fundCik, first.reportDate);
+      throw error;
+    }
   }
```

`runDueRebalances`:
```diff
     for (const row of rows) {
       if (!markRebalanceRun(this.db, row.fund_cik, row.report_date)) continue;
       const diffs = this.db
         .prepare("SELECT * FROM fund_holdings WHERE fund_cik = ? AND report_date = ? AND change_type IS NOT NULL")
         .all(row.fund_cik, row.report_date)
         .map(mapHolding);
-      await this.executeDiffs(diffs, row.fund_cik, row.report_date);
+      try {
+        await this.executeDiffs(diffs, row.fund_cik, row.report_date);
+      } catch (error) {
+        logger.error({ error, fundCik: row.fund_cik, reportDate: row.report_date }, "rebalance failed; clearing claim so it can be retried");
+        clearRebalanceRun(this.db, row.fund_cik, row.report_date);
+      }
     }
```

`runDueRebalances` swallows the error (logs only) so one failed fund doesn't abort the whole pass. `onNewFiling` re-throws so the caller (typically the ingestion path) surfaces it.

The 30-second sleep in `executeDiffs` between sells and buys is preserved — atomic claim handles correctness, the sleep is for cash settlement realism.

## Verification

1. `npm test` (tsc-build runs typecheck via build).
2. `npm run build`.
3. **DO NOT commit, push, or restart services.** Stop and report which files changed and final test count (currently 2/2).

## Stop conditions

- Any test failure unexplained by the tasks above → stop and report.
- Honor prior decisions: existing wash-sale ownership at fill, reconcile-failed status semantics, atomic markRebalanceRun claim, OTO bracket entry params, MEME-tier slippage (n/a — crypto-only).
- Skipped findings (test-migration tmp file, schema RENAME regex) are intentional Minor/Trivial — do not address.
