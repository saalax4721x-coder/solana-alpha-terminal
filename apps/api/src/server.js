import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;

const app = express();
app.use(cors());
app.use(express.json());

const port = Number(process.env.PORT || 3000);
const databaseUrl = process.env.DATABASE_URL;

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes("railway") ? { rejectUnauthorized: false } : undefined,
    })
  : null;

app.get("/", (_req, res) => {
  res.json({
    service: "Solana Alpha Terminal API",
    status: "online",
    version: "0.1.0",
  });
});

app.get("/api/health", async (_req, res) => {
  let database = "not configured";

  if (pool) {
    try {
      await pool.query("SELECT 1");
      database = "connected";
    } catch {
      database = "error";
    }
  }

  res.json({
    status: database === "connected" ? "ok" : "degraded",
    heliusConfigured: Boolean(process.env.HELIUS_API_KEY),
    database,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/whales", (_req, res) => {
  res.json({
    data: [],
    page: 1,
    limit: 50,
    total: 0,
    message: "Whale ingestion engine is the next module to enable.",
  });
});

app.listen(port, () => {
  console.log(`Solana Alpha Terminal API listening on port ${port}`);
});
