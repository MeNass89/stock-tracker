import type Database from "better-sqlite3";
import type { AlertEngine } from "../alerting/alert-engine.js";
import type { FundHoldingInput } from "../types.js";
import { logger } from "../utils/logger.js";
import { AlpacaClient } from "./alpaca-client.js";
import { OrderManager } from "./order-manager.js";
import { SignalFilter } from "./signal-filter.js";
import { clearRebalanceRun, markRebalanceRun, openStockPositions } from "../db/queries.js";

export class Rebalancer {
  private readonly signalFilter: SignalFilter;
  private readonly orderManager: OrderManager;

  constructor(
    private readonly db: Database.Database,
    private readonly alertEngine?: AlertEngine,
    alpaca = new AlpacaClient()
  ) {
    this.signalFilter = new SignalFilter(db, alpaca);
    this.orderManager = new OrderManager(db, alpaca);
  }

  async onNewFiling(diffs: FundHoldingInput[]) {
    if (diffs.length === 0) return;
    const first = diffs[0];
    if (!first) return;
    if (!this.isRebalanceWindow(first.filingDate)) {
      logger.info({ filingDate: first.filingDate, fundName: first.fundName, fundCik: first.fundCik }, "13F filing queued until delayed rebalance window");
      return;
    }
    if (!markRebalanceRun(this.db, first.fundCik, first.reportDate)) return;
    try {
      await this.executeDiffs(diffs, first.fundCik, first.reportDate);
    } catch (error) {
      logger.error({ error, fundCik: first.fundCik, reportDate: first.reportDate }, "rebalance failed; clearing claim so it can be retried");
      clearRebalanceRun(this.db, first.fundCik, first.reportDate);
      throw error;
    }
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
      try {
        await this.executeDiffs(diffs, row.fund_cik, row.report_date);
      } catch (error) {
        logger.error({ error, fundCik: row.fund_cik, reportDate: row.report_date }, "rebalance failed; clearing claim so it can be retried");
        clearRebalanceRun(this.db, row.fund_cik, row.report_date);
      }
    }
  }

  private async executeDiffs(diffs: FundHoldingInput[], fundCik: string, reportDate: string) {
    const exitsByTicker = this.crossFundExits(diffs);
    for (const [ticker, count] of exitsByTicker) {
      if (count >= 2) await this.exitTicker(ticker, "fund_exit");
    }

    const sells = diffs.filter((holding) => holding.changeType === "exit" || (holding.changeType === "decrease" && Math.abs(holding.changePct ?? 0) >= 0.25));
    const buys = diffs.filter((holding) => holding.changeType === "new" || (holding.changeType === "increase" && (holding.changePct ?? 0) >= 0.25));

    for (const holding of sells) {
      await this.rebalanceSell(holding);
    }

    if (sells.length > 0 && buys.length > 0) await new Promise((resolve) => setTimeout(resolve, 30 * 1000));

    for (const holding of buys) {
      const decision = await this.signalFilter.evaluate13FDiff(holding);
      if (!decision.copy) continue;
      decision.metadata = { ...decision.metadata, dailyFraction: 0.2, fundSignalCount: this.fundSignalCount(diffs, decision.ticker) };
      await this.orderManager.submitSignal(decision);
    }

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

  private async rebalanceSell(holding: FundHoldingInput) {
    const ticker = holding.ticker?.toUpperCase();
    if (!ticker) return;
    const positions = openStockPositions(this.db).filter(
      (position) => position.sleeve === "13f" && position.ticker === ticker && (!position.fundName || position.fundName === holding.fundName)
    );
    const trimPct = holding.changeType === "exit" ? 1 : Math.min(1, Math.abs(holding.changePct ?? 0));
    for (const position of positions) {
      const quantity = position.quantity * trimPct;
      await this.orderManager.submitMarketExit(position.id, position.ticker, quantity, "fund_exit", "13f", trimPct >= 0.999);
    }
  }

  private async exitTicker(ticker: string, reason: "fund_exit") {
    const positions = openStockPositions(this.db).filter((position) => position.sleeve === "13f" && position.ticker === ticker);
    for (const position of positions) {
      await this.orderManager.submitMarketExit(position.id, position.ticker, position.quantity, reason, "13f", true);
    }
  }

  private crossFundExits(diffs: FundHoldingInput[]) {
    const exits = new Map<string, number>();
    for (const holding of diffs) {
      if (holding.changeType !== "exit" || !holding.ticker) continue;
      exits.set(holding.ticker.toUpperCase(), (exits.get(holding.ticker.toUpperCase()) ?? 0) + 1);
    }
    return exits;
  }

  private fundSignalCount(diffs: FundHoldingInput[], ticker: string) {
    return new Set(
      diffs
        .filter((holding) => holding.ticker?.toUpperCase() === ticker && (holding.changeType === "new" || (holding.changeType === "increase" && (holding.changePct ?? 0) >= 0.25)))
        .map((holding) => holding.fundCik)
    ).size;
  }

  private isRebalanceWindow(filingDate: string) {
    const filed = new Date(`${filingDate.slice(0, 10)}T00:00:00Z`);
    const now = new Date();
    const daysSinceFiling = Math.floor((now.getTime() - filed.getTime()) / 86_400_000);
    return daysSinceFiling >= 3 && daysSinceFiling <= 5;
  }

}

function mapHolding(row: any): FundHoldingInput {
  return {
    fundName: row.fund_name,
    fundCik: row.fund_cik,
    reportDate: row.report_date,
    filingDate: row.filing_date,
    ticker: row.ticker,
    cusip: row.cusip,
    securityName: row.security_name,
    shares: row.shares,
    valueThousands: row.value_thousands,
    changeType: row.change_type,
    changeShares: row.change_shares,
    changePct: row.change_pct
  };
}
