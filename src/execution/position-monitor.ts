import type Database from "better-sqlite3";
import type { AlertEngine } from "../alerting/alert-engine.js";
import {
  closeStockPosition,
  insertWashSale,
  markStockPositionTimeCheck,
  openStockPositions,
  updateStockPositionMarket,
  updateStockPositionStops
} from "../db/queries.js";
import type { StockPosition } from "../types.js";
import { logger } from "../utils/logger.js";
import { AlpacaClient } from "./alpaca-client.js";
import { OrderManager } from "./order-manager.js";

export class PositionMonitor {
  private readonly orderManager: OrderManager;

  constructor(
    private readonly db: Database.Database,
    private readonly alertEngine?: AlertEngine,
    private readonly alpaca = new AlpacaClient()
  ) {
    this.orderManager = new OrderManager(db, alpaca);
  }

  async checkAll() {
    await this.orderManager.monitorOrders();
    const positions = openStockPositions(this.db);
    for (const position of positions) {
      await this.checkPosition(position);
    }
  }

  private async checkPosition(position: StockPosition) {
    const alpacaPosition = await this.alpaca.getPosition(position.ticker);
    const currentPrice = alpacaPosition ? money(alpacaPosition.current_price) : position.currentPrice ?? position.avgEntryPrice;
    const pnlUsd = (currentPrice - position.avgEntryPrice) * position.quantity;
    const pnlRatio = position.avgEntryPrice > 0
      ? (currentPrice - position.avgEntryPrice) / position.avgEntryPrice
      : null;
    updateStockPositionMarket(this.db, position.id, { currentPrice, pnlUsd, pnlRatio });

    if (this.flashCrash(position, currentPrice)) {
      await this.handleFlashCrash(position, currentPrice);
      return;
    }

    if (await this.hasSenatorExit(position)) {
      await this.exit(position, "senator_exit");
      return;
    }

    if (await this.stopLossFilled(position)) return;

    if (await this.softStopTriggered(position, currentPrice)) return;

    if (position.sleeve === "senator") {
      if (pnlRatio !== null && pnlRatio >= 0.15 && !position.trailingStopActive) await this.activateTrailingStop(position, 8);
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
    }
  }

  private async hasSenatorExit(position: StockPosition) {
    if (position.sleeve !== "senator" || !position.senatorName) return false;
    const row = this.db
      .prepare(
        `SELECT count(*) AS count
         FROM trades t
         JOIN politicians p ON p.id = t.politician_id
         WHERE p.name = ?
           AND t.ticker = ?
           AND t.direction = 'sell'
           AND datetime(t.detected_at) > datetime(?)`
      )
      .get(position.senatorName, position.ticker, position.openedAt) as { count: number };
    return row.count > 0;
  }

  private async softStopTriggered(position: StockPosition, currentPrice: number) {
    if (!position.stopLossPrice || currentPrice > position.stopLossPrice) return false;
    if (position.stopLossOrderId || position.trailingStopOrderId) return false;
    if ((position.pendingExitQty ?? 0) > 0) return false;
    const reason = position.sleeve === "13f" ? "fund_exit" : "stop_loss";
    logger.warn(
      { positionId: position.id, ticker: position.ticker, currentPrice, stopLossPrice: position.stopLossPrice },
      "soft-stop: position has no Alpaca stop order; triggering exit at stop price",
    );
    await this.orderManager.submitMarketExit(position.id, position.ticker, position.quantity, reason, position.sleeve, true);
    const pnlUsd = (currentPrice - position.avgEntryPrice) * position.quantity;
    const pnlRatio = position.avgEntryPrice > 0
      ? (currentPrice - position.avgEntryPrice) / position.avgEntryPrice
      : null;
    await this.alert("stop_triggered", position, { exitReason: "soft_stop", pnlUsd, pnlRatio });
    return true;
  }

  private async stopLossFilled(position: StockPosition) {
    const orderIds = Array.from(
      new Set([position.trailingStopOrderId, position.stopLossOrderId].filter((orderId): orderId is string => Boolean(orderId)))
    );
    if (orderIds.length === 0) return false;

    for (const orderId of orderIds) {
      const order = await this.alpaca.getOrder(orderId);

      if (order.status === "rejected" || order.status === "expired") {
        logger.warn({ orderId, status: order.status, ticker: position.ticker }, "stop order rejected/expired — resubmitting");
        const newStop = await this.orderManager.resubmitStopLoss(position);
        if (newStop) updateStockPositionStops(this.db, position.id, { stopLossOrderId: newStop });
        continue;
      }

      if (order.status !== "filled") continue;

      const filledPrice = money(order.filled_avg_price ?? undefined) || position.stopLossPrice || position.currentPrice || position.avgEntryPrice;
      const pnlUsd = (filledPrice - position.avgEntryPrice) * position.quantity;
      const pnlRatio = position.avgEntryPrice > 0 ? (filledPrice - position.avgEntryPrice) / position.avgEntryPrice : null;
      const exitReason = orderId === position.trailingStopOrderId ? "trailing_stop" : "stop_loss";
      closeStockPosition(this.db, position.id, exitReason, pnlUsd, position.quantity);
      this.trackWashSaleIfNeeded(position.ticker, pnlUsd);
      await this.alert("stop_triggered", position, { exitReason, pnlUsd, pnlRatio });
      return true;
    }

    return false;
  }

  private async activateTrailingStop(position: StockPosition, trailPercent: number) {
    if (position.stopLossOrderId) {
      try {
        await this.alpaca.cancelOrder(position.stopLossOrderId);
      } catch (error) {
        logger.warn({ error, positionId: position.id }, "failed to cancel stop loss before trailing stop activation");
      }
    }

    const wholeQty = Math.floor(position.quantity);
    if (wholeQty < 1) return;
    const order = await this.alpaca.submitOrder({
      symbol: position.ticker,
      qty: wholeQty.toString(),
      side: "sell",
      type: "trailing_stop",
      time_in_force: "gtc",
      trail_percent: trailPercent.toString(),
      client_order_id: `st-trail-${position.id}-${Date.now()}`
    });
    updateStockPositionStops(this.db, position.id, {
      trailingStopActive: true,
      trailingStopPct: trailPercent,
      trailingStopOrderId: order.id
    });
    await this.alert("trailing_activated", position, { trailPercent });
  }

  private async sellHalf(position: StockPosition, reason: "take_profit" | "time_stop") {
    const quantity = position.quantity / 2;
    const postFillAction = reason === "time_stop" ? "day60_half" : null;
    await this.orderManager.submitMarketExit(position.id, position.ticker, quantity, reason, position.sleeve, false, postFillAction);
    await this.alert(reason, position, { quantity });
  }

  private async checkSenatorTimeStops(position: StockPosition, pnlRatio: number) {
    const ageDays = Math.floor((Date.now() - new Date(position.openedAt).getTime()) / 86_400_000);
    if (ageDays >= 30 && !position.day30Checked && pnlRatio < -0.05) {
      markStockPositionTimeCheck(this.db, position.id, "day30_checked");
      await this.alert("time_stop", position, { action: "day30_flag", pnlRatio });
    }

    // Skip time-stop actions while any sell is already pending for this position.
    // Prevents day-60 half-sell and day-90 full-exit from queueing overlapping orders,
    // and prevents re-queueing the same half-exit before its fill flips day60_exited_half.
    if ((position.pendingExitQty ?? 0) > 0) return;

    if (ageDays >= 90 && !position.trailingStopActive) {
      await this.exit(position, "time_stop");
      return;
    }
    if (ageDays >= 60 && !position.day60ExitedHalf && pnlRatio >= -0.05 && pnlRatio <= 0.05) {
      await this.sellHalf(position, "time_stop");
    }
  }

  private async exit(position: StockPosition, reason: "senator_exit" | "time_stop" | "fund_exit") {
    await this.orderManager.submitMarketExit(position.id, position.ticker, position.quantity, reason, position.sleeve, true);
    await this.alert(reason, position, { quantity: position.quantity });
  }

  private flashCrash(position: StockPosition, currentPrice: number) {
    if (!position.currentPrice || position.currentPrice <= 0) return false;
    return (position.currentPrice - currentPrice) / position.currentPrice > 0.1;
  }

  private async handleFlashCrash(position: StockPosition, currentPrice: number) {
    const widenedStop = currentPrice * 0.95;
    updateStockPositionStops(this.db, position.id, { stopLossPrice: widenedStop });
    if (position.stopLossOrderId) {
      try {
        await this.alpaca.replaceOrder(position.stopLossOrderId, {
          stop_price: widenedStop.toFixed(2),
          limit_price: (widenedStop * 0.98).toFixed(2)
        });
      } catch { /* order may already be filled/cancelled */ }
    }
    await this.alert("stop_triggered", position, { action: "flash_crash_hold", widenedStop });
    logger.warn({ ticker: position.ticker, currentPrice, widenedStop }, "flash crash protection widened stop and skipped auto-sell");
  }

  private trackWashSaleIfNeeded(ticker: string, pnlUsd: number) {
    if (pnlUsd >= 0) return;
    const saleDate = new Date().toISOString().slice(0, 10);
    const cooldown = new Date();
    cooldown.setUTCDate(cooldown.getUTCDate() + 31);
    insertWashSale(this.db, ticker, saleDate, cooldown.toISOString().slice(0, 10), Math.abs(pnlUsd));
  }

  private async alert(type: string, position: StockPosition, data: Record<string, unknown>) {
    await this.alertEngine?.executionNotification({
      type,
      ticker: position.ticker,
      direction: "sell",
      size: position.quantity,
      price: position.currentPrice ?? position.avgEntryPrice,
      pnlUsd: typeof data.pnlUsd === "number" ? data.pnlUsd : position.pnlUsd ?? undefined,
      reason: type,
      data
    });
  }
}

function money(value: string | number | undefined) {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
