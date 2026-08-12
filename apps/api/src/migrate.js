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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_alpha_alerts_created ON alpha_alerts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alpha_alerts_mint ON alpha_alerts(mint, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_alpha_alerts_dedupe
      ON alpha_alerts(mint, type, date_trunc('minute', created_at));
  `);
  console.log("Database migration complete: alpha_alerts ready");
} catch (error) {
  console.error("Database migration failed:", error?.message || error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
