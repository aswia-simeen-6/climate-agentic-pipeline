/**
 * src/agents/nodes/p002Node.ts
 *
 * LangGraph node: "p002Processing"
 *
 * Responsibilities:
 *  - Guards against invalid P-002 inputs (skips gracefully if validation failed).
 *  - Invokes computeP002Score from scoring.ts.
 *  - Builds a PrimerScore and appends it to AgentState.accumulatedScores.
 *  - Appends an ExecutionTrace.
 *  - Pure calculation node — no LLM calls, no database access.
 */

import { v4 as uuidv4 } from "uuid";
import { computeP002Score } from "../scoring";
import { P002_SYSTEM_PROMPT } from "../prompts/p002SystemPrompt";
import type {
  AgentState,
  ExecutionTrace,
  PrimerScore,
  P002ComputationDetail,
} from "../../types/index";
import { PRIMER_IDS, METHODOLOGY_VERSION, P002_TSX60_AVERAGE_DIVERSITY } from "../../types/index";

// ─── Node Function ────────────────────────────────────────────────────────────

export async function p002Node(
  state: AgentState,
): Promise<Partial<AgentState>> {
  const startTimeMs = Date.now();
  const traceId = uuidv4();

  const inputSnapshot: Record<string, unknown> = {
    companyId: state.companyContext.id,
    reportingYear: state.reportingYear,
    p002Valid: state.validationFlags.p002.isValid,
    p002Input: state.rawInputData.p002,
  };

  // ── Guard: skip if P-002 validation failed ────────────────────────────────
  if (!state.validationFlags.p002.isValid || state.rawInputData.p002 === undefined) {
    const endTimeMs = Date.now();

    const trace: ExecutionTrace = {
      id: traceId,
      nodeName: "p002Processing",
      startTimeMs,
      endTimeMs,
      executionDurationMs: endTimeMs - startTimeMs,
      inputSnapshot,
      outputSnapshot: {
        skipped: true,
        reason: "P-002 validation did not pass; node skipped.",
      },
    };

    console.info(
      `[p002Node] Skipped — validation did not pass (${state.validationFlags.p002.errors.join(", ")})`,
    );

    return { executionTraces: [trace] };
  }

  const p002Input = state.rawInputData.p002;

  // ── Execute scoring ───────────────────────────────────────────────────────
  const scoringResult = computeP002Score(p002Input);
  const { detail } = scoringResult;

  // ── Build PrimerScore record ──────────────────────────────────────────────
  const primerScore: PrimerScore = {
    primerId: PRIMER_IDS.P002,
    primerCode: "P-002",
    scoreValue: scoringResult.scoreValue,
    normalizedValue: scoringResult.normalizedValue,
    confidenceScore: scoringResult.confidenceScore,
    methodologyVersion: METHODOLOGY_VERSION,
    computationDetail: detail satisfies P002ComputationDetail,
  };

  // ── Contextual interpretation for logging ────────────────────────────────
  const tsx60AvgPct = (P002_TSX60_AVERAGE_DIVERSITY * 100).toFixed(1);
  const diversityPct = (detail.diversityRatio * 100).toFixed(1);
  const deviationPp = detail.deviationFromTsx60Pp;
  const benchmarkRelation =
    deviationPp >= 0
      ? `+${deviationPp.toFixed(1)}pp above TSX60 avg (${tsx60AvgPct}%)`
      : `${deviationPp.toFixed(1)}pp below TSX60 avg (${tsx60AvgPct}%)`;

  const endTimeMs = Date.now();

  const outputSnapshot: Record<string, unknown> = {
    scoreValue: primerScore.scoreValue,
    normalizedValue: primerScore.normalizedValue,
    confidenceScore: primerScore.confidenceScore,
    diversityRatio: detail.diversityRatio,
    diversityPct,
    deviationFromTsx60Pp: detail.deviationFromTsx60Pp,
    boardSize: p002Input.boardSize,
    femaleDirectors: p002Input.femaleDirectors,
    systemPromptUsed: P002_SYSTEM_PROMPT.slice(0, 80),
  };

  const trace: ExecutionTrace = {
    id: traceId,
    nodeName: "p002Processing",
    startTimeMs,
    endTimeMs,
    executionDurationMs: endTimeMs - startTimeMs,
    inputSnapshot,
    outputSnapshot,
  };

  console.info(
    `[p002Node] Complete — score: ${primerScore.scoreValue}, ` +
    `diversity: ${diversityPct}% (${benchmarkRelation}) — ` +
    `${trace.executionDurationMs}ms`,
  );

  return {
    accumulatedScores: [primerScore],
    executionTraces: [trace],
  };
}
