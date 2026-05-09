import type Database from "better-sqlite3";
import { config } from "../config.js";
import type {
  AlertInput,
  ExecutionStatus,
  FundHoldingInput,
  NormalizedTrade,
  PoliticianInput,
  RankingResult,
  SourceHealth,
  StockExecution,
  StockExecutionInput,
  StockPosition,
  StockPositionInput
} from "../types.js";
import { openDatabase } from "./schema.js";

let singleton: Database.Database | null = null;

export function getDb() {
  singleton ??= openDatabase(config.DB_PATH);
  return singleton;
}

export function upsertPolitician(db: Database.Database, input: PoliticianInput): number {
  const existing = db
    .prepare("SELECT id FROM politicians WHERE name = ? AND chamber = ?")
    .get(input.name, input.chamber) as { id: number } | undefined;
  const committees = JSON.stringify(input.committees ?? []);

  if (existing) {
    db.prepare(
      `UPDATE politicians
       SET state = coalesce(?, state),
           party = coalesce(?, party),
           committees = ?,
           cik = coalesce(?, cik),
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(input.state ?? null, input.party ?? null, committees, input.cik ?? null, existing.id);
    return existing.id;
  }

  const result = db
    .prepare(
      `INSERT INTO politicians (name, chamber, state, party, committees, cik)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(input.name, input.chamber, input.state ?? null, input.party ?? null, committees, input.cik ?? null);
  return Number(result.lastInsertRowid);
}

export function insertTrade(db: Database.Database, trade: NormalizedTrade): { id: number; inserted: boolean } {
  const politicianId = upsertPolitician(db, trade.politician);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO trades (
      politician_id, ticker, asset_name, trade_date, filing_date, detected_at,
      direction, amount_range, amount_midpoint, asset_type, source, source_id, raw_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const result = insert.run(
    politicianId,
    trade.ticker,
    trade.assetName,
    trade.tradeDate,
    trade.filingDate,
    trade.detectedAt,
    trade.direction,
    trade.amountRange,
    trade.amountMidpoint,
    trade.assetType,
    trade.source,
    trade.sourceId ?? null,
    JSON.stringify(trade.rawData ?? null)
  );

  if (result.changes > 0) {
    return { id: Number(result.lastInsertRowid), inserted: true };
  }

  const existing = db
    .prepare(
      `SELECT id FROM trades
       WHERE politician_id = ? AND ifnull(ticker, '') = ifnull(?, '')
         AND trade_date = ? AND direction = ? AND ifnull(amount_range, '') = ifnull(?, '')`
    )
    .get(politicianId, trade.ticker, trade.tradeDate, trade.direction, trade.amountRange) as
    | { id: number }
    | undefined;

  return { id: existing?.id ?? 0, inserted: false };
}

export function insertTrades(db: Database.Database, trades: NormalizedTrade[]) {
  const tx = db.transaction((items: NormalizedTrade[]) => items.map((trade) => insertTrade(db, trade)));
  return tx(trades);
}

export function insertFundHolding(db: Database.Database, holding: FundHoldingInput) {
  db.prepare(
    `INSERT INTO fund_holdings (
      fund_name, fund_cik, report_date, filing_date, ticker, cusip, security_name,
      shares, value_thousands, change_type, change_shares, change_pct
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fund_cik, report_date, cusip) DO UPDATE SET
      fund_name = excluded.fund_name,
      filing_date = excluded.filing_date,
      ticker = excluded.ticker,
      security_name = excluded.security_name,
      shares = excluded.shares,
      value_thousands = excluded.value_thousands,
      change_type = excluded.change_type,
      change_shares = excluded.change_shares,
      change_pct = excluded.change_pct`
  ).run(
    holding.fundName,
    holding.fundCik,
    holding.reportDate,
    holding.filingDate,
    holding.ticker,
    holding.cusip,
    holding.securityName,
    holding.shares,
    holding.valueThousands,
    holding.changeType ?? null,
    holding.changeShares ?? null,
    holding.changePct ?? null
  );
}

export function insertFundHoldings(db: Database.Database, holdings: FundHoldingInput[]) {
  const tx = db.transaction((items: FundHoldingInput[]) => {
    for (const holding of items) insertFundHolding(db, holding);
  });
  tx(holdings);
}

export function insertRankingRun(db: Database.Database, rankings: RankingResult[]) {
  const computedAt = new Date().toISOString();
  const tx = db.transaction((items: RankingResult[]) => {
    const stmt = db.prepare(
      `INSERT INTO rankings (
        politician_id, computed_at, score, alpha, win_rate, sharpe,
        profit_factor, trade_count, rank_position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const ranking of items) {
      stmt.run(
        ranking.politicianId,
        computedAt,
        ranking.score,
        ranking.alpha,
        ranking.winRate,
        ranking.sharpe,
        ranking.profitFactor,
        ranking.tradeCount,
        ranking.rankPosition
      );
    }
  });
  tx(rankings);
}

export function insertAlert(db: Database.Database, alert: AlertInput) {
  const result = db
    .prepare("INSERT INTO alerts (type, severity, title, body, data) VALUES (?, ?, ?, ?, ?)")
    .run(alert.type, alert.severity, alert.title, alert.body, JSON.stringify(alert.data ?? null));
  return Number(result.lastInsertRowid);
}

export function markAlertDiscordSent(db: Database.Database, alertId: number) {
  db.prepare("UPDATE alerts SET discord_sent = 1 WHERE id = ?").run(alertId);
}

export function upsertPrice(db: Database.Database, ticker: string, date: string, close: number) {
  db.prepare(
    "INSERT OR REPLACE INTO prices (ticker, date, close) VALUES (?, ?, ?)"
  ).run(ticker.toUpperCase(), date, close);
}

export function getCachedPrice(db: Database.Database, ticker: string, date: string) {
  return db
    .prepare("SELECT close FROM prices WHERE ticker = ? AND date = ?")
    .get(ticker.toUpperCase(), date) as { close: number } | undefined;
}

export function upsertSourceHealth(db: Database.Database, health: SourceHealth) {
  db.prepare(
    `INSERT INTO source_health (source, ok, checked_at, message)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET
       ok = excluded.ok, checked_at = excluded.checked_at, message = excluded.message`
  ).run(health.source, health.ok ? 1 : 0, health.checkedAt, health.message ?? null);
}

export function latestRankings(db: Database.Database, limit = 50) {
  return db
    .prepare(
      `SELECT r.*, p.name, p.chamber, p.state, p.party
       FROM rankings r
       JOIN politicians p ON p.id = r.politician_id
       WHERE r.computed_at = (SELECT max(computed_at) FROM rankings)
       ORDER BY r.rank_position ASC
       LIMIT ?`
    )
    .all(limit);
}

export function recentTrades(db: Database.Database, limit = 100) {
  return db
    .prepare(
      `SELECT t.*, p.name AS politician_name, p.chamber, p.state, p.party
       FROM trades t
       JOIN politicians p ON p.id = t.politician_id
       ORDER BY t.detected_at DESC
       LIMIT ?`
    )
    .all(limit);
}

export function recentAlerts(db: Database.Database, limit = 50) {
  return db.prepare("SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?").all(limit);
}

export function fundHoldings(db: Database.Database, fundCik?: string) {
  if (fundCik) {
    return db
      .prepare("SELECT * FROM fund_holdings WHERE fund_cik = ? ORDER BY report_date DESC, value_thousands DESC")
      .all(fundCik);
  }
  return db.prepare("SELECT * FROM fund_holdings ORDER BY report_date DESC, value_thousands DESC").all();
}

export function insertStockExecution(db: Database.Database, execution: StockExecutionInput) {
  const result = db
    .prepare(
      `INSERT INTO stock_executions (
        trigger_type, trigger_id, position_id, sleeve, ticker, direction, quantity, limit_price,
        filled_price, filled_quantity, amount_usd, alpaca_order_id, alpaca_client_order_id,
        status, senator_name, senator_rank, fund_name, notes, post_fill_action, submitted_at, filled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      execution.triggerType,
      execution.triggerId ?? null,
      execution.positionId ?? null,
      execution.sleeve,
      execution.ticker.toUpperCase(),
      execution.direction,
      execution.quantity ?? 0,
      execution.limitPrice ?? null,
      execution.filledPrice ?? null,
      execution.filledQuantity ?? null,
      execution.amountUsd ?? null,
      execution.alpacaOrderId ?? null,
      execution.alpacaClientOrderId ?? null,
      execution.status ?? "pending",
      execution.senatorName ?? null,
      execution.senatorRank ?? null,
      execution.fundName ?? null,
      execution.notes ?? null,
      execution.postFillAction ?? null,
      execution.status === "submitted" ? new Date().toISOString() : null,
      execution.status === "filled" ? new Date().toISOString() : null
    );
  return Number(result.lastInsertRowid);
}

export function updateStockExecutionOrder(
  db: Database.Database,
  id: number,
  input: {
    alpacaOrderId?: string | null;
    alpacaClientOrderId?: string | null;
    status?: ExecutionStatus;
    limitPrice?: number | null;
    notes?: string | null;
  }
) {
  db.prepare(
    `UPDATE stock_executions
     SET alpaca_order_id = coalesce(?, alpaca_order_id),
         alpaca_client_order_id = coalesce(?, alpaca_client_order_id),
         status = coalesce(?, status),
         limit_price = coalesce(?, limit_price),
         notes = coalesce(?, notes),
         submitted_at = CASE WHEN ? = 'submitted' THEN datetime('now') ELSE submitted_at END
     WHERE id = ?`
  ).run(
    input.alpacaOrderId ?? null,
    input.alpacaClientOrderId ?? null,
    input.status ?? null,
    input.limitPrice ?? null,
    input.notes ?? null,
    input.status ?? null,
    id
  );
}

export function updateStockExecutionFill(
  db: Database.Database,
  id: number,
  input: { status: ExecutionStatus; filledPrice?: number | null; filledQuantity?: number | null; amountUsd?: number | null }
) {
  db.prepare(
    `UPDATE stock_executions
     SET status = ?,
         filled_price = coalesce(?, filled_price),
         filled_quantity = coalesce(?, filled_quantity),
         amount_usd = coalesce(?, amount_usd),
         filled_at = CASE WHEN ? = 'filled' THEN datetime('now') ELSE filled_at END
     WHERE id = ?`
  ).run(input.status, input.filledPrice ?? null, input.filledQuantity ?? null, input.amountUsd ?? null, input.status, id);
}

export function pendingStockExecutions(db: Database.Database) {
  return db
    .prepare(
      `SELECT *
       FROM stock_executions
       WHERE status IN ('submitted', 'partial')
         AND alpaca_order_id IS NOT NULL
       ORDER BY created_at ASC`
    )
    .all()
    .map(mapStockExecution);
}

export function countExecutionsToday(db: Database.Database) {
  const row = db
    .prepare(
      `SELECT count(*) AS count
       FROM stock_executions
       WHERE direction = 'buy'
         AND trigger_type IN ('senator_trade', '13f_diff')
         AND date(created_at) = date('now')`
    )
    .get() as { count: number };
  return row.count;
}

export function insertStockPosition(db: Database.Database, position: StockPositionInput) {
  const result = db
    .prepare(
      `INSERT INTO stock_positions (
        ticker, sleeve, entry_execution_id, trigger_type, quantity, avg_entry_price,
        current_price, stop_loss_price, stop_loss_order_id, trailing_stop_active,
        trailing_stop_pct, trailing_stop_order_id, take_profit_price, time_stop_at,
        day30_checked, day60_exited_half, senator_name, senator_rank, fund_name, sector,
        status, pnl_usd, pnl_ratio, exit_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      position.ticker.toUpperCase(),
      position.sleeve,
      position.entryExecutionId ?? null,
      position.triggerType,
      position.quantity,
      position.avgEntryPrice,
      position.currentPrice ?? null,
      position.stopLossPrice ?? null,
      position.stopLossOrderId ?? null,
      position.trailingStopActive ? 1 : 0,
      position.trailingStopPct ?? null,
      position.trailingStopOrderId ?? null,
      position.takeProfitPrice ?? null,
      position.timeStopAt ?? null,
      position.day30Checked ? 1 : 0,
      position.day60ExitedHalf ? 1 : 0,
      position.senatorName ?? null,
      position.senatorRank ?? null,
      position.fundName ?? null,
      position.sector ?? null,
      position.status ?? "open",
      position.pnlUsd ?? null,
      position.pnlRatio ?? null,
      position.exitReason ?? null
    );
  return Number(result.lastInsertRowid);
}

export function openStockPositions(db: Database.Database) {
  return db.prepare("SELECT * FROM stock_positions WHERE status IN ('open', 'partial') ORDER BY opened_at ASC").all().map(mapStockPosition);
}

export function updateStockPositionMarket(
  db: Database.Database,
  id: number,
  input: { currentPrice?: number | null; pnlUsd?: number | null; pnlRatio?: number | null }
) {
  db.prepare(
    `UPDATE stock_positions
     SET current_price = coalesce(?, current_price),
         pnl_usd = coalesce(?, pnl_usd),
         pnl_ratio = coalesce(?, pnl_ratio)
     WHERE id = ?`
  ).run(input.currentPrice ?? null, input.pnlUsd ?? null, input.pnlRatio ?? null, id);
}

export function updateStockPositionStops(
  db: Database.Database,
  id: number,
  input: { stopLossPrice?: number | null; stopLossOrderId?: string | null; trailingStopActive?: boolean; trailingStopPct?: number | null; trailingStopOrderId?: string | null }
) {
  db.prepare(
    `UPDATE stock_positions
     SET stop_loss_price = coalesce(?, stop_loss_price),
         stop_loss_order_id = coalesce(?, stop_loss_order_id),
         trailing_stop_active = coalesce(?, trailing_stop_active),
         trailing_stop_pct = coalesce(?, trailing_stop_pct),
         trailing_stop_order_id = coalesce(?, trailing_stop_order_id)
     WHERE id = ?`
  ).run(
    input.stopLossPrice ?? null,
    input.stopLossOrderId ?? null,
    input.trailingStopActive === undefined ? null : input.trailingStopActive ? 1 : 0,
    input.trailingStopPct ?? null,
    input.trailingStopOrderId ?? null,
    id
  );
}

export function markStockPositionTimeCheck(db: Database.Database, id: number, field: "day30_checked" | "day60_exited_half") {
  db.prepare(`UPDATE stock_positions SET ${field} = 1 WHERE id = ?`).run(id);
}

export function closeStockPosition(
  db: Database.Database,
  id: number,
  exitReason: string,
  slicePnlUsd?: number | null,
  sliceFilledQty?: number | null
) {
  db.prepare(
    `UPDATE stock_positions
     SET status = 'closed',
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

export function addPendingExit(db: Database.Database, positionId: number, quantity: number) {
  db.prepare("UPDATE stock_positions SET pending_exit_qty = COALESCE(pending_exit_qty, 0) + ? WHERE id = ?").run(quantity, positionId);
}

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
         closed_at = CASE WHEN MAX(0, quantity - ?) <= 0 THEN CURRENT_TIMESTAMP ELSE closed_at END
     WHERE id = ?`
  ).run(filledQuantity, filledQuantity, slicePnlUsd ?? null, filledQuantity, filledQuantity, filledQuantity, positionId);
}

export function applyPostFillAction(db: Database.Database, executionId: number) {
  const row = db
    .prepare("SELECT post_fill_action, position_id FROM stock_executions WHERE id = ?")
    .get(executionId) as { post_fill_action: string | null; position_id: number | null } | undefined;
  if (!row?.post_fill_action || !row.position_id) return;
  if (row.post_fill_action === "day60_half") {
    db.prepare("UPDATE stock_positions SET day60_exited_half = 1 WHERE id = ?").run(row.position_id);
  }
}

export function markExecutionReconcileFailed(db: Database.Database, executionId: number, reason: string) {
  db.prepare(
    `UPDATE stock_executions
     SET status = 'failed',
         notes = COALESCE(notes, '') || ' | RECONCILE_FAILED: ' || ?
     WHERE id = ?`
  ).run(reason, executionId);
}

export function findPositionById(db: Database.Database, id: number) {
  const row = db.prepare("SELECT * FROM stock_positions WHERE id = ?").get(id);
  return row ? mapStockPosition(row) : null;
}

export function markRebalanceRun(db: Database.Database, fundCik: string, reportDate: string): boolean {
  const result = db.prepare("INSERT OR IGNORE INTO rebalance_runs (fund_cik, report_date) VALUES (?, ?)").run(fundCik, reportDate);
  return result.changes > 0;
}

export function clearRebalanceRun(db: Database.Database, fundCik: string, reportDate: string) {
  db.prepare("DELETE FROM rebalance_runs WHERE fund_cik = ? AND report_date = ?").run(fundCik, reportDate);
}

export function insertPortfolioSnapshot(
  db: Database.Database,
  snapshot: {
    totalValue: number;
    senatorSleeveValue: number;
    thirteenfSleeveValue: number;
    cashValue: number;
    dailyPnl: number;
    dailyPnlRatio: number;
    cumulativePnl: number;
    openPositions: number;
    highWaterMark: number;
  }
) {
  db.prepare(
    `INSERT INTO portfolio_snapshots (
      total_value, senator_sleeve_value, thirteenf_sleeve_value, cash_value,
      daily_pnl, daily_pnl_ratio, cumulative_pnl, open_positions, high_water_mark
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    snapshot.totalValue,
    snapshot.senatorSleeveValue,
    snapshot.thirteenfSleeveValue,
    snapshot.cashValue,
    snapshot.dailyPnl,
    snapshot.dailyPnlRatio,
    snapshot.cumulativePnl,
    snapshot.openPositions,
    snapshot.highWaterMark
  );
}

export function latestPortfolioSnapshot(db: Database.Database) {
  return db
    .prepare(
      `SELECT total_value, high_water_mark, snapshot_at
       FROM portfolio_snapshots
       ORDER BY snapshot_at DESC
       LIMIT 1`
    )
    .get() as { total_value: number; high_water_mark: number; snapshot_at: string } | undefined;
}

export function activeWashSale(db: Database.Database, ticker: string) {
  return db
    .prepare("SELECT * FROM wash_sale_tracker WHERE ticker = ? AND cooldown_until >= date('now') ORDER BY cooldown_until DESC LIMIT 1")
    .get(ticker.toUpperCase()) as { ticker: string; loss_sale_date: string; cooldown_until: string; loss_amount: number | null } | undefined;
}

export function insertWashSale(db: Database.Database, ticker: string, lossSaleDate: string, cooldownUntil: string, lossAmount: number) {
  db.prepare(
    `INSERT OR REPLACE INTO wash_sale_tracker (ticker, loss_sale_date, cooldown_until, loss_amount)
     VALUES (?, ?, ?, ?)`
  ).run(ticker.toUpperCase(), lossSaleDate, cooldownUntil, lossAmount);
}

function mapStockExecution(row: any): StockExecution {
  return {
    id: row.id,
    triggerType: row.trigger_type,
    triggerId: row.trigger_id,
    positionId: row.position_id,
    sleeve: row.sleeve,
    ticker: row.ticker,
    direction: row.direction,
    quantity: row.quantity,
    limitPrice: row.limit_price,
    filledPrice: row.filled_price,
    filledQuantity: row.filled_quantity,
    amountUsd: row.amount_usd,
    alpacaOrderId: row.alpaca_order_id,
    alpacaClientOrderId: row.alpaca_client_order_id,
    status: row.status,
    senatorName: row.senator_name,
    senatorRank: row.senator_rank,
    fundName: row.fund_name,
    notes: row.notes,
    postFillAction: row.post_fill_action,
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    filledAt: row.filled_at
  };
}

function mapStockPosition(row: any): StockPosition {
  return {
    id: row.id,
    ticker: row.ticker,
    sleeve: row.sleeve,
    entryExecutionId: row.entry_execution_id,
    triggerType: row.trigger_type,
    quantity: row.quantity,
    avgEntryPrice: row.avg_entry_price,
    currentPrice: row.current_price,
    stopLossPrice: row.stop_loss_price,
    stopLossOrderId: row.stop_loss_order_id,
    trailingStopActive: row.trailing_stop_active === 1,
    trailingStopPct: row.trailing_stop_pct,
    trailingStopOrderId: row.trailing_stop_order_id,
    takeProfitPrice: row.take_profit_price,
    timeStopAt: row.time_stop_at,
    day30Checked: row.day30_checked === 1,
    day60ExitedHalf: row.day60_exited_half === 1,
    senatorName: row.senator_name,
    senatorRank: row.senator_rank,
    fundName: row.fund_name,
    sector: row.sector,
    status: row.status,
    pnlUsd: row.pnl_usd,
    pnlRatio: row.pnl_ratio,
    realizedPnlUsd: row.realized_pnl_usd,
    realizedQty: row.realized_qty,
    pendingExitQty: row.pending_exit_qty,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    exitReason: row.exit_reason
  };
}
