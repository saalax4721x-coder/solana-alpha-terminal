CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  label TEXT DEFAULT 'Whale',
  balance_sol NUMERIC DEFAULT 0,
  realized_pnl_sol NUMERIC DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  trades INTEGER DEFAULT 0,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  image_url TEXT,
  decimals INTEGER,
  market_cap_usd NUMERIC,
  price_usd NUMERIC,
  liquidity_usd NUMERIC,
  volume_24h_usd NUMERIC,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS whale_activity (
  id BIGSERIAL PRIMARY KEY,
  signature TEXT UNIQUE NOT NULL,
  wallet_address TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
  mint TEXT REFERENCES tokens(mint) ON DELETE SET NULL,
  action TEXT NOT NULL,
  token_amount NUMERIC DEFAULT 0,
  sol_amount NUMERIC DEFAULT 0,
  timestamp TIMESTAMPTZ NOT NULL,
  raw JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_whale_activity_time ON whale_activity(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_whale_activity_wallet ON whale_activity(wallet_address, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_whale_activity_mint ON whale_activity(mint, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_market_cap ON tokens(market_cap_usd);
