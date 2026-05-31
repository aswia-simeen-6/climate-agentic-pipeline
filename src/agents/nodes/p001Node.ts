/**
 * src/agents/nodes/p001Node.ts
 *
 * LangGraph node: "p001Processing"
 *
 * Responsibilities:
 *  - Guards against invalid P-001 inputs (skips gracefully if validation failed).
 *  - Invokes computeP001Score from scoring.ts.
 *  - Builds a PrimerScore and appends it to AgentState.accumulatedScores.
 *  - Appends an ExecutionTrace.
 *  - Pure calculation node — no LLM calls, no database access.
 */

import { v4 as uuidv4 } from "uuid";
import { computeP001Score } from "../scoring";
import { P001_SYSTEM_PROMPT } from "../prompts/p001SystemPrompt";
import type {
  AgentState,
  ExecutionTrace,
  PrimerScore,
  P001ComputationDetail,
} from "../../types/index";
import { PRIMER_IDS, METHODOLOGY_VERSION } from "../../types/index";

// ─── Node Function ────────────────────────────────────────────────────────────

export async function p001Node(
  state: AgentState,
): Promise<Partial<AgentState>> {
  const startTimeMs = Date.now();
  const traceId = uuidv4();

  const inputSnapshot: Record<string, unknown> = {
    companyId: state.companyContext.id,
    reportingYear: state.reportingYear,
    p001Valid: state.validationFlags.p001.isValid,
    p001Input: state.rawInputData.p001,
  };

  // ── Guard: skip if P-001 validation failed ────────────────────────────────
  if (!state.validationFlags.p001.isValid || state.rawInputData.p001 === undefined) {
    const endTimeMs = Date.now();

    const trace: ExecutionTrace = {
      id: traceId,
      nodeName: "p001Processing",
      startTimeMs,
      endTimeMs,
      executionDurationMs: endTimeMs - startTimeMs,
      inputSnapshot,
      outputSnapshot: {
        skipped: true,
        reason: "P-001 validation did not pass; node skipped.",
      },
    };

    console.info(
      `[p001Node] Skipped — validation did not pass (${state.validationFlags.p001.errors.join(", ")})`,
    );

    return { executionTraces: [trace] };
  }

  const p001Input = state.rawInputData.p001;

  // ── Execute scoring ───────────────────────────────────────────────────────
  const scoringResult = computeP001Score(p001Input);

  // ── Build PrimerScore record ──────────────────────────────────────────────
  const primerScore: PrimerScore = {
    primerId: PRIMER_IDS.P001,
    primerCode: "P-001",
    scoreValue: scoringResult.scoreValue,
    normalizedValue: scoringResult.normalizedValue,
    confidenceScore: scoringResult.confidenceScore,
    methodologyVersion: METHODOLOGY_VERSION,
    computationDetail: scoringResult.detail satisfies P001ComputationDetail,
  };

  const endTimeMs = Date.now();

  const outputSnapshot: Record<string, unknown> = {
    scoreValue: primerScore.scoreValue,
    normalizedValue: primerScore.normalizedValue,
    confidenceScore: primerScore.confidenceScore,
    intensityRatio: scoringResult.detail.intensityRatio,
    deviationFromBenchmarkPct: scoringResult.detail.deviationFromBenchmarkPct,
    systemPromptUsed: P001_SYSTEM_PROMPT.slice(0, 80),
  };

  const trace: ExecutionTrace = {
    id: traceId,
    nodeName: "p001Processing",
    startTimeMs,
    endTimeMs,
    executionDurationMs: endTimeMs - startTimeMs,
    inputSnapshot,
    outputSnapshot,
  };

  console.info(
    `[p001Node] Complete — score: ${primerScore.scoreValue}, ` +
    `intensity: ${scoringResult.detail.intensityRatio} tCO₂/$M, ` +
    `deviation: ${scoringResult.detail.deviationFromBenchmarkPct >= 0 ? "+" : ""}${scoringResult.detail.deviationFromBenchmarkPct}% vs benchmark — ` +
    `${trace.executionDurationMs}ms`,
  );

  return {
    accumulatedScores: [primerScore],
    executionTraces: [trace],
  };
}
