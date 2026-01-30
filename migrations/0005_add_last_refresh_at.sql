-- Add last_refresh_at to track when tokens were last refreshed (for batch progression)
ALTER TABLE tokens ADD COLUMN last_refresh_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_tokens_last_refresh_at ON tokens(last_refresh_at);
