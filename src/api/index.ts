/**
 * src/api/index.ts
 *
 * Assembles all sub-routers into the root AppRouter and exports the inferred
 * TypeScript type used by the tRPC client for end-to-end type safety.
 */

import { router } from "./trpc";
import { primerRouter } from "./routers/primer";

// ─── Root Application Router ──────────────────────────────────────────────────

export const appRouter = router({
  /** All primer evaluation, scoring, and trace procedures. */
  primer: primerRouter,
});

// ─── Exported Types ───────────────────────────────────────────────────────────

/**
 * The inferred type of the full router tree.
 * Import this on the client side to initialise a type-safe tRPC client:
 *
 * ```typescript
 * import type { AppRouter } from './api/index';
 * import { createTRPCClient } from '@trpc/client';
 * const client = createTRPCClient<AppRouter>({ ... });
 * ```
 */
export type AppRouter = typeof appRouter;
