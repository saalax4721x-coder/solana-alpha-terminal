import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.log("Database migration skipped: DATABASE_URL is not configured");
  process.exit(0);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});

try {
  await pool.query(`
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
      signature TEXT NOT NULL,
      wallet_address TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
      mint TEXT REFERENCES tokens(mint) ON DELETE SET NULL,
      action TEXT NOT NULL,
      token_amount NUMERIC DEFAULT 0,
      sol_amount NUMERIC DEFAULT 0,
      timestamp TIMESTAMPTZ NOT NULL,
      raw JSONB DEFAULT '{}'::jsonb
    );

    CREATE UNIQUE INDEX IF NOT EXISTS whale_activity_dedupe
      ON whale_activity(signature, wallet_address, mint, action);

    CREATE TABLE IF NOT EXISTS wallet_positions (
      wallet_address TEXT REFERENCES wallets(address) ON DELETE CASCADE,
      token_mint TEXT REFERENCES tokens(mint) ON DELETE CASCADE,
      token_balance NUMERIC DEFAULT 0,
      cost_basis_usd NUMERIC DEFAULT 0,
      realized_pnl_usd NUMERIC DEFAULT 0,
      unrealized_pnl_usd NUMERIC DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(wallet_address, token_mint)
    );

    CREATE TABLE IF NOT EXISTS wallet_daily_pnl (
      wallet_address TEXT REFERENCES wallets(address) ON DELETE CASCADE,
      day DATE NOT NULL,
      buy_sol NUMERIC DEFAULT 0,
      sell_sol NUMERIC DEFAULT 0,
      realized_pnl_sol NUMERIC DEFAULT 0,
      trades INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(wallet_address, day)
    );

    CREATE TABLE IF NOT EXISTS developer_profiles (
      wallet_address TEXT PRIMARY KEY,
      score NUMERIC DEFAULT 0,
      total_launches INTEGER DEFAULT 0,
      successful_launches INTEGER DEFAULT 0,
      failed_launches INTEGER DEFAULT 0,
      rug_count INTEGER DEFAULT 0,
      success_rate NUMERIC DEFAULT 0,
      avg_peak_market_cap_usd NUMERIC DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS developer_launches (
      developer_wallet TEXT REFERENCES developer_profiles(wallet_address) ON DELETE CASCADE,
      token_mint TEXT REFERENCES tokens(mint) ON DELETE CASCADE,
      launched_at TIMESTAMPTZ,
      peak_market_cap_usd NUMERIC DEFAULT 0,
      current_market_cap_usd NUMERIC DEFAULT 0,
      liquidity_usd NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'UNKNOWN',
      evidence JSONB DEFAULT '{}'::jsonb,
      PRIMARY KEY(developer_wallet, token_mint)
    );

    CREATE TABLE IF NOT EXISTS narratives (
      id BIGSERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'emerging',
      token_count INTEGER DEFAULT 0,
      momentum_score NUMERIC DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS token_narratives (
      token_mint TEXT REFERENCES tokens(mint) ON DELETE CASCADE,
      narrative_id BIGINT REFERENCES narratives(id) ON DELETE CASCADE,
      confidence NUMERIC DEFAULT 0,
      PRIMARY KEY(token_mint, narrative_id)
    );

    CREATE TABLE IF NOT EXISTS kol_accounts (
      id BIGSERIAL PRIMARY KEY,
      handle TEXT UNIQUE NOT NULL,
      display_name TEXT,
      platform TEXT DEFAULT 'twitter',
      followers BIGINT DEFAULT 0,
      score NUMERIC DEFAULT 0,
      win_rate NUMERIC DEFAULT 0,
      average_roi_pct NUMERIC DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS kol_calls (
      id BIGSERIAL PRIMARY KEY,
      kol_id BIGINT REFERENCES kol_accounts(id) ON DELETE CASCADE,
      token_mint TEXT REFERENCES tokens(mint) ON DELETE SET NULL,
      source_url TEXT,
      posted_at TIMESTAMPTZ,
      engagement JSONB DEFAULT '{}'::jsonb,
      entry_price_usd NUMERIC,
      peak_price_usd NUMERIC,
      roi_pct NUMERIC,
      status TEXT DEFAULT 'OPEN',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS token_mentions (
      id BIGSERIAL PRIMARY KEY,
      token_mint TEXT REFERENCES tokens(mint) ON DELETE CASCADE,
      source TEXT NOT NULL,
      source_id TEXT,
      author TEXT,
      url TEXT,
      sentiment NUMERIC DEFAULT 0,
      engagement JSONB DEFAULT '{}'::jsonb,
      mentioned_at TIMESTAMPTZ NOT NULL,
      UNIQUE(source, source_id)
    );

    CREATE TABLE IF NOT EXISTS market_snapshots (
      id BIGSERIAL PRIMARY KEY,
      token_mint TEXT REFERENCES tokens(mint) ON DELETE CASCADE,
      market_cap_usd NUMERIC,
      price_usd NUMERIC,
      liquidity_usd NUMERIC,
      volume_24h_usd NUMERIC,
      captured_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS alpha_alerts (
      id BIGSERIAL PRIMARY KEY,
      mint TEXT REFERENCES tokens(mint) ON DELETE SET NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      smart_wallets INTEGER DEFAULT 0,
      elite_wallets INTEGER DEFAULT 0,
      sol_amount NUMERIC DEFAULT 0,
      smart_money_score NUMERIC DEFAULT 0,
      confidence NUMERIC DEFAULT 0,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_whale_activity_time ON whale_activity(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_whale_activity_wallet ON whale_activity(wallet_address,timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_whale_activity_mint ON whale_activity(mint,timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_wallet_daily_pnl_day ON wallet_daily_pnl(day DESC,realized_pnl_sol DESC);
    CREATE INDEX IF NOT EXISTS idx_developer_score ON developer_profiles(score DESC);
    CREATE INDEX IF NOT EXISTS idx_developer_launches_token ON developer_launches(token_mint);
    CREATE INDEX IF NOT EXISTS idx_narrative_momentum ON narratives(momentum_score DESC);
    CREATE INDEX IF NOT EXISTS idx_kol_calls_posted ON kol_calls(posted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mentions_time ON token_mentions(mentioned_at DESC);
    CREATE INDEX IF NOT EXISTS idx_market_snapshots_token_time ON market_snapshots(token_mint,captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alpha_alerts_created ON alpha_alerts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alpha_alerts_mint ON alpha_alerts(mint,created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_alpha_alerts_dedupe ON alpha_alerts(mint,type,date_trunc('minute',created_at));
  `);
  console.log("Database migration complete: production intelligence schema ready");
} catch (error) {
  console.error("Database migration failed:", error?.message || error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
