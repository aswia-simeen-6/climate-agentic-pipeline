/**
 * src/agents/nodes/persistenceNode.ts
 *
 * LangGraph node: "persistence"
 *
 * Responsibilities:
 *  1. Reads all ExecutionTraces from AgentState and inserts them into `agent_traces`.
 *  2. Reads all PrimerScores from AgentState and for each:
 *     a. Inserts a row into `primer_data` (with FK to the relevant agent_trace).
 *     b. Upserts a row into `scores` (insert or update if a row already exists
 *        for the same company_id / primer_id / reporting_year combination).
 *  3. Sets processingComplete = true on success.
 *  4. Appends its own ExecutionTrace.
 *
 * Transaction strategy:
 *  - All writes for a single pipeline run are wrapped in a Drizzle transaction
 *    so that a partial failure does not leave orphaned records.
 *
 * Idempotency:
 *  - agent_traces is insert-only (no upsert) since each trace ID is a fresh UUID.
 *  - primer_data is insert-only for the same reason.
 *  - scores uses ON CONFLICT DO UPDATE to allow re-runs to overwrite stale scores.
 */

import { v4 as uuidv4 } from "uuid";
import { sql } from "drizzle-orm";
import { db } from "../../db/index";
import { agentTraces, primerData, scores } from "../../db/schema";
import type {
  AgentState,
  ExecutionTrace,
  PrimerScore,
} from "../../types/index";
import type {
  NewAgentTrace,
  NewPrimerData,
  NewScore,
} from "../../db/schema";

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Maps an ExecutionTrace domain object to the Drizzle insert shape.
 */
function traceToInsertRow(trace: ExecutionTrace): NewAgentTrace {
  return {
    id: trace.id,
    agentName: trace.nodeName,
    inputSnapshot: trace.inputSnapshot,
    outputSnapshot: trace.outputSnapshot,
    executionDurationMs: trace.executionDurationMs,
    llmModelUsed: trace.llmModelUsed ?? null,
  };
}

/**
 * Finds the trace ID for the node that produced a given primer score.
 * Matches by nodeName prefix ("p001Processing" → "P-001", etc.).
 */
function findTraceIdForPrimer(
  primerCode: string,
  traces: ExecutionTrace[],
): string | null {
  const nodeNameMap: Record<string, string> = {
    "P-001": "p001Processing",
    "P-002": "p002Processing",
    "P-003": "p003Processing",
  };

  const targetNodeName = nodeNameMap[primerCode];
  if (!targetNodeName) {
    return null;
  }

  const matchingTrace = traces.find((t) => t.nodeName === targetNodeName);
  return matchingTrace?.id ?? null;
}

/**
 * Maps a PrimerScore domain object to the Drizzle `primer_data` insert shape.
 */
function primerScoreToDataInsertRow(
  score: PrimerScore,
  companyId: string,
  reportingYear: number,
  agentTraceId: string | null,
): NewPrimerData {
  return {
    id: uuidv4(),
    companyId,
    primerId: score.primerId,
    reportingYear,
    rawValue: score.computationDetail as unknown as Record<string, unknown>,
    normalizedValue: String(score.normalizedValue),
    confidenceScore: String(score.confidenceScore),
    agentTraceId,
  };
}

/**
 * Maps a PrimerScore domain object to the Drizzle `scores` insert/upsert shape.
 */
function primerScoreToScoreInsertRow(
  score: PrimerScore,
  companyId: string,
  reportingYear: number,
): NewScore {
  return {
    id: uuidv4(),
    companyId,
    primerId: score.primerId,
    reportingYear,
    scoreValue: String(score.scoreValue),
    percentileRank: null, // Populated post-aggregation in a separate job.
    methodologyVersion: score.methodologyVersion,
  };
}

// ─── Node Function ────────────────────────────────────────────────────────────

export async function persistenceNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  const startTimeMs = Date.now();
  const persistenceTraceId = uuidv4();

  const inputSnapshot: Record<string, unknown> = {
    companyId: state.companyContext.id,
    reportingYear: state.reportingYear,
    accumulatedScoreCount: state.accumulatedScores.length,
    executionTraceCount: state.executionTraces.length,
    primerCodes: state.accumulatedScores.map((s) => s.primerCode),
  };

  // Guard: nothing to persist.
  if (state.accumulatedScores.length === 0) {
    const endTimeMs = Date.now();
    const trace: ExecutionTrace = {
      id: persistenceTraceId,
      nodeName: "persistence",
      startTimeMs,
      endTimeMs,
      executionDurationMs: endTimeMs - startTimeMs,
      inputSnapshot,
      outputSnapshot: {
        persisted: false,
        reason: "No accumulated scores to persist.",
      },
    };

    console.warn("[persistenceNode] No scores to persist; node completed without writes.");

    return {
      processingComplete: false,
      executionTraces: [trace],
      errors: ["[Persistence] No accumulated scores available to persist."],
    };
  }

  const persistenceErrors: string[] = [];
  let rowsInserted = 0;

  try {
    await db.transaction(async (tx) => {
      // ── 1. Insert all execution traces ──────────────────────────────────
      // Excludes the persistence trace itself (not yet complete).
      const traceRows = state.executionTraces.map(traceToInsertRow);
      if (traceRows.length > 0) {
        await tx.insert(agentTraces).values(traceRows);
        rowsInserted += traceRows.length;
        console.info(`[persistenceNode] Inserted ${String(traceRows.length)} agent_trace rows.`);
      }

      // ── 2. Insert primer_data and upsert scores ──────────────────────────
      for (const score of state.accumulatedScores) {
        const linkedTraceId = findTraceIdForPrimer(
          score.primerCode,
          state.executionTraces,
        );

        // Insert primer_data row
        const dataRow = primerScoreToDataInsertRow(
          score,
          state.companyContext.id,
          state.reportingYear,
          linkedTraceId,
        );

        await tx.insert(primerData).values(dataRow);
        rowsInserted += 1;

        // Upsert score row — if a score already exists for this
        // (company, primer, year) triple, overwrite it.
        const scoreRow = primerScoreToScoreInsertRow(
          score,
          state.companyContext.id,
          state.reportingYear,
        );

        await tx
          .insert(scores)
          .values(scoreRow)
          .onConflictDoUpdate({
            target: [scores.companyId, scores.primerId, scores.reportingYear],
            set: {
              id: scoreRow.id,
              scoreValue: scoreRow.scoreValue,
              methodologyVersion: scoreRow.methodologyVersion,
              computedAt: sql`NOW()`,
            },
          });

        rowsInserted += 1;
        console.info(
          `[persistenceNode] Persisted ${score.primerCode} — score: ${String(score.scoreValue)}.`,
        );
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const errorMsg = `[Persistence] Transaction failed: ${message}`;
    console.error(`[persistenceNode] ${errorMsg}`);
    persistenceErrors.push(errorMsg);

    const endTimeMs = Date.now();
    const trace: ExecutionTrace = {
      id: persistenceTraceId,
      nodeName: "persistence",
      startTimeMs,
      endTimeMs,
      executionDurationMs: endTimeMs - startTimeMs,
      inputSnapshot,
      outputSnapshot: {
        persisted: false,
        error: message,
        rowsInserted: 0,
      },
    };

    return {
      processingComplete: false,
      executionTraces: [trace],
      errors: persistenceErrors,
    };
  }

  const endTimeMs = Date.now();

  const outputSnapshot: Record<string, unknown> = {
    persisted: true,
    rowsInserted,
    primerCodes: state.accumulatedScores.map((s) => s.primerCode),
    scores: state.accumulatedScores.map((s) => ({
      primerCode: s.primerCode,
      scoreValue: s.scoreValue,
    })),
  };

  // ── Persist THIS node's own trace after the transaction ──────────────────
  // We do this outside the transaction intentionally — if the trace insert
  // fails we still mark processing complete (score writes succeeded).
  try {
    await db.insert(agentTraces).values({
      id: persistenceTraceId,
      agentName: "persistence",
      inputSnapshot: inputSnapshot,
      outputSnapshot: outputSnapshot,
      executionDurationMs: endTimeMs - startTimeMs,
      llmModelUsed: null,
    });
  } catch (traceErr: unknown) {
    const traceMessage =
      traceErr instanceof Error ? traceErr.message : String(traceErr);
    console.warn(
      `[persistenceNode] Failed to insert persistence node's own trace: ${traceMessage}`,
    );
  }

  const trace: ExecutionTrace = {
    id: persistenceTraceId,
    nodeName: "persistence",
    startTimeMs,
    endTimeMs,
    executionDurationMs: endTimeMs - startTimeMs,
    inputSnapshot,
    outputSnapshot,
  };

  console.info(
    `[persistenceNode] Complete — ${String(rowsInserted)} rows inserted in ${String(trace.executionDurationMs)}ms.`,
  );

  return {
    processingComplete: true,
    executionTraces: [trace],
    errors: persistenceErrors,
  };
}
