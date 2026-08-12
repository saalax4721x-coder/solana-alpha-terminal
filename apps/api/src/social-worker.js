import https from 'node:https';

const APIFY_ACTOR_A = process.env.X_APIFY_ACTOR_A || 'scrapesmith~x-twitter-search-scraper';
const APIFY_ACTOR_B = process.env.X_APIFY_ACTOR_B || 'data-slayer~twitter-search';
const intervalMs = Number(process.env.X_SOCIAL_INTERVAL_MS || 300000);

function getJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: options.method || 'GET', headers: options.headers || {} }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body || '{}') }); }
        catch { reject(new Error(`Invalid JSON response (${res.statusCode})`)); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function runApify(actor, token, input) {
  if (!token) return { configured: false, data: [] };
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  const r = await getJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });
  if (r.status < 200 || r.status >= 300) throw new Error(`Apify ${actor} returned ${r.status}`);
  return { configured: true, data: Array.isArray(r.data) ? r.data : [] };
}

function normalizeTweet(x, source) {
  const author = x.author || x.user || {};
  const username = author.userName || author.username || x.userName || x.username || null;
  return {
    source,
    id: String(x.id || x.tweetId || x.id_str || ''),
    text: x.text || x.fullText || x.full_text || '',
    created_at: x.createdAt || x.created_at || null,
    username,
    display_name: author.name || x.name || null,
    followers: Number(author.followers || author.followersCount || x.followers || 0),
    likes: Number(x.likeCount || x.likes || x.favoriteCount || 0),
    reposts: Number(x.retweetCount || x.retweets || 0),
    replies: Number(x.replyCount || x.replies || 0),
    views: Number(x.viewCount || x.views || 0),
    url: x.url || (username && x.id ? `https://x.com/${username}/status/${x.id}` : null)
  };
}

function dedupe(rows) {
  const map = new Map();
  for (const row of rows) if (row.id) map.set(row.id, row);
  return [...map.values()];
}

export async function runSocialSync() {
  const queries = (process.env.X_KOL_QUERIES || 'solana meme coin,solana ai,solana token,crypto gem').split(',').map(x => x.trim()).filter(Boolean);
  const input = { searchTerms: queries, sort: 'Latest', maxTweets: Number(process.env.X_MAX_TWEETS_PER_QUERY || 20) };
  const results = await Promise.allSettled([
    runApify(APIFY_ACTOR_A, process.env.APIFY_API_TOKEN_A || process.env.APIFY_API_TOKEN, input),
    runApify(APIFY_ACTOR_B, process.env.APIFY_API_TOKEN_B, input)
  ]);
  const rows = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') rows.push(...results[i].value.data.map(x => normalizeTweet(x, i === 0 ? 'apify_a' : 'apify_b')));
    else console.error(`Social source ${i + 1} failed:`, results[i].reason?.message || results[i].reason);
  }
  const unique = dedupe(rows);
  const kolMentions = unique.filter(x => /\$[A-Za-z0-9]{2,12}|solana|pump\.fun|raydium|jupiter|memecoin|meme coin|ai token/i.test(x.text));
  console.log(`Social sync: ${unique.length} unique posts, ${kolMentions.length} crypto-relevant posts`);
  return { posts: unique, relevant: kolMentions };
}

export function startSocialWorker() {
  if (!process.env.APIFY_API_TOKEN && !process.env.APIFY_API_TOKEN_A && !process.env.APIFY_API_TOKEN_B) {
    console.log('Social worker disabled: no Apify API token configured');
    return;
  }
  const run = () => runSocialSync().catch(e => console.error('Social sync failed:', e.message || e));
  run();
  setInterval(run, intervalMs);
}
