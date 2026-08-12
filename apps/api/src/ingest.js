const HELIUS_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = process.env.HELIUS_RPC_URL || (HELIUS_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}` : "https://api.mainnet-beta.solana.com");
const HELIUS_TX_BASE = HELIUS_KEY ? `https://api.helius.xyz/v0/addresses` : null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const ingestionState = {
  running: false, startedAt: null, lastRunAt: null, lastSuccessAt: null, lastError: null,
  walletsDiscovered: 0, walletsTracked: 0, activitiesInserted: 0, freshTokensDiscovered: 0,
  rpcDiscovery: null,
};

async function rpc(method, params = []) {
  const response = await fetch(RPC_URL, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({jsonrpc:"2.0",id:Date.now(),method,params}) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Solana RPC ${response.status}: ${text.slice(0,300)}`);
  const json = JSON.parse(text);
  if (json.error) throw new Error(json.error.message || "Solana RPC error");
  return json.result;
}

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallets (address TEXT PRIMARY KEY,label TEXT DEFAULT 'Whale',balance_sol NUMERIC DEFAULT 0,realized_pnl_sol NUMERIC DEFAULT 0,wins INTEGER DEFAULT 0,losses INTEGER DEFAULT 0,trades INTEGER DEFAULT 0,first_seen_at TIMESTAMPTZ DEFAULT NOW(),last_seen_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS tokens (mint TEXT PRIMARY KEY,symbol TEXT,name TEXT,image_url TEXT,decimals INTEGER,market_cap_usd NUMERIC,price_usd NUMERIC,liquidity_usd NUMERIC,volume_24h_usd NUMERIC,first_seen_at TIMESTAMPTZ DEFAULT NOW(),last_seen_at TIMESTAMPTZ DEFAULT NOW(),metadata JSONB DEFAULT '{}'::jsonb);
    CREATE TABLE IF NOT EXISTS whale_activity (id BIGSERIAL PRIMARY KEY,signature TEXT NOT NULL,wallet_address TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,mint TEXT REFERENCES tokens(mint) ON DELETE SET NULL,action TEXT NOT NULL,token_amount NUMERIC DEFAULT 0,sol_amount NUMERIC DEFAULT 0,timestamp TIMESTAMPTZ NOT NULL,raw JSONB DEFAULT '{}'::jsonb);
    CREATE UNIQUE INDEX IF NOT EXISTS whale_activity_dedupe ON whale_activity(signature,wallet_address,mint,action);
    CREATE INDEX IF NOT EXISTS idx_whale_activity_time ON whale_activity(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_whale_activity_wallet ON whale_activity(wallet_address,timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_whale_activity_mint ON whale_activity(mint,timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_tokens_market_cap ON tokens(market_cap_usd);
  `);
}

async function discoverInitialWallets(pool) {
  try {
    const result = await rpc("getLargestAccounts", [{commitment:"confirmed"}]);
    const accounts = Array.isArray(result?.value) ? result.value : Array.isArray(result) ? result : [];
    ingestionState.rpcDiscovery = { ok:true, resultType:Array.isArray(result) ? "array" : typeof result, keys:result && typeof result === "object" ? Object.keys(result) : [], count:accounts.length };
    let saved = 0;
    for (const account of accounts.slice(0,200)) {
      const address = String(account?.address || "").trim();
      const balance = Number(account?.lamports || 0) / 1e9;
      if (!address) continue;
      await pool.query(`INSERT INTO wallets(address,label,balance_sol,last_seen_at,updated_at) VALUES($1,'Whale',$2,NOW(),NOW()) ON CONFLICT(address) DO UPDATE SET balance_sol=EXCLUDED.balance_sol,last_seen_at=NOW(),updated_at=NOW()`,[address,balance]);
      saved++;
    }
    const configured = (process.env.TRACKED_WALLETS || "").split(",").map(x=>x.trim()).filter(Boolean).slice(0,500);
    for (const address of configured) await pool.query(`INSERT INTO wallets(address,label,last_seen_at,updated_at) VALUES($1,'Tracked',NOW(),NOW()) ON CONFLICT(address) DO NOTHING`,[address]);
    ingestionState.walletsDiscovered = accounts.length;
    return saved;
  } catch (error) {
    ingestionState.rpcDiscovery = { ok:false, error:error instanceof Error ? error.message : String(error) };
    throw error;
  }
}

async function fetchWalletTransactions(address) {
  if (!HELIUS_TX_BASE) return [];
  const response = await fetch(`${HELIUS_TX_BASE}/${encodeURIComponent(address)}/transactions?api-key=${encodeURIComponent(HELIUS_KEY)}&limit=20`);
  const text = await response.text();
  if (!response.ok) throw new Error(`Helius transactions ${response.status}: ${text.slice(0,300)}`);
  const json = JSON.parse(text); return Array.isArray(json) ? json : [];
}

async function getTokenMetadata(mint) {
  try {
    const [asset, marketResponse] = await Promise.all([rpc("getAsset",[mint]),fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`).catch(()=>null)]);
    const metadata=asset?.content?.metadata||{}; const tokenInfo=asset?.token_info||{}; let market={};
    if (marketResponse?.ok) { const json=await marketResponse.json(); const pair=(json.pairs||[]).sort((a,b)=>Number(b.liquidity?.usd||0)-Number(a.liquidity?.usd||0))[0]; if(pair) market={price_usd:Number(pair.priceUsd||0)||null,liquidity_usd:Number(pair.liquidity?.usd||0)||null,volume_24h_usd:Number(pair.volume?.h24||0)||null,market_cap_usd:Number(pair.marketCap||pair.fdv||0)||null}; }
    return {symbol:metadata.symbol||tokenInfo.symbol||null,name:metadata.name||null,image_url:asset?.content?.links?.image||null,decimals:tokenInfo.decimals??null,...market,metadata:asset||{}};
  } catch(error) { console.warn(`Token metadata failed for ${mint}:`,error.message||error); return {symbol:null,name:null,image_url:null,decimals:null,price_usd:null,liquidity_usd:null,volume_24h_usd:null,market_cap_usd:null,metadata:{}}; }
}

async function upsertToken(pool,mint) {
  const m=await getTokenMetadata(mint);
  await pool.query(`INSERT INTO tokens(mint,symbol,name,image_url,decimals,market_cap_usd,price_usd,liquidity_usd,volume_24h_usd,metadata,last_seen_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) ON CONFLICT(mint) DO UPDATE SET symbol=COALESCE(EXCLUDED.symbol,tokens.symbol),name=COALESCE(EXCLUDED.name,tokens.name),image_url=COALESCE(EXCLUDED.image_url,tokens.image_url),decimals=COALESCE(EXCLUDED.decimals,tokens.decimals),market_cap_usd=COALESCE(EXCLUDED.market_cap_usd,tokens.market_cap_usd),price_usd=COALESCE(EXCLUDED.price_usd,tokens.price_usd),liquidity_usd=COALESCE(EXCLUDED.liquidity_usd,tokens.liquidity_usd),volume_24h_usd=COALESCE(EXCLUDED.volume_24h_usd,tokens.volume_24h_usd),metadata=EXCLUDED.metadata,last_seen_at=NOW()`,[mint,m.symbol,m.name,m.image_url,m.decimals,m.market_cap_usd,m.price_usd,m.liquidity_usd,m.volume_24h_usd,JSON.stringify(m.metadata)]);
}

async function indexCounterparties(pool,tx,wallet) {
  const addresses=new Set();
  for(const x of tx.nativeTransfers||[]){if(x.fromUserAccount&&x.fromUserAccount!==wallet)addresses.add(x.fromUserAccount);if(x.toUserAccount&&x.toUserAccount!==wallet)addresses.add(x.toUserAccount);}
  for(const x of tx.tokenTransfers||[]){if(x.fromUserAccount&&x.fromUserAccount!==wallet)addresses.add(x.fromUserAccount);if(x.toUserAccount&&x.toUserAccount!==wallet)addresses.add(x.toUserAccount);}
  for(const address of [...addresses].slice(0,25)) await pool.query(`INSERT INTO wallets(address,label,last_seen_at,updated_at) VALUES($1,'Observed',NOW(),NOW()) ON CONFLICT(address) DO UPDATE SET last_seen_at=NOW(),updated_at=NOW()`,[address]);
}

function parseActivities(wallet,tx){const timestamp=tx.timestamp?new Date(tx.timestamp*1000):new Date();const transfers=Array.isArray(tx.tokenTransfers)?tx.tokenTransfers:[];const native=Array.isArray(tx.nativeTransfers)?tx.nativeTransfers:[];const solOut=native.filter(x=>x.fromUserAccount===wallet).reduce((s,x)=>s+Number(x.amount||0),0)/1e9;const solIn=native.filter(x=>x.toUserAccount===wallet).reduce((s,x)=>s+Number(x.amount||0),0)/1e9;const netSol=solOut-solIn;if(tx.type!=="SWAP"&&!transfers.length)return [];return transfers.map(t=>{const incoming=t.toUserAccount===wallet;const outgoing=t.fromUserAccount===wallet;if(!incoming&&!outgoing)return null;return {signature:tx.signature,mint:t.mint||null,action:incoming?"BUY":"SELL",tokenAmount:Number(t.tokenAmount||t.amount||0),solAmount:Math.abs(netSol),timestamp,raw:tx};}).filter(Boolean);}

async function ingestWallet(pool,wallet){const transactions=await fetchWalletTransactions(wallet);let inserted=0;for(const tx of transactions){await indexCounterparties(pool,tx,wallet);for(const activity of parseActivities(wallet,tx)){if(!activity.mint)continue;await upsertToken(pool,activity.mint);const result=await pool.query(`INSERT INTO whale_activity(signature,wallet_address,mint,action,token_amount,sol_amount,timestamp,raw) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(signature,wallet_address,mint,action) DO NOTHING`,[activity.signature,wallet,activity.mint,activity.action,activity.tokenAmount,activity.solAmount,activity.timestamp,JSON.stringify(activity.raw)]);if(result.rowCount)inserted++;}}await pool.query("UPDATE wallets SET last_seen_at=NOW(),updated_at=NOW() WHERE address=$1",[wallet]);return inserted;}

async function discoverFreshTokens(pool){try{const response=await fetch("https://api.dexscreener.com/token-profiles/latest/v1");if(!response.ok)throw new Error(`DexScreener ${response.status}`);const profiles=await response.json();let count=0;for(const item of(Array.isArray(profiles)?profiles:[]).slice(0,50)){if(item.chainId!=="solana"||!item.tokenAddress)continue;await upsertToken(pool,item.tokenAddress);count++;}ingestionState.freshTokensDiscovered=count;}catch(error){console.error("Fresh token discovery failed:",error.message||error);}}

export async function runIngestionCycle(pool){if(ingestionState.running)return;ingestionState.running=true;ingestionState.lastRunAt=new Date().toISOString();ingestionState.lastError=null;try{await ensureSchema(pool);await discoverInitialWallets(pool);await discoverFreshTokens(pool);const refreshed=await pool.query("SELECT address FROM wallets ORDER BY balance_sol DESC NULLS LAST,last_seen_at DESC LIMIT 200");const wallets=refreshed.rows.map(row=>row.address);ingestionState.walletsTracked=wallets.length;let inserted=0;for(const wallet of wallets.slice(0,25)){try{inserted+=await ingestWallet(pool,wallet);}catch(error){console.error(`Wallet ingestion failed for ${wallet}:`,error.message||error);}await sleep(100);}ingestionState.activitiesInserted+=inserted;ingestionState.lastSuccessAt=new Date().toISOString();}catch(error){ingestionState.lastError=error instanceof Error?error.message:String(error);console.error("Ingestion cycle failed:",error);}finally{ingestionState.running=false;}}

export function startIngestion(pool){if(!HELIUS_KEY){ingestionState.lastError="HELIUS_API_KEY is missing";console.warn("Whale ingestion disabled: HELIUS_API_KEY is missing");return;}ingestionState.startedAt=new Date().toISOString();runIngestionCycle(pool);setInterval(()=>runIngestionCycle(pool),30000);setInterval(()=>discoverFreshTokens(pool),60000);}
