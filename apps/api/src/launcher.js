import "./server.js";
import "./spam-worker.js";
import { startIntelligence } from "./intelligence-worker.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false }, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
  startIntelligence(pool);
}
