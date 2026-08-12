import { Connection, PublicKey } from "@solana/web3.js";

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = process.env.HELIUS_RPC_URL || (HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : "https://api.mainnet-beta.solana.com");
const connection = new Connection(RPC_URL, "confirmed");
const HELIUS_TX_URL = HELIUS_KEY ? `https://api.helius.xyz/v0/addresses/{address}/transactions?api-key=${HELIUS_KEY}&limit=20` : null;
const HELIUS_ASSET_URL = HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc(method, params = []) {
  if (!HELIUS_ASSET_URL) return null;
  const response = await fetch(HELIUS_ASSET_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  if (!response.ok) throw new Error(`Helius RPC ${response.status}`);
  const json = await response.json();
  if (json.error) throw new Error(json.error.message || "Helius RPC error");
  return json.result;
}

async function ensureSchema(pool) {
  const sql = `
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
  `;
  await pool.query(sql);
}

async function discoverWhales(pool) {
  const result = await connection.getLargestAccounts({ commitment: "confirmed" });
  const accounts = result.value.slice(0, 200);
  for (const account of accounts) {
    const address = account.address.toString();
    const balance = Number(account.lamports) / 1e9;
    await pool.query(
      `INSERT INTO wallets(address, label, balance_sol, last_seen_at, updated_at)
       VALUES($1, 'Whale', $2, NOW(), NOW())
       ON CONFLICT(address) DO UPDATE SET balance_sol = EXCLUDED.balance_sol, last_seen_at = NOW(), updated_at = NOW()`,
      [address, balance]
    );
  }
  return accounts.length;
}

async function fetchWalletTransactions(address) {
  if (!HELIUS_TX_URL) return [];
  const response = await fetch(HELIUS_TX_URL.replace("{address}", address));
  if (!response.ok) throw new Error(`Helius transactions ${response.status}`);
  return response.json();
}

async function getTokenMetadata(mint) {
  try {
    const result = await rpc("getAsset", [mint]);
    const metadata = result?.content?.metadata || {};
    const tokenInfo = result?.token_info || {};
    return {
      symbol: metadata.symbol || tokenInfo.symbol || null,
      name: metadata.name || null,
      image_url: result?.content?.links?.image || null,
      decimals: tokenInfo.decimals ?? null,
      metadata: result || {},
    };
  } catch {
    return { symbol: null, name: null, image_url: null, decimals: null, metadata: {} };
  }
}

async function upsertToken(pool, mint) {
  const existing = await pool.query("SELECT mint FROM tokens WHERE mint=$1", [mint]);
  if (existing.rowCount) {
    await pool.query("UPDATE tokens SET last_seen_at=NOW() WHERE mint=$1", [mint]);
    return;
  }
  const metadata = await getTokenMetadata(mint);
  await pool.query(
    `INSERT INTO tokens(mint,symbol,name,image_url,decimals,metadata,last_seen_at)
     VALUES($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT(mint) DO NOTHING`,
    [mint, metadata.symbol, metadata.name, metadata.image_url, metadata.decimals, JSON.stringify(metadata.metadata)]
  );
}

function parseActivities(wallet, tx) {
  const timestamp = tx.timestamp ? new Date(tx.timestamp * 1000) : new Date();
  const transfers = Array.isArray(tx.tokenTransfers) ? tx.tokenTransfers : [];
  const native = Array.isArray(tx.nativeTransfers) ? tx.nativeTransfers : [];
  const solOut = native.filter((x) => x.fromUserAccount === wallet).reduce((sum, x) => sum + Number(x.amount || 0), 0) / 1e9;
  const solIn = native.filter((x) => x.toUserAccount === wallet).reduce((sum, x) => sum + Number(x.amount || 0), 0) / 1e9;
  const netSol = solOut - solIn;

  if (tx.type === "SWAP" || transfers.length) {
    return transfers.map((transfer) => {
      const incoming = transfer.toUserAccount === wallet;
      const outgoing = transfer.fromUserAccount === wallet;
      if (!incoming && !outgoing) return null;
      return {
        signature: tx.signature,
        mint: transfer.mint || null,
        action: incoming ? "BUY" : "SELL",
        tokenAmount: Number(transfer.tokenAmount || transfer.amount || 0),
        solAmount: Math.abs(netSol),
        timestamp,
        raw: tx,
      };
    }).filter(Boolean);
  }
  return [];
}

async function ingestWallet(pool, wallet) {
  const transactions = await fetchWalletTransactions(wallet);
  let inserted = 0;
  for (const tx of transactions) {
    const activities = parseActivities(wallet, tx);
    for (const activity of activities) {
      if (!activity.mint) continue;
      await upsertToken(pool, activity.mint);
      const result = await pool.query(
        `INSERT INTO whale_activity(signature,wallet_address,mint,action,token_amount,sol_amount,timestamp,raw)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(signature) DO NOTHING`,
        [activity.signature, wallet, activity.mint, activity.action, activity.tokenAmount, activity.solAmount, activity.timestamp, JSON.stringify(activity.raw)]
      );
      if (result.rowCount) inserted++;
    }
  }
  await pool.query("UPDATE wallets SET last_seen_at=NOW(), updated_at=NOW() WHERE address=$1", [wallet]);
  return inserted;
}

export function startIngestion(pool) {
  if (!HELIUS_KEY) {
    console.warn("Whale ingestion disabled: HELIUS_API_KEY is missing");
    return;
  }

  let running = false;
  let offset = 0;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await ensureSchema(pool);
      const tracked = await pool.query("SELECT address FROM wallets ORDER BY balance_sol DESC NULLS LAST LIMIT 200");
      if (tracked.rowCount < 200) await discoverWhales(pool);
      const refreshed = await pool.query("SELECT address FROM wallets ORDER BY balance_sol DESC NULLS LAST LIMIT 200");
      const wallets = refreshed.rows.map((row) => row.address);
      const batch = wallets.slice(offset, offset + 25);
      offset = wallets.length ? (offset + 25) % wallets.length : 0;
      for (const wallet of batch) {
        try {
          await ingestWallet(pool, wallet);
        } catch (error) {
          console.error(`Wallet ingestion failed for ${wallet}:`, error.message || error);
        }
        await sleep(100);
      }
    } catch (error) {
      console.error("Ingestion cycle failed:", error.message || error);
    } finally {
      running = false;
    }
  };

  run();
  setInterval(run, 30000);
}
