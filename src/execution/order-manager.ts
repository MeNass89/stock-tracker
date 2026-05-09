import type Database from "better-sqlite3";
import { config } from "../config.js";
import {
  addPendingExit,
  applyPartialFill,
  applyPostFillAction,
  closeStockPosition,
  findPositionById,
  insertWashSale,
  insertStockExecution,
  insertStockPosition,
  markExecutionReconcileFailed,
  openStockPositions,
  pendingStockExecutions,
  updateStockExecutionFill,
  updateStockExecutionOrder
} from "../db/queries.js";
import { logger } from "../utils/logger.js";
import type { ExecutionSleeve, ExecutionTriggerType } from "../types.js";
import type { AlertEngine } from "../alerting/alert-engine.js";
import { AlpacaClient, type AlpacaOrder, type OrderParams } from "./alpaca-client.js";
import { PositionSizer } from "./position-sizer.js";
import { RiskEngine } from "./risk-engine.js";
import type { SignalDecision } from "./signal-filter.js";

export class OrderManager {
  private readonly sizer: PositionSizer;
  private readonly risk: RiskEngine;
  private alertEngine?: AlertEngine;

  constructor(
    private readonly db: Database.Database,
    private readonly alpaca = new AlpacaClient()
  ) {
    this.sizer = new PositionSizer(db);
    this.risk = new RiskEngine(db, alpaca);
  }

  setAlertEngine(engine: AlertEngine) {
    this.alertEngine = engine;
  }

  async submitSignal(decision: SignalDecision) {
    if (!config.EXECUTION_ENABLED) {
      logger.info({ ticker: decision.ticker, reason: decision.reason }, "execution disabled; signal accepted but not submitted");
      return null;
    }
    if (!decision.copy) return null;

    if (decision.direction === "sell") return this.submitExitSignal(decision);
    return this.submitEntry(decision);
  }

  async submitEntry(decision: SignalDecision) {
    const clock = await this.alpaca.getClock();
    if (!clock.is_open || !isExecutionWindow()) {
      logger.info({ ticker: decision.ticker, isOpen: clock.is_open }, "outside execution window; entry skipped");
      return null;
    }

    if (this.movedMoreThanFivePercent(decision)) {
      logger.info({ ticker: decision.ticker }, "stock moved more than 5% since filing; entry skipped");
      return null;
    }

    const account = await this.alpaca.getAccount();
    const referencePrice = numberMeta(decision, "currentPrice") ?? numberMeta(decision, "previousClose");
    const size = this.sizer.calculate(decision, account, referencePrice);
    if (!size.allowed) {
      logger.info({ ticker: decision.ticker, reason: size.reason }, "position sizing rejected signal");
      return null;
    }

    const risk = await this.risk.checkNewOrder(decision, size.notional);
    if (!risk.allowed) {
      logger.info({ ticker: decision.ticker, reason: risk.reason }, "risk engine rejected signal");
      return null;
    }

    const notional = risk.adjustedSize ?? size.notional;
    const limitPrice = this.entryLimitPrice(decision);
    const estimatedQuantity = size.notional > 0
      ? size.quantity * (notional / size.notional)
      : size.quantity;

    await this.alertEngine?.signalIntent(decision, { notional, limitPrice }).catch(() => {});

    const executionId = insertStockExecution(this.db, {
      triggerType: decision.triggerType,
      triggerId: decision.triggerId,
      sleeve: decision.sleeve,
      ticker: decision.ticker,
      direction: "buy",
      quantity: estimatedQuantity,
      limitPrice,
      amountUsd: notional,
      status: "pending",
      senatorName: decision.senatorName,
      senatorRank: decision.senatorRank,
      fundName: decision.fundName,
      notes: `${decision.reason}; boosts=${decision.boosts.join(",") || "none"}; ${size.reason}; ${risk.reason ?? ""}`
    });

    const clientOrderId = `st-${decision.sleeve}-${executionId}-${Date.now()}`;
    const params = this.entryOrderParams(decision, notional, clientOrderId, limitPrice);
    try {
      const order = await this.alpaca.submitOrder(params);
      updateStockExecutionOrder(this.db, executionId, {
        alpacaOrderId: order.id,
        alpacaClientOrderId: order.client_order_id,
        status: mapOrderStatus(order.status),
        limitPrice
      });
      await this.onOrderUpdate(executionId, order, decision);
      logger.info({ executionId, orderId: order.id, ticker: decision.ticker, notional }, "entry order submitted");
      return order;
    } catch (error) {
      updateStockExecutionOrder(this.db, executionId, { status: "failed", notes: error instanceof Error ? error.message : "order submit failed" });
      throw error;
    }
  }

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
      } else if (execution.direction === "sell" && (status === "filled" || status === "partial" || status === "cancelled" || status === "expired")) {
        if (!execution.positionId) {
          logger.error({ executionId: execution.id, ticker: execution.ticker }, "sell fill missing position_id; flagging for manual reconciliation");
          markExecutionReconcileFailed(this.db, execution.id, "sell fill missing position_id");
          continue;
        }
        const position = findPositionById(this.db, execution.positionId);
        if (!position) {
          logger.error({ executionId: execution.id, positionId: execution.positionId }, "sell fill references unknown position; flagging for manual reconciliation");
          markExecutionReconcileFailed(this.db, execution.id, `position ${execution.positionId} not found`);
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
        if (status === "cancelled" || status === "expired") {
          const unfilled = Math.max(0, execution.quantity - totalFilledQty);
          if (unfilled > 0) addPendingExit(this.db, execution.positionId, -unfilled);
          updateStockExecutionOrder(this.db, execution.id, { status, notes: `alpaca ${status}` });
          continue;
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

  async submitMarketExit(
    positionId: number,
    ticker: string,
    quantity: number,
    reason: string,
    sleeve: ExecutionSleeve = "senator",
    closeOnFill = true,
    postFillAction: string | null = null
  ) {
    const position = findPositionById(this.db, positionId);
    if (!position) {
      throw new Error(`submitMarketExit: position ${positionId} not found`);
    }
    const available = Math.max(0, position.quantity - (position.pendingExitQty ?? 0));
    if (quantity > available + 1e-9) {
      throw new Error(`submitMarketExit: requested ${quantity} exceeds available ${available} (qty=${position.quantity}, pending=${position.pendingExitQty ?? 0})`);
    }

    const executionId = insertStockExecution(this.db, {
      triggerType: reasonToTrigger(reason),
      positionId,
      sleeve,
      ticker,
      direction: "sell",
      quantity,
      status: "pending",
      notes: reason,
      postFillAction
    });

    // Reserve before yielding to Alpaca so concurrent exits see pending quantity.
    addPendingExit(this.db, positionId, quantity);

    const isFractional = quantity % 1 !== 0;
    let order: AlpacaOrder;
    try {
      order = await this.alpaca.submitOrder({
        symbol: ticker,
        qty: quantity.toString(),
        side: "sell",
        type: "market",
        time_in_force: isFractional ? "day" : "gtc",
        client_order_id: `st-exit-${executionId}-${Date.now()}`
      });
    } catch (error) {
      addPendingExit(this.db, positionId, -quantity);
      updateStockExecutionOrder(this.db, executionId, {
        status: "failed",
        notes: `submit failed: ${error instanceof Error ? error.message : String(error)}`
      });
      throw error;
    }

    updateStockExecutionOrder(this.db, executionId, {
      alpacaOrderId: order.id,
      alpacaClientOrderId: order.client_order_id,
      status: mapOrderStatus(order.status)
    });

    if (mapOrderStatus(order.status) === "filled") {
      const filledPrice = money(order.filled_avg_price ?? undefined);
      const filledQty = money(order.filled_qty) || quantity;
      const slicePnlUsd = filledPrice > 0 ? (filledPrice - position.avgEntryPrice) * filledQty : null;
      if (slicePnlUsd !== null && slicePnlUsd < 0) this.trackWashSaleIfNeeded(ticker, slicePnlUsd);
      if (closeOnFill) {
        closeStockPosition(this.db, positionId, reason, slicePnlUsd, filledQty);
      } else {
        applyPartialFill(this.db, positionId, filledQty, slicePnlUsd);
        applyPostFillAction(this.db, executionId);
      }
    }
    return order;
  }

  private async submitExitSignal(decision: SignalDecision) {
    const positions = openStockPositions(this.db).filter((position) => position.ticker === decision.ticker && position.sleeve === decision.sleeve);
    if (positions.length > 0) {
      await this.alertEngine?.signalIntent(decision).catch(() => {});
    }
    for (const position of positions) {
      await this.submitMarketExit(
        position.id,
        position.ticker,
        position.quantity,
        decision.triggerType === "13f_diff" ? "fund_exit" : "senator_exit",
        position.sleeve
      );
    }
    return null;
  }

  private entryOrderParams(decision: SignalDecision, notional: number, clientOrderId: string, limitPrice: number | null): OrderParams {
    const base = {
      symbol: decision.ticker,
      notional: notional.toFixed(2),
      side: "buy" as const,
      time_in_force: "day" as const,
      client_order_id: clientOrderId
    };

    if (decision.sleeve === "senator" && limitPrice) {
      return {
        ...base,
        type: "limit",
        limit_price: limitPrice.toFixed(2),
        order_class: "oto",
        stop_loss: { stop_price: (limitPrice * 0.92).toFixed(2), limit_price: (limitPrice * 0.9016).toFixed(2) }
      };
    }

    if (limitPrice) {
      return { ...base, type: "limit", limit_price: limitPrice.toFixed(2) };
    }

    return { ...base, type: "market" };
  }

  private async onOrderUpdate(executionId: number, order: AlpacaOrder, decision: SignalDecision) {
    const status = mapOrderStatus(order.status);
    updateStockExecutionFill(this.db, executionId, {
      status,
      filledPrice: money(order.filled_avg_price ?? undefined) || null,
      filledQuantity: money(order.filled_qty),
      amountUsd: order.notional ? money(order.notional) : undefined
    });
    if (status === "filled") {
      await this.createPositionIfNeeded(executionId, order, {
        sleeve: decision.sleeve,
        triggerType: decision.triggerType,
        ticker: decision.ticker,
        senatorName: decision.senatorName ?? null,
        senatorRank: decision.senatorRank ?? null,
        fundName: decision.fundName ?? null,
        sector: typeof decision.metadata?.sector === "string" ? decision.metadata.sector : null
      });
    }
  }

  private async createPositionIfNeeded(
    executionId: number,
    order: AlpacaOrder,
    context: {
      sleeve: "senator" | "13f";
      triggerType: "senator_trade" | "13f_diff" | string;
      ticker: string;
      senatorName?: string | null;
      senatorRank?: number | null;
      fundName?: string | null;
      sector?: string | null;
    }
  ) {
    const existing = openStockPositions(this.db).find((position) => position.entryExecutionId === executionId);
    if (existing) return;
    const quantity = money(order.filled_qty);
    const avgEntryPrice = money(order.filled_avg_price ?? undefined);
    if (quantity <= 0 || avgEntryPrice <= 0) return;

    const stopLossPrice = context.sleeve === "senator" ? avgEntryPrice * 0.92 : avgEntryPrice * 0.88;
    let stopOrderId: string | null = null;

    if (order.order_class === "oto" || order.order_class === "bracket") {
      const openOrders = await this.alpaca.listOrders({ status: "open", symbols: [context.ticker] });
      const childStop = openOrders.find((o) => (o.type === "stop_limit" || o.type === "stop") && o.side === "sell");
      if (childStop) {
        try {
          await this.alpaca.replaceOrder(childStop.id, {
            stop_price: stopLossPrice.toFixed(2),
            limit_price: (stopLossPrice * 0.98).toFixed(2)
          });
          stopOrderId = childStop.id;
        } catch {
          stopOrderId = await this.submitStopLoss(executionId, context.ticker, quantity, stopLossPrice);
        }
      }
    } else {
      stopOrderId = await this.submitStopLoss(executionId, context.ticker, quantity, stopLossPrice);
    }

    insertStockPosition(this.db, {
      ticker: context.ticker,
      sleeve: context.sleeve,
      entryExecutionId: executionId,
      triggerType: context.triggerType === "13f_diff" ? "13f_diff" : "senator_trade",
      quantity,
      avgEntryPrice,
      currentPrice: avgEntryPrice,
      stopLossPrice,
      stopLossOrderId: stopOrderId,
      takeProfitPrice: context.sleeve === "senator" ? avgEntryPrice * 1.25 : null,
      timeStopAt: context.sleeve === "senator" ? addDaysIso(90) : null,
      senatorName: context.senatorName,
      senatorRank: context.senatorRank,
      fundName: context.fundName,
      sector: context.sector
    });
  }

  async resubmitStopLoss(position: { id: number; ticker: string; quantity: number; stopLossPrice?: number | null; avgEntryPrice: number; sleeve: string }): Promise<string | null> {
    const stopPrice = position.stopLossPrice ?? position.avgEntryPrice * (position.sleeve === "senator" ? 0.92 : 0.88);
    try {
      return await this.submitStopLoss(position.id, position.ticker, position.quantity, stopPrice);
    } catch (error) {
      logger.error({ error, positionId: position.id }, "failed to resubmit stop loss");
      return null;
    }
  }

  private async submitStopLoss(executionId: number, ticker: string, quantity: number, stopLossPrice: number) {
    const wholeQty = Math.floor(quantity);
    if (wholeQty < 1) return null;
    const stopOrder = await this.alpaca.submitOrder({
      symbol: ticker,
      qty: wholeQty.toString(),
      side: "sell",
      type: "stop_limit",
      time_in_force: "gtc",
      stop_price: stopLossPrice.toFixed(2),
      limit_price: (stopLossPrice * 0.98).toFixed(2),
      client_order_id: `st-stop-${executionId}-${Date.now()}`
    });
    return stopOrder.id;
  }

  private entryLimitPrice(decision: SignalDecision) {
    const previousClose = numberMeta(decision, "previousClose");
    const currentPrice = numberMeta(decision, "currentPrice");
    if (decision.sleeve === "senator" && previousClose) return previousClose * 1.003;
    if (decision.sleeve === "13f" && currentPrice) return currentPrice * 0.98;
    return null;
  }

  private movedMoreThanFivePercent(decision: SignalDecision) {
    const filingPrice = numberMeta(decision, "filingPrice") ?? numberMeta(decision, "previousClose");
    const currentPrice = numberMeta(decision, "currentPrice");
    return Boolean(filingPrice && currentPrice && Math.abs(currentPrice - filingPrice) / filingPrice > 0.05);
  }

  private shouldCancelByEndOfDay(createdAt: string) {
    void createdAt;
    return isAfterEtTime(15, 45);
  }

  private shouldResubmit(createdAt: string) {
    const ageMs = Date.now() - new Date(createdAt).getTime();
    return ageMs > 2 * 60 * 60 * 1000 && isExecutionWindow();
  }

  private async resubmitLimit(executionId: number, order: AlpacaOrder) {
    if (!order.limit_price) return;
    const currentLimit = money(order.limit_price);
    if (currentLimit <= 0) return;
    const newLimit = currentLimit * 1.005;
    const replaced = await this.alpaca.replaceOrder(order.id, { limit_price: newLimit.toFixed(2) });
    updateStockExecutionOrder(this.db, executionId, {
      alpacaOrderId: replaced.id,
      alpacaClientOrderId: replaced.client_order_id,
      status: mapOrderStatus(replaced.status),
      limitPrice: newLimit,
      notes: "resubmitted after 2h without fill"
    });
  }

  private trackWashSaleIfNeeded(ticker: string, pnlUsd: number) {
    const saleDate = new Date().toISOString().slice(0, 10);
    const cooldown = new Date();
    cooldown.setUTCDate(cooldown.getUTCDate() + 31);
    insertWashSale(this.db, ticker, saleDate, cooldown.toISOString().slice(0, 10), Math.abs(pnlUsd));
  }
}

function mapOrderStatus(status: string) {
  if (status === "filled") return "filled";
  if (status === "partially_filled") return "partial";
  if (status === "canceled") return "cancelled";
  if (status === "expired") return "expired";
  if (["rejected", "stopped", "suspended"].includes(status)) return "failed";
  return "submitted";
}

function isExecutionWindow() {
  return !isBeforeEtTime(10, 0) && !isAfterEtTime(15, 45);
}

function isBeforeEtTime(hour: number, minute: number) {
  const parts = etParts();
  return parts.hour < hour || (parts.hour === hour && parts.minute < minute);
}

function isAfterEtTime(hour: number, minute: number) {
  const parts = etParts();
  return parts.hour > hour || (parts.hour === hour && parts.minute >= minute);
}

function etParts() {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((part) => [part.type, part.value]));
  return { hour: Number(parts.hour), minute: Number(parts.minute) };
}

function numberMeta(decision: SignalDecision, key: string) {
  const value = decision.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function money(value: string | number | undefined) {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addDaysIso(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function reasonToTrigger(reason: string): ExecutionTriggerType {
  if (reason === "take_profit") return "take_profit";
  if (reason === "trailing_stop") return "trailing_stop";
  if (reason === "time_stop") return "time_stop";
  if (reason === "senator_exit") return "senator_exit";
  if (reason === "fund_exit") return "fund_exit";
  return "stop_loss";
}
