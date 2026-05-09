import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export const schemaSql = `
CREATE TABLE IF NOT EXISTS politicians (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  chamber TEXT NOT NULL CHECK (chamber IN ('senate', 'house')),
  state TEXT,
  party TEXT,
  committees TEXT,
  active INTEGER DEFAULT 1,
  cik TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(name, chamber)
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  politician_id INTEGER NOT NULL REFERENCES politicians(id),
  ticker TEXT,
  asset_name TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  filing_date TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('buy', 'sell', 'exchange')),
  amount_range TEXT,
  amount_midpoint REAL,
  asset_type TEXT DEFAULT 'stock',
  source TEXT NOT NULL,
  source_id TEXT,
  raw_data TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_dedup
ON trades(politician_id, COALESCE(ticker, ''), trade_date, direction, COALESCE(amount_range, ''));

CREATE TABLE IF NOT EXISTS fund_holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fund_name TEXT NOT NULL,
  fund_cik TEXT NOT NULL,
  report_date TEXT NOT NULL,
  filing_date TEXT NOT NULL,
  ticker TEXT,
  cusip TEXT NOT NULL,
  security_name TEXT NOT NULL,
  shares REAL NOT NULL,
  value_thousands REAL NOT NULL,
  change_type TEXT,
  change_shares REAL,
  change_pct REAL,
  UNIQUE(fund_cik, report_date, cusip)
);

CREATE TABLE IF NOT EXISTS rankings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  politician_id INTEGER NOT NULL REFERENCES politicians(id),
  computed_at TEXT NOT NULL,
  score REAL NOT NULL,
  alpha REAL,
  win_rate REAL,
  sharpe REAL,
  profit_factor REAL,
  trade_count INTEGER,
  rank_position INTEGER
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data TEXT,
  discord_sent INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prices (
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,
  close REAL NOT NULL,
  PRIMARY KEY (ticker, date)
);

CREATE TABLE IF NOT EXISTS source_health (
  source TEXT PRIMARY KEY,
  ok INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  message TEXT
);

CREATE TABLE IF NOT EXISTS stock_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('senator_trade', '13f_diff', 'stop_loss', 'take_profit', 'trailing_stop', 'time_stop', 'senator_exit', 'fund_exit', 'manual')),
  trigger_id INTEGER,
  position_id INTEGER REFERENCES stock_positions(id),
  sleeve TEXT NOT NULL CHECK(sleeve IN ('senator', '13f')),
  ticker TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('buy', 'sell')),
  quantity REAL NOT NULL,
  limit_price REAL,
  filled_price REAL,
  filled_quantity REAL,
  amount_usd REAL,
  alpaca_order_id TEXT,
  alpaca_client_order_id TEXT,
  status TEXT CHECK(status IN ('pending', 'submitted', 'partial', 'filled', 'failed', 'cancelled', 'expired')) DEFAULT 'pending',
  senator_name TEXT,
  senator_rank INTEGER,
  fund_name TEXT,
  notes TEXT,
  post_fill_action TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  submitted_at TEXT,
  filled_at TEXT
);

CREATE TABLE IF NOT EXISTS stock_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  sleeve TEXT NOT NULL CHECK(sleeve IN ('senator', '13f')),
  entry_execution_id INTEGER REFERENCES stock_executions(id),
  trigger_type TEXT NOT NULL,
  quantity REAL NOT NULL,
  avg_entry_price REAL NOT NULL,
  current_price REAL,
  stop_loss_price REAL,
  stop_loss_order_id TEXT,
  trailing_stop_active INTEGER DEFAULT 0,
  trailing_stop_pct REAL,
  trailing_stop_order_id TEXT,
  take_profit_price REAL,
  time_stop_at TEXT,
  day30_checked INTEGER DEFAULT 0,
  day60_exited_half INTEGER DEFAULT 0,
  senator_name TEXT,
  senator_rank INTEGER,
  fund_name TEXT,
  sector TEXT,
  status TEXT CHECK(status IN ('open', 'partial', 'closed')) DEFAULT 'open',
  pnl_usd REAL,
  pnl_ratio REAL,
  realized_pnl_usd REAL DEFAULT 0,
  realized_qty REAL DEFAULT 0,
  pending_exit_qty REAL DEFAULT 0,
  opened_at TEXT DEFAULT (datetime('now')),
  closed_at TEXT,
  exit_reason TEXT
);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  total_value REAL NOT NULL,
  senator_sleeve_value REAL,
  thirteenf_sleeve_value REAL,
  cash_value REAL,
  daily_pnl REAL,
  daily_pnl_ratio REAL,
  cumulative_pnl REAL,
  open_positions INTEGER,
  high_water_mark REAL,
  snapshot_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rebalance_runs (
  fund_cik TEXT NOT NULL,
  report_date TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (fund_cik, report_date)
);

CREATE TABLE IF NOT EXISTS wash_sale_tracker (
  ticker TEXT NOT NULL,
  loss_sale_date TEXT NOT NULL,
  cooldown_until TEXT NOT NULL,
  loss_amount REAL,
  PRIMARY KEY (ticker, loss_sale_date)
);

CREATE INDEX IF NOT EXISTS idx_trades_politician ON trades(politician_id);
CREATE INDEX IF NOT EXISTS idx_trades_ticker ON trades(ticker);
CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(trade_date);
CREATE INDEX IF NOT EXISTS idx_trades_filing ON trades(filing_date);
CREATE INDEX IF NOT EXISTS idx_fund_cik ON fund_holdings(fund_cik);
CREATE INDEX IF NOT EXISTS idx_fund_date ON fund_holdings(report_date);
CREATE INDEX IF NOT EXISTS idx_rankings_politician ON rankings(politician_id);
CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(type);
CREATE INDEX IF NOT EXISTS idx_stock_exec_status ON stock_executions(status);
CREATE INDEX IF NOT EXISTS idx_stock_exec_ticker ON stock_executions(ticker);
CREATE INDEX IF NOT EXISTS idx_stock_pos_status ON stock_positions(status);
CREATE INDEX IF NOT EXISTS idx_stock_pos_ticker ON stock_positions(ticker);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON portfolio_snapshots(snapshot_at);
`;

const idempotentMigrations: string[] = [
  "ALTER TABLE stock_executions ADD COLUMN position_id INTEGER REFERENCES stock_positions(id)",
  "ALTER TABLE stock_executions ADD COLUMN post_fill_action TEXT",
  "ALTER TABLE stock_positions ADD COLUMN pending_exit_qty REAL DEFAULT 0",
  "ALTER TABLE stock_positions ADD COLUMN realized_pnl_usd REAL DEFAULT 0",
  "ALTER TABLE stock_positions ADD COLUMN realized_qty REAL DEFAULT 0",
  "ALTER TABLE stock_positions RENAME COLUMN pnl_pct TO pnl_ratio",
  "ALTER TABLE portfolio_snapshots RENAME COLUMN daily_pnl_pct TO daily_pnl_ratio",
  `CREATE TABLE IF NOT EXISTS rebalance_runs (
    fund_cik TEXT NOT NULL,
    report_date TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (fund_cik, report_date)
  )`
];

function runIdempotentMigrations(db: Database.Database) {
  for (const stmt of idempotentMigrations) {
    try {
      db.exec(stmt);
    } catch (error) {
      const message = String((error as Error).message ?? error).toLowerCase();
      const benign = /duplicate column|already exists|no such column/.test(message);
      if (!benign) throw error;
    }
  }
}

export function openDatabase(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.exec(schemaSql);
  runIdempotentMigrations(db);
  return db;
}
