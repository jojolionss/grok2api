-- Tavily API Keys management table

CREATE TABLE IF NOT EXISTS tavily_keys (
  key TEXT PRIMARY KEY,
  alias TEXT NOT NULL DEFAULT '',
  total_quota INTEGER NOT NULL DEFAULT 1000,
  used_quota INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_invalid INTEGER NOT NULL DEFAULT 0,
  invalid_reason TEXT,
  last_used_at INTEGER,
  last_sync_at INTEGER,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_failure_reason TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tavily_keys_active ON tavily_keys(is_active);
CREATE INDEX IF NOT EXISTS idx_tavily_keys_invalid ON tavily_keys(is_invalid);

-- Tavily key sync progress (similar to token refresh progress)
CREATE TABLE IF NOT EXISTS tavily_sync_progress (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  running INTEGER NOT NULL DEFAULT 0,
  current INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO tavily_sync_progress (id, running, current, total, success, failed, updated_at)
VALUES (1, 0, 0, 0, 0, 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
