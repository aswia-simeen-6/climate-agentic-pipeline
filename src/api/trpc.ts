/**
 * src/api/trpc.ts
 *
 * Initialises tRPC v11 with a typed context, a custom error formatter that
 * surfaces Zod validation details, and exports the three building blocks used
 * by every router: `router`, `publicProcedure`, and the tRPC instance `t`.
 *
 * All routers import from this file — never from `@trpc/server` directly —
 * so that context typing and error formatting are applied uniformly.
 */

import { initTRPC, TRPCError } from "@trpc/server";
import { ZodError } from "zod";
import type { Context } from "./context";

// ─── tRPC Initialisation ──────────────────────────────────────────────────────

const t = initTRPC.context<Context>().create({
  /**
   * Custom error formatter.
   * Appends a `zodError` field to the response `data` envelope so that API
   * clients can surface field-level validation messages without parsing the
   * generic `message` string.
   */
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError
            ? error.cause.flatten()
            : null,
      },
    };
  },
});

// ─── Exports ──────────────────────────────────────────────────────────────────

/** Factory for composing routers from procedure builders. */
export const router = t.router;

/**
 * Base procedure builder.
 * Extend this with `.use(middleware)` to create authenticated or rate-limited
 * procedure variants (Phase 3+).
 */
export const publicProcedure = t.procedure;

/** Re-export TRPCError for use in router files without an extra import. */
export { TRPCError };
