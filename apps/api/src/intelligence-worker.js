import crypto from "node:crypto";

const INTERVAL_MS = Math.max(Number(process.env.INTELLIGENCE_INTERVAL_MS || 60000), 30000);
const TOP_TOKEN_SCAN = Math.min(Math.max(Number(process.env.INTELLIGENCE_TOKEN_SCAN || 5000), 500), 10000);

const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
const hash = (v) => crypto.createHash("sha256").update(String(v || "")).digest("hex");
const clamp = (n, a = 0, b = 100) => Math.max(a, Math.min(b, Number(n) || 0));
const similarity = (a, b) => {
  const x = new Set(norm(a).split(" ").filter(Boolean));
  const y = new Set(norm(b).split(" ").filter(Boolean));
  if (!x.size || !y.size) return 0;
  let hit = 0; for (const v of x) if (y.has(v)) hit++;
  return hit / Math.max(x.size, y.size);
};

function classifyNarratives(name, symbol, metadata = {}) {
  const text = `${norm(name)} ${norm(symbol)} ${norm(metadata?.description)} ${norm(metadata?.content?.metadata?.description)}`;
  const rules = [
    ["AI", /\b(ai|gpt|agent|agents|artificial intelligence|llm|neural|robot)\b/],
    ["TRUMP", /\b(trump|maga|melania|america|usa|patriot|political)\b/],
    ["ANIMAL", /\b(dog|cat|frog|pepe|shib|inu|doge|goat|penguin|bear|wolf|ape|monkey|fish|bird|hamster|animal)\b/],
    ["UTILITY", /\b(utility|protocol|platform|oracle|payments|payment|infrastructure|infra|tool|tools|data)\b/],
    ["DEFI", /\b(defi|dex|swap|yield|lending|liquidity|finance|staking)\b/],
    ["GAMING", /\b(game|gaming|arcade|esports|metaverse|play)\b/],
    ["MEME", /\b(meme|memecoin|coin|moon|pepe|bonk|wif|doge|shib)\b/],
    ["CELEBRITY", /\b(celebrity|elon|taylor|celebrity|rapper|star)\b/],
    ["SPORTS", /\b(nfl|nba|football|soccer|baseball|basketball|sport|sports)\b/],
  ];
  const out = rules.filter(([, r]) => r.test(text)).map(([n]) => n);
  return out.length ? [...new Set(out)] : ["OTHER"];
}

async function ensureIntelligenceSchema(pool) {
  await pool.query(`
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS token_stage TEXT DEFAULT 'UNKNOWN';
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS launch_type TEXT DEFAULT 'UNKNOWN';
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS spam_score NUMERIC DEFAULT 0;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS bundle_score NUMERIC DEFAULT 0;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS bot_score NUMERIC DEFAULT 0;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS organic_score NUMERIC DEFAULT 0;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS holder_concentration NUMERIC DEFAULT 0;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS risk_score NUMERIC DEFAULT 0;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS alpha_score NUMERIC DEFAULT 0;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS image_fingerprint TEXT;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS name_fingerprint TEXT;
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS classified_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_tokens_stage ON tokens(token_stage);
    CREATE INDEX IF NOT EXISTS idx_tokens_spam ON tokens(spam_score DESC);
    CREATE INDEX IF NOT EXISTS idx_tokens_alpha ON tokens(alpha_score DESC);
    CREATE INDEX IF NOT EXISTS idx_tokens_image_fp ON tokens(image_fingerprint);
    CREATE INDEX IF NOT EXISTS idx_tokens_name_fp ON tokens(name_fingerprint);

    CREATE TABLE IF NOT EXISTS token_narratives (
      mint TEXT NOT NULL REFERENCES tokens(mint) ON DELETE CASCADE,
      narrative TEXT NOT NULL,
      confidence NUMERIC DEFAULT 0,
      source TEXT DEFAULT 'heuristic',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(mint,narrative)
    );
    CREATE INDEX IF NOT EXISTS idx_token_narratives_narrative ON token_narratives(narrative,updated_at DESC);

    CREATE TABLE IF NOT EXISTS token_relationships (
      id BIGSERIAL PRIMARY KEY,
      mint TEXT NOT NULL REFERENCES tokens(mint) ON DELETE CASCADE,
      related_mint TEXT NOT NULL REFERENCES tokens(mint) ON DELETE CASCADE,
      relation_type TEXT NOT NULL,
      confidence NUMERIC DEFAULT 0,
      evidence JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(mint,related_mint,relation_type)
    );
    CREATE INDEX IF NOT EXISTS idx_token_relationships_mint ON token_relationships(mint,confidence DESC);

    CREATE TABLE IF NOT EXISTS dev_profiles (
      address TEXT PRIMARY KEY,
      launches INTEGER DEFAULT 0,
      successful_launches INTEGER DEFAULT 0,
      failed_launches INTEGER DEFAULT 0,
      suspicious_launches INTEGER DEFAULT 0,
      avg_peak_multiple NUMERIC DEFAULT 0,
      success_rate NUMERIC DEFAULT 0,
      risk_score NUMERIC DEFAULT 0,
      dev_score NUMERIC DEFAULT 0,
      first_seen_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
      metadata JSONB DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS idx_dev_profiles_score ON dev_profiles(dev_score DESC);

    CREATE TABLE IF NOT EXISTS dev_launches (
      mint TEXT PRIMARY KEY REFERENCES tokens(mint) ON DELETE CASCADE,
      dev_address TEXT NOT NULL,
      launched_at TIMESTAMPTZ,
      market_cap_usd NUMERIC DEFAULT 0,
      liquidity_usd NUMERIC DEFAULT 0,
      volume_24h_usd NUMERIC DEFAULT 0,
      outcome TEXT DEFAULT 'UNKNOWN',
      evidence JSONB DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dev_launches_dev ON dev_launches(dev_address,updated_at DESC);

    CREATE TABLE IF NOT EXISTS daily_wallet_pnl (
      wallet_address TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
      day DATE NOT NULL,
      buy_sol NUMERIC DEFAULT 0,
      sell_sol NUMERIC DEFAULT 0,
      realized_pnl_sol NUMERIC DEFAULT 0,
      buy_count INTEGER DEFAULT 0,
      sell_count INTEGER DEFAULT 0,
      tokens_traded INTEGER DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(wallet_address,day)
    );

    CREATE TABLE IF NOT EXISTS market_snapshots (
      id BIGSERIAL PRIMARY KEY,
      mint TEXT NOT NULL REFERENCES tokens(mint) ON DELETE CASCADE,
      market_cap_usd NUMERIC,
      liquidity_usd NUMERIC,
      volume_24h_usd NUMERIC,
      holder_count INTEGER,
      smart_money_score NUMERIC,
      spam_score NUMERIC,
      risk_score NUMERIC,
      alpha_score NUMERIC,
      captured_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_market_snapshots_mint_time ON market_snapshots(mint,captured_at DESC);
  `);
}

function getDevAddress(metadata) {
  const candidates = [
    metadata?.authorities?.[0]?.address,
    metadata?.authorities?.[0],
    metadata?.creators?.[0]?.address,
    metadata?.creators?.[0],
    metadata?.content?.metadata?.updateAuthority,
    metadata?.ownership?.owner,
  ];
  return candidates.find(v => typeof v === "string" && v.length >= 20) || null;
}

async function classifyTokens(pool) {
  const { rows } = await pool.query(`SELECT mint,name,symbol,image_url,market_cap_usd,liquidity_usd,volume_24h_usd,first_seen_at,last_seen_at,metadata FROM tokens ORDER BY last_seen_at DESC NULLS LAST LIMIT $1`, [TOP_TOKEN_SCAN]);
  const imageCounts = new Map(); const nameCounts = new Map();
  for (const t of rows) { if (t.image_url) imageCounts.set(hash(norm(t.image_url)), (imageCounts.get(hash(norm(t.image_url))) || 0) + 1); if (t.name) nameCounts.set(norm(t.name), (nameCounts.get(norm(t.name)) || 0) + 1); }

  for (const t of rows) {
    const imageFp = t.image_url ? hash(norm(t.image_url)) : null;
    const nameFp = t.name ? hash(norm(t.name)) : null;
    const cloneCount = imageFp ? imageCounts.get(imageFp) || 1 : 1;
    const sameName = t.name ? nameCounts.get(norm(t.name)) || 1 : 1;
    const spamScore = clamp((cloneCount >= 50 ? 80 : cloneCount >= 20 ? 60 : cloneCount >= 5 ? 35 : 0) + (sameName >= 50 ? 20 : sameName >= 10 ? 12 : sameName >= 5 ? 6 : 0));
    const ageHours = Math.max(0, (Date.now() - new Date(t.first_seen_at || Date.now()).getTime()) / 3600000);
    const mc = Number(t.market_cap_usd || 0), liq = Number(t.liquidity_usd || 0), vol = Number(t.volume_24h_usd || 0);
    const stage = ageHours < 6 ? "FRESH" : ageHours < 72 ? "NEW" : ageHours < 24 * 30 ? "EMERGING" : mc >= 100000000 ? "ESTABLISHED" : "MATURE";
    const liquidityRisk = liq <= 1000 ? 35 : liq <= 10000 ? 20 : liq <= 50000 ? 10 : 0;
    const volumeRisk = vol > 0 && liq > 0 && vol / liq > 50 ? 25 : vol > 0 && liq > 0 && vol / liq > 20 ? 12 : 0;
    const botScore = clamp(volumeRisk + (sameName > 10 ? 10 : 0));
    const bundleScore = clamp((sameName >= 10 ? 15 : 0) + (cloneCount >= 10 ? 15 : 0) + (ageHours < 2 && liq < 50000 ? 15 : 0));
    const organicScore = clamp(100 - spamScore * 0.55 - botScore * 0.45);
    const riskScore = clamp(spamScore * 0.45 + bundleScore * 0.25 + botScore * 0.2 + liquidityRisk * 0.1);
    const narratives = classifyNarratives(t.name, t.symbol, t.metadata || {});
    const narrativeBoost = narratives.includes("AI") || narratives.includes("MEME") ? 8 : 0;
    const alphaScore = clamp(100 - riskScore * 0.65 + narrativeBoost + (liq >= 100000 ? 8 : liq >= 25000 ? 4 : 0));
    const launchType = bundleScore >= 60 ? "BUNDLED" : bundleScore >= 30 ? "COORDINATED" : "NORMAL";

    await pool.query(`UPDATE tokens SET token_stage=$2,launch_type=$3,spam_score=$4,bundle_score=$5,bot_score=$6,organic_score=$7,risk_score=$8,alpha_score=$9,image_fingerprint=$10,name_fingerprint=$11,classified_at=NOW() WHERE mint=$1`, [t.mint,stage,launchType,spamScore,bundleScore,botScore,organicScore,riskScore,alphaScore,imageFp,nameFp]);
    await pool.query(`DELETE FROM token_narratives WHERE mint=$1`, [t.mint]);
    for (const narrative of narratives) await pool.query(`INSERT INTO token_narratives(mint,narrative,confidence,source) VALUES($1,$2,$3,'heuristic') ON CONFLICT(mint,narrative) DO UPDATE SET confidence=EXCLUDED.confidence,updated_at=NOW()`, [t.mint,narrative,Math.max(55, Math.min(98, 70 + (narratives.length === 1 ? 15 : 0)))]);
    if (imageFp || nameFp) {
      const related = rows.filter(x => x.mint !== t.mint && ((imageFp && x.image_url && hash(norm(x.image_url)) === imageFp) || (nameFp && x.name && hash(norm(x.name)) === nameFp) || similarity(t.name,x.name) >= 0.9)).slice(0,50);
      for (const r of related) {
        const sameImage = imageFp && r.image_url && hash(norm(r.image_url)) === imageFp;
        const sameName = nameFp && r.name && hash(norm(r.name)) === nameFp;
        const type = sameImage && sameName ? "IMAGE_AND_NAME_CLONE" : sameImage ? "IMAGE_CLONE" : "NAME_CLONE";
        const confidence = sameImage && sameName ? 99 : sameImage ? 90 : 82;
        await pool.query(`INSERT INTO token_relationships(mint,related_mint,relation_type,confidence,evidence) VALUES($1,$2,$3,$4,$5) ON CONFLICT(mint,related_mint,relation_type) DO UPDATE SET confidence=EXCLUDED.confidence,evidence=EXCLUDED.evidence`, [t.mint,r.mint,type,confidence,JSON.stringify({sameImage:Boolean(sameImage),sameName:Boolean(sameName)})]);
      }
    }
    await pool.query(`INSERT INTO market_snapshots(mint,market_cap_usd,liquidity_usd,volume_24h_usd,smart_money_score,spam_score,risk_score,alpha_score) SELECT $1,market_cap_usd,liquidity_usd,volume_24h_usd,COALESCE((SELECT smart_money_score FROM token_intelligence WHERE mint=$1),0),spam_score,risk_score,alpha_score FROM tokens WHERE mint=$1`, [t.mint]);
  }
}

async function computeDailyPnl(pool) {
  await pool.query(`INSERT INTO daily_wallet_pnl(wallet_address,day,buy_sol,sell_sol,realized_pnl_sol,buy_count,sell_count,tokens_traded,updated_at)
    SELECT wallet_address,CURRENT_DATE,COALESCE(SUM(sol_amount) FILTER(WHERE action='BUY'),0),COALESCE(SUM(sol_amount) FILTER(WHERE action='SELL'),0),COALESCE(SUM(sol_amount) FILTER(WHERE action='SELL'),0)-COALESCE(SUM(sol_amount) FILTER(WHERE action='BUY'),0),COUNT(*) FILTER(WHERE action='BUY'),COUNT(*) FILTER(WHERE action='SELL'),COUNT(DISTINCT mint),NOW()
    FROM whale_activity WHERE timestamp >= CURRENT_DATE GROUP BY wallet_address
    ON CONFLICT(wallet_address,day) DO UPDATE SET buy_sol=EXCLUDED.buy_sol,sell_sol=EXCLUDED.sell_sol,realized_pnl_sol=EXCLUDED.realized_pnl_sol,buy_count=EXCLUDED.buy_count,sell_count=EXCLUDED.sell_count,tokens_traded=EXCLUDED.tokens_traded,updated_at=NOW()`);
  await pool.query(`UPDATE wallets w SET realized_pnl_sol=d.realized_pnl_sol,trades=d.buy_count+d.sell_count,updated_at=NOW() FROM daily_wallet_pnl d WHERE d.wallet_address=w.address AND d.day=CURRENT_DATE`);
}

async function computeDevs(pool) {
  const { rows } = await pool.query(`SELECT mint,first_seen_at,market_cap_usd,liquidity_usd,volume_24h_usd,metadata FROM tokens WHERE metadata IS NOT NULL LIMIT $1`, [TOP_TOKEN_SCAN]);
  for (const t of rows) {
    const dev = getDevAddress(t.metadata || {}); if (!dev) continue;
    const outcome = Number(t.market_cap_usd || 0) >= 1000000 ? "SUCCESSFUL" : Number(t.market_cap_usd || 0) < 5000 ? "FAILED" : "ACTIVE";
    await pool.query(`INSERT INTO dev_launches(mint,dev_address,launched_at,market_cap_usd,liquidity_usd,volume_24h_usd,outcome,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(mint) DO UPDATE SET dev_address=EXCLUDED.dev_address,market_cap_usd=EXCLUDED.market_cap_usd,liquidity_usd=EXCLUDED.liquidity_usd,volume_24h_usd=EXCLUDED.volume_24h_usd,outcome=EXCLUDED.outcome,updated_at=NOW()`, [t.mint,dev,t.first_seen_at,t.market_cap_usd||0,t.liquidity_usd||0,t.volume_24h_usd||0,outcome,JSON.stringify({source:"Helius asset metadata"})]);
  }
  await pool.query(`INSERT INTO dev_profiles(address,launches,successful_launches,failed_launches,suspicious_launches,avg_peak_multiple,success_rate,risk_score,dev_score,last_seen_at)
    SELECT dev_address,COUNT(*)::int,COUNT(*) FILTER(WHERE outcome='SUCCESSFUL')::int,COUNT(*) FILTER(WHERE outcome='FAILED')::int,COUNT(*) FILTER(WHERE outcome='SUSPICIOUS')::int,AVG(GREATEST(market_cap_usd,0))/NULLIF(AVG(NULLIF(liquidity_usd,0)),0),COUNT(*) FILTER(WHERE outcome='SUCCESSFUL')*100.0/NULLIF(COUNT(*),0),COUNT(*) FILTER(WHERE outcome='FAILED')*100.0/NULLIF(COUNT(*),0),GREATEST(0,LEAST(100,COUNT(*) FILTER(WHERE outcome='SUCCESSFUL')*20-COUNT(*) FILTER(WHERE outcome='FAILED')*15)),NOW() FROM dev_launches GROUP BY dev_address
    ON CONFLICT(address) DO UPDATE SET launches=EXCLUDED.launches,successful_launches=EXCLUDED.successful_launches,failed_launches=EXCLUDED.failed_launches,suspicious_launches=EXCLUDED.suspicious_launches,avg_peak_multiple=EXCLUDED.avg_peak_multiple,success_rate=EXCLUDED.success_rate,risk_score=EXCLUDED.risk_score,dev_score=EXCLUDED.dev_score,last_seen_at=NOW()`);
}

export async function runIntelligenceCycle(pool) {
  if (!pool) return;
  try {
    await ensureIntelligenceSchema(pool);
    await classifyTokens(pool);
    await computeDailyPnl(pool);
    await computeDevs(pool);
    console.log("Intelligence cycle completed");
  } catch (error) {
    console.error("Intelligence cycle failed:", error?.message || error);
  }
}

export function startIntelligence(pool) {
  if (!pool) return;
  runIntelligenceCycle(pool);
  setInterval(() => runIntelligenceCycle(pool), INTERVAL_MS);
}
