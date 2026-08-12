import crypto from "node:crypto";

const normalize = (value = "") => String(value).toLowerCase().trim().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
const hash = (value = "") => value ? crypto.createHash("sha256").update(String(value)).digest("hex") : null;

function similarity(a, b) {
  const x = normalize(a), y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const aa = new Set(x.split(" "));
  const bb = new Set(y.split(" "));
  const intersection = [...aa].filter(v => bb.has(v)).length;
  return intersection / Math.max(aa.size, bb.size, 1);
}

export async function ensureSpamSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS token_spam_signals (
      mint TEXT PRIMARY KEY REFERENCES tokens(mint) ON DELETE CASCADE,
      spam_score NUMERIC DEFAULT 0,
      risk_level TEXT DEFAULT 'CLEAN',
      clone_count INTEGER DEFAULT 0,
      image_matches INTEGER DEFAULT 0,
      name_matches INTEGER DEFAULT 0,
      symbol_matches INTEGER DEFAULT 0,
      creator_matches INTEGER DEFAULT 0,
      reasons JSONB DEFAULT '[]'::jsonb,
      computed_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_token_spam_score ON token_spam_signals(spam_score DESC);
    CREATE INDEX IF NOT EXISTS idx_token_spam_level ON token_spam_signals(risk_level);
    CREATE INDEX IF NOT EXISTS idx_tokens_image_url ON tokens(image_url);
  `);
}

export async function computeTokenSpam(pool, limit = 1000) {
  if (!pool) return { scanned: 0, flagged: 0 };
  await ensureSpamSchema(pool);
  const { rows } = await pool.query(`
    SELECT mint,symbol,name,image_url,market_cap_usd,liquidity_usd,volume_24h_usd,first_seen_at,last_seen_at,
           metadata->'creators' AS creators
    FROM tokens
    ORDER BY last_seen_at DESC NULLS LAST
    LIMIT $1
  `, [Math.min(Math.max(Number(limit) || 1000, 100), 5000)]);

  const imageGroups = new Map();
  const nameGroups = new Map();
  const symbolGroups = new Map();
  for (const token of rows) {
    const imageKey = hash(token.image_url);
    if (imageKey) imageGroups.set(imageKey, [...(imageGroups.get(imageKey) || []), token]);
    const nameKey = normalize(token.name);
    if (nameKey) nameGroups.set(nameKey, [...(nameGroups.get(nameKey) || []), token]);
    const symbolKey = normalize(token.symbol);
    if (symbolKey) symbolGroups.set(symbolKey, [...(symbolGroups.get(symbolKey) || []), token]);
  }

  let flagged = 0;
  for (const token of rows) {
    const imageKey = hash(token.image_url);
    const imageMatches = imageKey ? Math.max(0, (imageGroups.get(imageKey)?.length || 1) - 1) : 0;
    const nameKey = normalize(token.name);
    const exactNameMatches = nameKey ? Math.max(0, (nameGroups.get(nameKey)?.length || 1) - 1) : 0;
    const symbolKey = normalize(token.symbol);
    const symbolMatches = symbolKey ? Math.max(0, (symbolGroups.get(symbolKey)?.length || 1) - 1) : 0;

    let similarNameMatches = 0;
    for (const other of rows) {
      if (other.mint === token.mint || !token.name || !other.name) continue;
      if (similarity(token.name, other.name) >= 0.8) similarNameMatches++;
      if (similarNameMatches >= 50) break;
    }

    const creatorList = Array.isArray(token.creators) ? token.creators.map(x => x?.address || x).filter(Boolean) : [];
    const creatorMatches = creatorList.length ? rows.filter(other => {
      const c = Array.isArray(other.creators) ? other.creators.map(x => x?.address || x).filter(Boolean) : [];
      return c.some(address => creatorList.includes(address));
    }).length - 1 : 0;

    const cloneCount = Math.max(imageMatches, exactNameMatches, similarNameMatches, creatorMatches, 0);
    let score = 0;
    const reasons = [];
    if (imageMatches >= 5) { score += Math.min(40, 10 + imageMatches * 1.5); reasons.push(`same image used by ${imageMatches} other tokens`); }
    if (imageMatches >= 25) { score += 15; reasons.push("large image-clone cluster"); }
    if (exactNameMatches >= 5) { score += Math.min(20, 5 + exactNameMatches); reasons.push(`same name used by ${exactNameMatches} other tokens`); }
    if (similarNameMatches >= 10) { score += Math.min(15, 5 + similarNameMatches * 0.5); reasons.push("highly similar token names"); }
    if (symbolMatches >= 10) { score += Math.min(10, symbolMatches * 0.5); reasons.push("reused symbol cluster"); }
    if (creatorMatches >= 5) { score += Math.min(20, creatorMatches); reasons.push("creator overlap"); }
    const lowLiquidity = Number(token.liquidity_usd || 0) < 5000;
    const lowVolume = Number(token.volume_24h_usd || 0) < 1000;
    if (cloneCount >= 10 && lowLiquidity) { score += 10; reasons.push("clone cluster with low liquidity"); }
    if (cloneCount >= 10 && lowVolume) { score += 5; reasons.push("clone cluster with low volume"); }
    score = Math.min(100, Math.round(score));

    const risk_level = score >= 85 ? "EXTREME_SPAM" : score >= 70 ? "SPAM" : score >= 50 ? "SUSPICIOUS" : score >= 30 ? "CLONE" : "CLEAN";
    if (score >= 50) flagged++;
    await pool.query(`
      INSERT INTO token_spam_signals(mint,spam_score,risk_level,clone_count,image_matches,name_matches,symbol_matches,creator_matches,reasons,computed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT(mint) DO UPDATE SET spam_score=EXCLUDED.spam_score,risk_level=EXCLUDED.risk_level,clone_count=EXCLUDED.clone_count,image_matches=EXCLUDED.image_matches,name_matches=EXCLUDED.name_matches,symbol_matches=EXCLUDED.symbol_matches,creator_matches=EXCLUDED.creator_matches,reasons=EXCLUDED.reasons,computed_at=NOW()
    `, [token.mint, score, risk_level, cloneCount, imageMatches, exactNameMatches + similarNameMatches, symbolMatches, Math.max(creatorMatches, 0), JSON.stringify(reasons)]);
  }
  return { scanned: rows.length, flagged };
}
