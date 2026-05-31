/**
 * src/server.ts
 *
 * HTTP server entrypoint for the Aurora Energy ESG Agentic Pipeline API.
 *
 * Uses tRPC's standalone adapter to mount the AppRouter at `/trpc`.
 * The server also exposes two utility routes handled by the raw Node.js
 * request listener before handing off to tRPC:
 *   GET /health  — liveness probe for container orchestrators / load balancers.
 *   GET /ready   — readiness probe (verifies DB connectivity before marking ready).
 *
 * Environment variables (see .env.example):
 *   PORT          — TCP port to bind (default: 3000)
 *   HOST          — Bind address (default: 0.0.0.0)
 *   NODE_ENV      — Environment tag (development | production | test)
 *   DATABASE_URL  — Postgres connection string (required)
 */

import * as dotenv from "dotenv";
dotenv.config();

import * as http from "http";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { appRouter } from "./api/index";
import { createContext } from "./api/context";
import { pool } from "./db/index";

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const HOST = process.env["HOST"] ?? "0.0.0.0";
const NODE_ENV = process.env["NODE_ENV"] ?? "development";

// ─── tRPC Handler ─────────────────────────────────────────────────────────────

const trpcHandler = createHTTPHandler({
  router: appRouter,
  createContext,
  /**
   * Attach CORS headers for all tRPC responses.
   * In production, restrict `Access-Control-Allow-Origin` to known origins.
   */
  responseMeta() {
    return {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-ID",
        "X-Powered-By": "AA Impact ESG Pipeline v1.0",
      },
    };
  },
});

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer(
  (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = req.url ?? "/";

    // ── Pre-flight for CORS ───────────────────────────────────────────────
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-ID",
      });
      res.end();
      return;
    }

    // ── Liveness probe ────────────────────────────────────────────────────
    if (url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "climate-agentic-pipeline",
          environment: NODE_ENV,
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    // ── Readiness probe ───────────────────────────────────────────────────
    if (url === "/ready" && req.method === "GET") {
      pool
        .query("SELECT 1")
        .then(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ready", database: "connected" }));
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[server] Readiness check failed: ${message}`);
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ status: "not_ready", database: "unreachable", error: message }),
          );
        });
      return;
    }

    // ── tRPC: handle all /trpc/* requests ─────────────────────────────────
    if (url.startsWith("/trpc")) {
      trpcHandler(req, res);
      return;
    }

    // ── 404 for all other routes ──────────────────────────────────────────
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Not Found",
        message: `No handler for ${req.method ?? "?"} ${url}`,
        trpcBase: "/trpc",
        healthCheck: "/health",
        readinessCheck: "/ready",
      }),
    );
  },
);

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.info(`[server] Received ${signal}. Starting graceful shutdown…`);

  server.close(() => {
    console.info("[server] HTTP server closed.");
  });

  try {
    await pool.end();
    console.info("[server] Database pool drained.");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[server] Error draining DB pool: ${message}`);
  }

  process.exit(0);
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT",  () => { void shutdown("SIGINT"); });

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, HOST, () => {
  console.info(
    `[server] Aurora Energy ESG Pipeline API — ${NODE_ENV}\n` +
    `[server] tRPC endpoint  : http://${HOST}:${String(PORT)}/trpc\n` +
    `[server] Health check   : http://${HOST}:${String(PORT)}/health\n` +
    `[server] Readiness probe: http://${HOST}:${String(PORT)}/ready`,
  );
});

export { server };
