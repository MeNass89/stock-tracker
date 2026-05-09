export type Chamber = "senate" | "house";
export type TradeDirection = "buy" | "sell" | "exchange";
export type AlertSeverity = "high" | "medium" | "low";
export type ExecutionSleeve = "senator" | "13f";
export type ExecutionDirection = "buy" | "sell";
export type ExecutionStatus = "pending" | "submitted" | "partial" | "filled" | "failed" | "cancelled" | "expired";
export type ExecutionTriggerType =
  | "senator_trade"
  | "13f_diff"
  | "stop_loss"
  | "take_profit"
  | "trailing_stop"
  | "time_stop"
  | "senator_exit"
  | "fund_exit"
  | "manual";
export type PositionStatus = "open" | "partial" | "closed";

export interface PoliticianInput {
  name: string;
  chamber: Chamber;
  state?: string | null;
  party?: string | null;
  committees?: string[];
  cik?: string | null;
}

export interface NormalizedTrade {
  politician: PoliticianInput;
  ticker: string | null;
  assetName: string;
  tradeDate: string;
  filingDate: string;
  detectedAt: string;
  direction: TradeDirection;
  amountRange: string | null;
  amountMidpoint: number | null;
  assetType: string;
  source: string;
  sourceId?: string | null;
  rawData?: unknown;
}

export interface StoredTrade extends NormalizedTrade {
  id: number;
  politicianId: number;
}

export interface FundManager {
  manager: string;
  fund: string;
  cik: string;
  tier: 1 | 2 | 3;
  style: string;
  concentration: string;
}

export interface FundHoldingInput {
  fundName: string;
  fundCik: string;
  reportDate: string;
  filingDate: string;
  ticker: string | null;
  cusip: string;
  securityName: string;
  shares: number;
  valueThousands: number;
  putCall?: string | null;
  changeType?: string | null;
  changeShares?: number | null;
  changePct?: number | null;
}

export interface RankingMetrics {
  politicianId: number;
  alpha: number;
  winRate: number;
  sharpe: number;
  profitFactor: number;
  tradeCount: number;
  recencyBonus: number;
}

export interface RankingResult extends RankingMetrics {
  score: number;
  rankPosition: number;
}

export interface AlertInput {
  type: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  data?: unknown;
}

export interface SourceHealth {
  source: string;
  ok: boolean;
  checkedAt: string;
  message?: string;
}

export interface StockExecutionInput {
  triggerType: ExecutionTriggerType;
  triggerId?: number | null;
  positionId?: number | null;
  sleeve: ExecutionSleeve;
  ticker: string;
  direction: ExecutionDirection;
  quantity?: number;
  limitPrice?: number | null;
  filledPrice?: number | null;
  filledQuantity?: number | null;
  amountUsd?: number | null;
  alpacaOrderId?: string | null;
  alpacaClientOrderId?: string | null;
  status?: ExecutionStatus;
  senatorName?: string | null;
  senatorRank?: number | null;
  fundName?: string | null;
  notes?: string | null;
  postFillAction?: string | null;
}

export interface StockExecution extends StockExecutionInput {
  id: number;
  quantity: number;
  status: ExecutionStatus;
  createdAt: string;
  submittedAt?: string | null;
  filledAt?: string | null;
}

export interface StockPositionInput {
  ticker: string;
  sleeve: ExecutionSleeve;
  entryExecutionId?: number | null;
  triggerType: ExecutionTriggerType;
  quantity: number;
  avgEntryPrice: number;
  currentPrice?: number | null;
  stopLossPrice?: number | null;
  stopLossOrderId?: string | null;
  trailingStopActive?: boolean;
  trailingStopPct?: number | null;
  trailingStopOrderId?: string | null;
  takeProfitPrice?: number | null;
  timeStopAt?: string | null;
  day30Checked?: boolean;
  day60ExitedHalf?: boolean;
  senatorName?: string | null;
  senatorRank?: number | null;
  fundName?: string | null;
  sector?: string | null;
  status?: PositionStatus;
  pnlUsd?: number | null;
  pnlRatio?: number | null;
  realizedPnlUsd?: number | null;
  realizedQty?: number | null;
  pendingExitQty?: number | null;
  exitReason?: string | null;
}

export interface StockPosition extends StockPositionInput {
  id: number;
  trailingStopActive: boolean;
  day30Checked: boolean;
  day60ExitedHalf: boolean;
  status: PositionStatus;
  openedAt: string;
  closedAt?: string | null;
}
