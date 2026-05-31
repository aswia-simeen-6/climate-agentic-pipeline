/**
 * src/agents/nodes/validationNode.ts
 *
 * LangGraph node: "validation"
 *
 * Responsibilities:
 *  - Receives the raw input data for all three primers from AgentState.
 *  - Invokes the pure validation functions from scoring.ts.
 *  - Populates AgentState.validationFlags with per-primer results.
 *  - Appends an ExecutionTrace.
 *  - Does NOT mutate scores or perform any database operations.
 *
 * Routing contract:
 *  - If at least one primer passes validation, the graph proceeds to p001Processing.
 *  - If ALL primers fail validation, graph routes to END (controlled by graph.ts).
 */

import { v4 as uuidv4 } from "uuid";
import {
  validateP001Input,
  validateP002Input,
  validateP003Input,
} from "../scoring";
import type {
  AgentState,
  ExecutionTrace,
  PrimerValidationResult,
  ValidationFlags,
} from "../../types/index";

// ─── Default empty validation result ─────────────────────────────────────────

function emptyValidationResult(reason: string): PrimerValidationResult {
  return {
    isValid: false,
    errors: [reason],
    warnings: [],
  };
}

// ─── Node Function ────────────────────────────────────────────────────────────

/**
 * Validates all primer inputs present in `state.rawInputData`.
 * Primers with missing input objects automatically fail with a descriptive error.
 */
export async function validationNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  const startTimeMs = Date.now();
  const traceId = uuidv4();

  const inputSnapshot: Record<string, unknown> = {
    companyId: state.companyContext.id,
    reportingYear: state.reportingYear,
    hasP001Input: state.rawInputData.p001 !== undefined,
    hasP002Input: state.rawInputData.p002 !== undefined,
    hasP003Input: state.rawInputData.p003 !== undefined,
  };

  // ── Validate P-001 ────────────────────────────────────────────────────────
  const p001Result: PrimerValidationResult =
    state.rawInputData.p001 !== undefined
      ? validateP001Input(state.rawInputData.p001)
      : emptyValidationResult("P-001 input data is absent from the pipeline request.");

  // ── Validate P-002 ────────────────────────────────────────────────────────
  const p002Result: PrimerValidationResult =
    state.rawInputData.p002 !== undefined
      ? validateP002Input(state.rawInputData.p002)
      : emptyValidationResult("P-002 input data is absent from the pipeline request.");

  // ── Validate P-003 ────────────────────────────────────────────────────────
  const p003Result: PrimerValidationResult =
    state.rawInputData.p003 !== undefined
      ? validateP003Input(state.rawInputData.p003)
      : emptyValidationResult("P-003 input data is absent from the pipeline request.");

  const validationFlags: ValidationFlags = {
    p001: p001Result,
    p002: p002Result,
    p003: p003Result,
  };

  // ── Collect errors for the top-level errors array ─────────────────────────
  const newErrors: string[] = [];

  if (!p001Result.isValid) {
    newErrors.push(
      `[P-001 Validation Failed] ${p001Result.errors.join("; ")}`,
    );
  }
  if (!p002Result.isValid) {
    newErrors.push(
      `[P-002 Validation Failed] ${p002Result.errors.join("; ")}`,
    );
  }
  if (!p003Result.isValid) {
    newErrors.push(
      `[P-003 Validation Failed] ${p003Result.errors.join("; ")}`,
    );
  }

  // Log warnings to stdout so they are visible without failing the pipeline.
  const allWarnings = [
    ...p001Result.warnings.map((w) => `[P-001 Warning] ${w}`),
    ...p002Result.warnings.map((w) => `[P-002 Warning] ${w}`),
    ...p003Result.warnings.map((w) => `[P-003 Warning] ${w}`),
  ];
  for (const warning of allWarnings) {
    console.warn(`[validationNode] ${warning}`);
  }

  const endTimeMs = Date.now();

  const outputSnapshot: Record<string, unknown> = {
    p001Valid: p001Result.isValid,
    p001Errors: p001Result.errors,
    p002Valid: p002Result.isValid,
    p002Errors: p002Result.errors,
    p003Valid: p003Result.isValid,
    p003Errors: p003Result.errors,
    newErrorCount: newErrors.length,
  };

  const trace: ExecutionTrace = {
    id: traceId,
    nodeName: "validation",
    startTimeMs,
    endTimeMs,
    executionDurationMs: endTimeMs - startTimeMs,
    inputSnapshot,
    outputSnapshot,
  };

  console.info(
    `[validationNode] Complete — P001: ${p001Result.isValid ? "✓" : "✗"}, ` +
    `P002: ${p002Result.isValid ? "✓" : "✗"}, ` +
    `P003: ${p003Result.isValid ? "✓" : "✗"} — ${trace.executionDurationMs}ms`,
  );

  return {
    validationFlags,
    errors: newErrors,
    executionTraces: [trace],
  };
}
