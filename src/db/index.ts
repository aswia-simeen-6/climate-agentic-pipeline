/**
 * src/db/index.ts
 *
 * Initializes and exports the Drizzle ORM database client backed by
 * a node-postgres connection pool.  The connection string is sourced
 * exclusively from DATABASE_URL so that credentials never appear in code.
 */

import * as dotenv from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

dotenv.config();

// ─── Validate required environment variable ───────────────────────────────────

const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  throw new Error(
    "[db/index] DATABASE_URL is not defined. " +
    "Copy .env.example → .env and supply a valid PostgreSQL connection string.",
  );
}

// ─── Create a pooled connection ───────────────────────────────────────────────

const pool = new Pool({
  connectionString,
  /**
   * Keep a modest pool ceiling so the pipeline does not exhaust Postgres
   * max_connections when running multiple concurrent agent invocations.
   */
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Surface pool-level errors rather than letting them crash the process silently.
pool.on("error", (err: Error) => {
  console.error("[db/index] Unexpected error on idle pg client:", err.message);
});

// ─── Drizzle instance ─────────────────────────────────────────────────────────

export const db = drizzle(pool, {
  schema,
  logger: process.env["NODE_ENV"] === "development",
});

/**
 * Exported pool reference for callers that need to drain connections on
 * graceful shutdown (e.g. `await pool.end()` in server teardown).
 */
export { pool };

export type Database = typeof db;
