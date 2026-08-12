CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  label TEXT,
  wallet_score NUMERIC(10,2) DEFAULT 0,
  balance_sol NUMERIC(30,9) DEFAULT 0,
  first_seen_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  name TEXT,
  symbol TEXT,
  image_url TEXT,
  decimals INTEGER,
  market_cap_usd NUMERIC(30,2),
  liquidity_usd NUMERIC(30,2),
  first_seen_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  creator_wallet TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  signature TEXT PRIMARY KEY,
  slot BIGINT,
  wallet_address TEXT REFERENCES wallets(address),
  token_mint TEXT REFERENCES tokens(mint),
  action TEXT,
  sol_amount NUMERIC(30,9),
  token_amount NUMERIC(40,12),
  block_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS developer_profiles (
  wallet_address TEXT PRIMARY KEY,
  score NUMERIC(10,2) DEFAULT 0,
  total_launches INTEGER DEFAULT 0,
  successful_launches INTEGER DEFAULT 0,
  failed_launches INTEGER DEFAULT 0,
  rug_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS narratives (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'emerging',
  token_count INTEGER DEFAULT 0,
  momentum_score NUMERIC(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS token_narratives (
  token_mint TEXT REFERENCES tokens(mint) ON DELETE CASCADE,
  narrative_id BIGINT REFERENCES narratives(id) ON DELETE CASCADE,
  confidence NUMERIC(5,2) DEFAULT 0,
  PRIMARY KEY (token_mint, narrative_id)
);

CREATE TABLE IF NOT EXISTS wallet_positions (
  wallet_address TEXT REFERENCES wallets(address) ON DELETE CASCADE,
  token_mint TEXT REFERENCES tokens(mint) ON DELETE CASCADE,
  token_balance NUMERIC(40,12) DEFAULT 0,
  cost_basis_usd NUMERIC(30,2) DEFAULT 0,
  realized_pnl_usd NUMERIC(30,2) DEFAULT 0,
  unrealized_pnl_usd NUMERIC(30,2) DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (wallet_address, token_mint)
);

CREATE INDEX IF NOT EXISTS idx_transactions_wallet_time ON transactions(wallet_address, block_time DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_token_time ON transactions(token_mint, block_time DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_market_cap ON tokens(market_cap_usd);
CREATE INDEX IF NOT EXISTS idx_tokens_first_seen ON tokens(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallets_score ON wallets(wallet_score DESC);
