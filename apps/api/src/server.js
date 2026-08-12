import express from "express";
import cors from "cors";
import pg from "pg";
import { startIngestion, runIngestionCycle, ingestionState } from "./ingest.js";

const { Pool } = pg;
const app = express();
app.use(cors());
app.use(express.json());

const port = Number(process.env.PORT || 3000);
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
}) : null;

async function ensureSchema() {
  if (!pool) return;
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
    CREATE INDEX IF NOT EXISTS idx_whale_activity_time ON whale_activity(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_whale_activity_wallet ON whale_activity(wallet_address,timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_whale_activity_mint ON whale_activity(mint,timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_tokens_market_cap ON tokens(market_cap_usd);
  `);
}

app.get("/", (_req,res) => res.json({ service:"Solana Alpha Terminal API", status:"online", version:"0.3.0" }));

app.get("/api/health", async (_req,res) => {
  let database = "not configured", databaseError = null, databaseErrorCode = null;
  if (pool) {
    try { await pool.query("SELECT 1"); database = "connected"; }
    catch (error) {
      database = "error";
      databaseError = error instanceof Error ? error.message : String(error);
      databaseErrorCode = error && typeof error === "object" && "code" in error ? error.code : null;
      console.error("Database health check failed:", error);
    }
  }
  res.json({ status:database === "connected" ? "ok" : "degraded", heliusConfigured:Boolean(process.env.HELIUS_API_KEY), database, ...(databaseError ? {databaseError} : {}), ...(databaseErrorCode ? {databaseErrorCode} : {}), timestamp:new Date().toISOString() });
});

app.get("/api/ingestion/status", async (_req,res) => {
  let counts = { wallets:0, tokens:0, activities:0 };
  if (pool) {
    const [wallets,tokens,activities] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS count FROM wallets"),
      pool.query("SELECT COUNT(*)::int AS count FROM tokens"),
      pool.query("SELECT COUNT(*)::int AS count FROM whale_activity"),
    ]);
    counts = { wallets:wallets.rows[0].count, tokens:tokens.rows[0].count, activities:activities.rows[0].count };
  }
  res.json({ heliusConfigured:Boolean(process.env.HELIUS_API_KEY), databaseConfigured:Boolean(pool), ...ingestionState, counts });
});

app.post("/api/ingestion/run", async (_req,res) => {
  if (!pool) return res.status(503).json({ error:"Database not configured" });
  if (ingestionState.running) return res.status(202).json({ status:"already-running", ...ingestionState });
  runIngestionCycle(pool).catch(error => console.error("Manual ingestion failed:",error));
  res.status(202).json({ status:"started", ...ingestionState });
});

app.get("/api/whales", async (req,res) => {
  if (!pool) return res.status(503).json({data:[],error:"Database not configured"});
  const limit = Math.min(Math.max(Number(req.query.limit) || 200,1),500);
  const offset = Math.max(Number(req.query.offset) || 0,0);
  const result = await pool.query(`SELECT address,label,balance_sol,realized_pnl_sol,wins,losses,trades,last_seen_at FROM wallets ORDER BY balance_sol DESC NULLS LAST,last_seen_at DESC LIMIT $1 OFFSET $2`,[limit,offset]);
  const total = await pool.query("SELECT COUNT(*)::int AS count FROM wallets");
  res.json({data:result.rows,page:Math.floor(offset/limit)+1,limit,total:Number(total.rows[0].count)});
});

app.get("/api/whales/activity", async (req,res) => {
  if (!pool) return res.status(503).json({data:[]});
  const limit = Math.min(Math.max(Number(req.query.limit) || 200,1),500);
  const result = await pool.query(`SELECT a.signature,a.wallet_address,a.mint,t.symbol,t.name,t.image_url,a.action,a.token_amount,a.sol_amount,a.timestamp FROM whale_activity a LEFT JOIN tokens t ON t.mint=a.mint ORDER BY a.timestamp DESC LIMIT $1`,[limit]);
  res.json({data:result.rows,limit});
});

app.get("/api/whales/today", async (_req,res) => {
  if (!pool) return res.status(503).json({data:[]});
  const result = await pool.query(`SELECT wallet_address,COUNT(*)::int AS trades,COALESCE(SUM(CASE WHEN action='BUY' THEN sol_amount ELSE 0 END),0) AS buy_sol,COALESCE(SUM(CASE WHEN action='SELL' THEN sol_amount ELSE 0 END),0) AS sell_sol,COALESCE(SUM(CASE WHEN action='SELL' THEN sol_amount ELSE -sol_amount END),0) AS net_flow_sol FROM whale_activity WHERE timestamp >= CURRENT_DATE GROUP BY wallet_address ORDER BY net_flow_sol DESC LIMIT 200`);
  res.json({data:result.rows});
});

app.get("/api/tokens", async (req,res) => {
  if (!pool) return res.status(503).json({data:[]});
  const limit = Math.min(Math.max(Number(req.query.limit) || 200,1),500);
  const maxMarketCap = req.query.maxMarketCap ? Number(req.query.maxMarketCap) : null;
  const result = await pool.query(`SELECT mint,symbol,name,image_url,decimals,market_cap_usd,price_usd,liquidity_usd,volume_24h_usd,first_seen_at,last_seen_at FROM tokens WHERE ($1::numeric IS NULL OR market_cap_usd IS NULL OR market_cap_usd <= $1) ORDER BY last_seen_at DESC LIMIT $2`,[maxMarketCap,limit]);
  res.json({data:result.rows,limit,maxMarketCap});
});

app.get("/api/smart-wallets", async (_req,res) => {
  if (!pool) return res.status(503).json({data:[]});
  const result = await pool.query(`SELECT address,balance_sol,realized_pnl_sol,wins,losses,trades,CASE WHEN trades>0 THEN ROUND((wins::numeric/trades::numeric)*100,2) ELSE 0 END AS win_rate FROM wallets ORDER BY realized_pnl_sol DESC NULLS LAST,win_rate DESC LIMIT 200`);
  res.json({data:result.rows});
});

app.get("/api/tokens/:mint", async (req,res) => {
  if (!pool) return res.status(503).json({error:"Database not configured"});
  const result = await pool.query("SELECT * FROM tokens WHERE mint=$1",[req.params.mint]);
  if (!result.rowCount) return res.status(404).json({error:"Token not indexed yet"});
  res.json(result.rows[0]);
});

app.listen(port,async () => {
  console.log(`Solana Alpha Terminal API listening on port ${port}`);
  if (pool) {
    try { await ensureSchema(); startIngestion(pool); console.log("Live Solana ingestion engine started"); }
    catch (error) { console.error("Failed to start ingestion engine:",error); }
  }
});
