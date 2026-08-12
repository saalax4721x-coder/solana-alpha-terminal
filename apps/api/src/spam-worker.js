import pg from "pg";
import { computeTokenSpam } from "./spam.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false }, max: 3, connectionTimeoutMillis: 10000 }) : null;

async function run() {
  if (!pool) return;
  try {
    const result = await computeTokenSpam(pool, 2000);
    console.log(`Spam detection: scanned ${result.scanned} tokens, flagged ${result.flagged}`);
  } catch (error) {
    console.error("Spam detection failed:", error?.message || error);
  }
}

if (pool) {
  await run();
  setInterval(run, 60000);
}
