/**
 * src/api/routers/primer.ts
 *
 * tRPC v11 router exposing all ESG primer evaluation procedures.
 *
 * Procedures:
 *   submitData    (mutation) — Validates payload, executes LangGraph pipeline,
 *                              returns a score summary and execution trace IDs.
 *   getScore      (query)   — Fetches a single primer score with its agent trace.
 *   listScores    (query)   — Fetches all scores for a company/year with
 *                              E/S/G pillar aggregates.
 *   getAgentTrace (query)   — Returns full execution log from agent_traces.
 *
 * Error handling:
 *   - NOT_FOUND         : No matching row in the database.
 *   - BAD_REQUEST       : Input that passes Zod but fails business logic.
 *   - INTERNAL_SERVER_ERROR : Unexpected pipeline or DB failures.
 *
 * All numeric columns stored as Postgres `numeric` strings are parsed to
 * JavaScript `number` before being returned to callers.
 */

import { TRPCError } from "@trpc/server";
import { eq, and, desc } from "drizzle-orm";
import { router, publicProcedure } from "../trpc";
import {
  agentTraces,
  companies,
  primers,
  primerData,
  scores,
} from "../../db/schema";
import { runEsgPipeline } from "../../agents/graph";
import {
  SubmitDataInputSchema,
  SubmitDataOutputSchema,
  GetScoreInputSchema,
  GetScoreOutputSchema,
  ListScoresInputSchema,
  ListScoresOutputSchema,
  GetAgentTraceInputSchema,
  GetAgentTraceOutputSchema,
} from "../schemas/index";

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Safely parses a nullable Postgres `numeric` string to a JS `number`.
 * Returns `null` if the input is null or undefined.
 */
function parseNumeric(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Computes the arithmetic mean of an array of numbers.
 * Returns `null` when the array is empty.
 */
function average(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return parseFloat((sum / values.length).toFixed(2));
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const primerRouter = router({
  // ══════════════════════════════════════════════════════════════════════════
  // POST /trpc/primer.submitData
  // ══════════════════════════════════════════════════════════════════════════
  /**
   * Validates the incoming primer data payload, executes the full LangGraph
   * ESG scoring pipeline, and returns a summary of computed scores plus the
   * IDs of every execution trace node created during the run.
   *
   * The pipeline is executed synchronously within the HTTP request for this
   * prototype.  In production, enqueue a BullMQ job and return a jobId
   * (see docs/infrastructure.md for the async queue architecture).
   */
  submitData: publicProcedure
    .input(SubmitDataInputSchema)
    .output(SubmitDataOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const startMs = Date.now();

      // ── Verify the company exists before kicking off the pipeline ─────────
      const companyRows = await ctx.db
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(eq(companies.id, input.companyId))
        .limit(1);

      if (!companyRows[0]) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Company with id "${input.companyId}" does not exist.`,
        });
      }

      // ── Execute pipeline ──────────────────────────────────────────────────
      let result: Awaited<ReturnType<typeof runEsgPipeline>>;

      try {
        result = await runEsgPipeline({
          companyId: input.companyId,
          reportingYear: input.reportingYear,
          rawInputData: input.rawInputData as import("../../types/index").RawInputData,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[primer.submitData] Pipeline error: ${message}`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `ESG pipeline execution failed: ${message}`,
          cause: err instanceof Error ? err : new Error(message),
        });
      }

      // ── Warn if pipeline completed with errors but did not throw ──────────
      if (!result.processingComplete && result.errors.length > 0) {
        console.warn(
          `[primer.submitData] Pipeline completed with ${String(result.errors.length)} error(s): ` +
          result.errors.join("; "),
        );
      }

      return {
        requestId: ctx.requestId,
        companyId: result.companyId,
        reportingYear: result.reportingYear,
        processingComplete: result.processingComplete,
        scores: result.scores.map((s) => ({
          primerCode: s.primerCode,
          scoreValue: s.scoreValue,
          confidenceScore: s.confidenceScore,
          methodologyVersion: s.methodologyVersion,
        })),
        errors: result.errors,
        executionSummary: result.executionTraces.map((t) => ({
          nodeName: t.nodeName,
          traceId: t.id,
          durationMs: t.executionDurationMs,
          llmModelUsed: t.llmModelUsed ?? null,
        })),
        totalDurationMs: Date.now() - startMs,
      };
    }),

  // ══════════════════════════════════════════════════════════════════════════
  // GET /trpc/primer.getScore
  // ══════════════════════════════════════════════════════════════════════════
  /**
   * Fetches the computed score for a specific primer/company/year triple,
   * along with the primer metadata and a summary of the producing agent trace.
   */
  getScore: publicProcedure
    .input(GetScoreInputSchema)
    .output(GetScoreOutputSchema)
    .query(async ({ ctx, input }) => {
      // ── 1. Resolve primer ─────────────────────────────────────────────────
      const primerRows = await ctx.db
        .select()
        .from(primers)
        .where(eq(primers.code, input.primerCode))
        .limit(1);

      const primer = primerRows[0];
      if (!primer) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Primer with code "${input.primerCode}" does not exist in the system.`,
        });
      }

      // ── 2. Resolve score ──────────────────────────────────────────────────
      const scoreRows = await ctx.db
        .select()
        .from(scores)
        .where(
          and(
            eq(scores.companyId, input.companyId),
            eq(scores.primerId, primer.id),
            eq(scores.reportingYear, input.reportingYear),
          ),
        )
        .limit(1);

      const score = scoreRows[0];
      if (!score) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            `No score found for company "${input.companyId}", ` +
            `primer "${input.primerCode}", year ${String(input.reportingYear)}. ` +
            `Run submitData first to compute scores.`,
        });
      }

      // ── 3. Resolve most recent primer_data row for trace linkage ──────────
      const dataRows = await ctx.db
        .select()
        .from(primerData)
        .where(
          and(
            eq(primerData.companyId, input.companyId),
            eq(primerData.primerId, primer.id),
            eq(primerData.reportingYear, input.reportingYear),
          ),
        )
        .orderBy(desc(primerData.createdAt))
        .limit(1);

      const latestData = dataRows[0];

      // ── 4. Resolve agent trace if linked ──────────────────────────────────
      let agentTraceSummary: {
        id: string;
        agentName: string;
        executionDurationMs: number;
        llmModelUsed: string | null;
        createdAt: Date;
      } | null = null;

      if (latestData?.agentTraceId) {
        const traceRows = await ctx.db
          .select()
          .from(agentTraces)
          .where(eq(agentTraces.id, latestData.agentTraceId))
          .limit(1);

        const traceRow = traceRows[0];
        if (traceRow) {
          agentTraceSummary = {
            id: traceRow.id,
            agentName: traceRow.agentName,
            executionDurationMs: traceRow.executionDurationMs,
            llmModelUsed: traceRow.llmModelUsed,
            createdAt: traceRow.createdAt,
          };
        }
      }

      return {
        score: {
          id: score.id,
          companyId: score.companyId,
          primerCode: primer.code,
          primerName: primer.name,
          category: primer.category,
          dataType: primer.dataType,
          reportingYear: score.reportingYear,
          scoreValue: parseFloat(score.scoreValue),
          percentileRank: parseNumeric(score.percentileRank),
          methodologyVersion: score.methodologyVersion,
          computedAt: score.computedAt,
          normalizedValue: parseNumeric(latestData?.normalizedValue),
          confidenceScore: parseNumeric(latestData?.confidenceScore),
        },
        agentTrace: agentTraceSummary,
      };
    }),

  // ══════════════════════════════════════════════════════════════════════════
  // GET /trpc/primer.listScores
  // ══════════════════════════════════════════════════════════════════════════
  /**
   * Returns all computed scores for a company/year combination.
   * Calculates E, S, G pillar averages and a composite average across all
   * primers.  Scores are ordered by primer code (P-001, P-002, P-003).
   */
  listScores: publicProcedure
    .input(ListScoresInputSchema)
    .output(ListScoresOutputSchema)
    .query(async ({ ctx, input }) => {
      // ── Verify company exists ─────────────────────────────────────────────
      const companyRows = await ctx.db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, input.companyId))
        .limit(1);

      if (!companyRows[0]) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Company with id "${input.companyId}" does not exist.`,
        });
      }

      // ── Fetch all scores with primer metadata ─────────────────────────────
      const scoreRows = await ctx.db
        .select({
          score: scores,
          primer: primers,
        })
        .from(scores)
        .innerJoin(primers, eq(scores.primerId, primers.id))
        .where(
          and(
            eq(scores.companyId, input.companyId),
            eq(scores.reportingYear, input.reportingYear),
          ),
        )
        .orderBy(primers.code);

      // ── Build response + accumulate pillar groups ─────────────────────────
      const pillarGroups: Record<"E" | "S" | "G", number[]> = {
        E: [],
        S: [],
        G: [],
      };

      const scoreList = scoreRows.map((row) => {
        const scoreValue = parseFloat(row.score.scoreValue);
        const category = row.primer.category as "E" | "S" | "G";
        pillarGroups[category].push(scoreValue);

        return {
          id: row.score.id,
          primerCode: row.primer.code,
          primerName: row.primer.name,
          category,
          dataType: row.primer.dataType,
          scoreValue,
          percentileRank: parseNumeric(row.score.percentileRank),
          methodologyVersion: row.score.methodologyVersion,
          computedAt: row.score.computedAt,
        };
      });

      const allScoreValues = [
        ...pillarGroups.E,
        ...pillarGroups.S,
        ...pillarGroups.G,
      ];

      return {
        companyId: input.companyId,
        reportingYear: input.reportingYear,
        scoreCount: scoreList.length,
        scores: scoreList,
        pillars: {
          environmental: {
            averageScore: average(pillarGroups.E),
            primerCount: pillarGroups.E.length,
          },
          social: {
            averageScore: average(pillarGroups.S),
            primerCount: pillarGroups.S.length,
          },
          governance: {
            averageScore: average(pillarGroups.G),
            primerCount: pillarGroups.G.length,
          },
          composite: {
            averageScore: average(allScoreValues),
          },
        },
      };
    }),

  // ══════════════════════════════════════════════════════════════════════════
  // GET /trpc/primer.getAgentTrace
  // ══════════════════════════════════════════════════════════════════════════
  /**
   * Retrieves the complete execution log for a single LangGraph node run.
   * The full `inputSnapshot` and `outputSnapshot` JSONB objects are returned
   * so that analysts can audit exactly what data entered and exited each node.
   */
  getAgentTrace: publicProcedure
    .input(GetAgentTraceInputSchema)
    .output(GetAgentTraceOutputSchema)
    .query(async ({ ctx, input }) => {
      const traceRows = await ctx.db
        .select()
        .from(agentTraces)
        .where(eq(agentTraces.id, input.traceId))
        .limit(1);

      const trace = traceRows[0];
      if (!trace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Agent trace with ID "${input.traceId}" not found.`,
        });
      }

      return {
        id: trace.id,
        agentName: trace.agentName,
        inputSnapshot: trace.inputSnapshot as Record<string, unknown>,
        outputSnapshot: trace.outputSnapshot as Record<string, unknown>,
        executionDurationMs: trace.executionDurationMs,
        llmModelUsed: trace.llmModelUsed,
        createdAt: trace.createdAt,
      };
    }),
});
