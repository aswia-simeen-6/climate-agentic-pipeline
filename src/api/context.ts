/**
 * src/api/context.ts
 *
 * Per-request tRPC context factory.
 *
 * The context is created once per HTTP request by the standalone adapter and
 * then passed to every procedure.  It carries:
 *   - `db`        : The singleton Drizzle ORM database client.
 *   - `requestId` : A per-request correlation ID, sourced from the incoming
 *                   `X-Request-ID` header or generated as a UUID v4.
 *
 * The `db` instance is module-level (pooled connection), so it is safe to
 * share across concurrent requests.  Never open a new pool per request.
 */

import type { CreateHTTPContextOptions } from "@trpc/server/adapters/standalone";
import { v4 as uuidv4 } from "uuid";
import { db } from "../db/index";
import type { Database } from "../db/index";

// ─── Context Interface ────────────────────────────────────────────────────────

export interface Context {
  /** Drizzle ORM client backed by a node-postgres connection pool. */
  db: Database;

  /**
   * RFC 7231–style correlation ID for the request.
   * Propagated to logs and execution traces for end-to-end observability.
   */
  requestId: string;
}

// ─── Context Factory ──────────────────────────────────────────────────────────

/**
 * Called by the tRPC HTTP adapter for every incoming request.
 *
 * @param opts  Adapter-provided options containing the raw Node.js `req`/`res`.
 */
export async function createContext(
  opts: CreateHTTPContextOptions,
): Promise<Context> {
  const incomingId = opts.req.headers["x-request-id"];
  const requestId =
    typeof incomingId === "string" && incomingId.trim().length > 0
      ? incomingId.trim()
      : uuidv4();

  return {
    db,
    requestId,
  };
}
