/**
 * src/agents/scoring.ts
 *
 * Pure, side-effect-free scoring and validation functions for all three
 * ESG material primers.  No database access, no LLM calls — those belong
 * in the agent nodes.  Every function is unit-testable in isolation.
 *
 * Primer scoring methodologies:
 *
 *  P-001  Scope 1 CO₂ Emissions (Quantitative — Environmental)
 *    Intensity-adjusted percentile score relative to peer average 52.3 tCO₂/$M.
 *    score = clamp(100 × (1 − intensity / (2 × benchmark)), 0, 100)
 *    At intensity = 0        → score = 100
 *    At intensity = benchmark → score = 50
 *    At intensity = 2×bench  → score = 0
 *
 *  P-002  Board Gender Diversity (Quantitative — Governance)
 *    Linear scaling from 0 % → 50 % diversity against TSX60 average (28.2 %).
 *    score = clamp((diversityRatio / 0.50) × 100, 0, 100)
 *    At diversity = 0 %  → score = 0
 *    At diversity = 28.2 % → score ≈ 56.4
 *    At diversity ≥ 50 % → score = 100
 *
 *  P-003  Supply Chain Labor Risk (Hybrid — Social)
 *    Weighted base score from quantitative metrics, then ± qualitative
 *    LLM adjustment applied in the p003Node after the LLM call.
 *    baseScore = (audited×0.30 + coc×0.25 + policies×0.20 + grievance×0.15
 *                 − penalty×0.10) × 100
 *    finalScore = clamp(baseScore + llmAdjustment, 0, 100)
 */

import type {
  P001RawInput,
  P002RawInput,
  P003RawInput,
  P001ComputationDetail,
  P002ComputationDetail,
  P003ComputationDetail,
  PrimerValidationResult,
} from "../types/index";

import {
  P001_PEER_BENCHMARK_INTENSITY,
  P002_TSX60_AVERAGE_DIVERSITY,
  P003_LLM_ADJ_MIN,
  P003_LLM_ADJ_MAX,
  P003_INCIDENT_SATURATION,
} from "../types/index";

// ─── Internal Utility ─────────────────────────────────────────────────────────

/**
 * Clamps a value to [min, max], inclusive.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Rounds a number to the given decimal places for display purposes.
 * Does NOT round intermediate values used in final calculations.
 */
function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

// ═════════════════════════════════════════════════════════════════════════════
// P-001  Scope 1 CO₂ Emissions
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Validates raw P-001 inputs.
 * Rules:
 *  - scope1Emissions must be a finite positive number
 *  - revenueMillions must be a finite positive number
 *  - Realistic ceiling for emissions: 50,000,000 tCO₂e (largest global emitters)
 *  - Realistic ceiling for revenue in $M CAD: 500,000 (largest TSX company ~$500B)
 */
export function validateP001Input(input: P001RawInput): PrimerValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!Number.isFinite(input.scope1Emissions) || input.scope1Emissions <= 0) {
    errors.push(
      `scope1Emissions must be a finite positive number; received: ${String(input.scope1Emissions)}`,
    );
  } else if (input.scope1Emissions > 50_000_000) {
    warnings.push(
      `scope1Emissions value ${input.scope1Emissions} exceeds realistic ceiling of 50,000,000 tCO₂e. ` +
      "Verify units are metric tonnes, not kilograms.",
    );
  }

  if (!Number.isFinite(input.revenueMillions) || input.revenueMillions <= 0) {
    errors.push(
      `revenueMillions must be a finite positive number; received: ${String(input.revenueMillions)}`,
    );
  } else if (input.revenueMillions > 500_000) {
    warnings.push(
      `revenueMillions value ${input.revenueMillions} exceeds realistic ceiling of 500,000 $M CAD.`,
    );
  }

  if (errors.length === 0 && input.scope1Emissions > 0 && input.revenueMillions > 0) {
    const intensity = input.scope1Emissions / input.revenueMillions;
    if (intensity > P001_PEER_BENCHMARK_INTENSITY * 20) {
      warnings.push(
        `Computed CO₂ intensity of ${round(intensity, 2)} tCO₂/$M is >20× the peer benchmark ` +
        `(${P001_PEER_BENCHMARK_INTENSITY} tCO₂/$M). Verify inputs are correct.`,
      );
    }
  }

  return { isValid: errors.length === 0, errors, warnings };
}

/**
 * Computes the P-001 score and all intermediate values.
 *
 * @param input  Validated P-001 raw inputs.
 * @returns      Score in [0, 100] and a full computation audit trail.
 */
export function computeP001Score(input: P001RawInput): {
  scoreValue: number;
  normalizedValue: number;
  confidenceScore: number;
  detail: P001ComputationDetail;
} {
  const benchmark = P001_PEER_BENCHMARK_INTENSITY;

  // ── Step 1: CO₂ intensity ratio ──────────────────────────────────────────
  const intensityRatio = input.scope1Emissions / input.revenueMillions;

  // ── Step 2: Deviation from benchmark ────────────────────────────────────
  // Positive deviation means worse (higher emissions per revenue dollar).
  const deviationFromBenchmarkPct =
    ((intensityRatio - benchmark) / benchmark) * 100;

  // ── Step 3: Raw score via linear interpolation ───────────────────────────
  // score = 100 × (1 − intensity / (2 × benchmark))
  // At intensity = 0           → 100
  // At intensity = benchmark   → 50
  // At intensity = 2×benchmark → 0
  const rawScore = 100 * (1 - intensityRatio / (2 * benchmark));
  const scoreValue = round(clamp(rawScore, 0, 100), 2);

  // ── Step 4: Normalized value ─────────────────────────────────────────────
  // Expose the intensity ratio as a normalised [0, 1] value where
  // 1 = zero emissions (best) and 0 = 2×benchmark or worse.
  const normalizedValue = clamp(1 - intensityRatio / (2 * benchmark), 0, 1);

  // ── Step 5: Confidence score ─────────────────────────────────────────────
  // Full confidence (1.0) for typical mid-range values.
  // Reduce confidence slightly when inputs are near boundary conditions.
  let confidenceScore = 1.0;
  if (intensityRatio > P001_PEER_BENCHMARK_INTENSITY * 10) {
    // Very extreme value — possible unit error, lower confidence.
    confidenceScore = 0.6;
  } else if (intensityRatio > P001_PEER_BENCHMARK_INTENSITY * 5) {
    confidenceScore = 0.8;
  }

  const detail: P001ComputationDetail = {
    primerCode: "P-001",
    intensityRatio: round(intensityRatio, 4),
    peerBenchmarkIntensity: benchmark,
    deviationFromBenchmarkPct: round(deviationFromBenchmarkPct, 2),
    rawScore: round(rawScore, 4),
  };

  return { scoreValue, normalizedValue: round(normalizedValue, 8), confidenceScore, detail };
}

// ═════════════════════════════════════════════════════════════════════════════
// P-002  Board Gender Diversity
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Validates raw P-002 inputs.
 * Rules:
 *  - boardSize must be an integer in [3, 25]
 *  - femaleDirectors must be a non-negative integer ≤ boardSize
 */
export function validateP002Input(input: P002RawInput): PrimerValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!Number.isInteger(input.boardSize) || input.boardSize < 3 || input.boardSize > 25) {
    errors.push(
      `boardSize must be an integer in [3, 25]; received: ${String(input.boardSize)}`,
    );
  }

  if (!Number.isInteger(input.femaleDirectors) || input.femaleDirectors < 0) {
    errors.push(
      `femaleDirectors must be a non-negative integer; received: ${String(input.femaleDirectors)}`,
    );
  }

  // Cross-field check — only run if both fields are individually valid.
  if (
    errors.length === 0 &&
    input.femaleDirectors > input.boardSize
  ) {
    errors.push(
      `femaleDirectors (${input.femaleDirectors}) cannot exceed boardSize (${input.boardSize}).`,
    );
  }

  // Warning if board is unusually small.
  if (errors.length === 0 && input.boardSize < 5) {
    warnings.push(
      `boardSize of ${input.boardSize} is below the typical minimum for a TSX-listed issuer (5). ` +
      "Verify the figure.",
    );
  }

  // Warning if all-female board (uncommon, possibly data entry error).
  if (errors.length === 0 && input.femaleDirectors === input.boardSize && input.boardSize > 1) {
    warnings.push(
      "All board seats are reported as female-identifying. Verify completeness of data.",
    );
  }

  return { isValid: errors.length === 0, errors, warnings };
}

/**
 * Computes the P-002 score and all intermediate values.
 *
 * @param input  Validated P-002 raw inputs.
 * @returns      Score in [0, 100] and a full computation audit trail.
 */
export function computeP002Score(input: P002RawInput): {
  scoreValue: number;
  normalizedValue: number;
  confidenceScore: number;
  detail: P002ComputationDetail;
} {
  const tsx60Avg = P002_TSX60_AVERAGE_DIVERSITY;

  // ── Step 1: Diversity ratio ──────────────────────────────────────────────
  const diversityRatio = input.femaleDirectors / input.boardSize;

  // ── Step 2: Deviation from TSX60 average in percentage points ───────────
  const deviationFromTsx60Pp = (diversityRatio - tsx60Avg) * 100;

  // ── Step 3: Linear score with 50 % → perfect score ceiling ──────────────
  // score = clamp((diversityRatio / 0.50) × 100, 0, 100)
  // Rationale: Gender parity (50 %) is treated as the achievable ideal.
  const rawScore = (diversityRatio / 0.5) * 100;
  const scoreValue = round(clamp(rawScore, 0, 100), 2);

  // ── Step 4: Normalized value ─────────────────────────────────────────────
  const normalizedValue = clamp(diversityRatio / 0.5, 0, 1);

  // ── Step 5: Confidence score ─────────────────────────────────────────────
  // Full confidence for all boards of reasonable size.
  // Slight reduction for very small boards where one seat change is material.
  const confidenceScore = input.boardSize < 5 ? 0.85 : 1.0;

  const detail: P002ComputationDetail = {
    primerCode: "P-002",
    diversityRatio: round(diversityRatio, 6),
    tsx60AverageDiversity: tsx60Avg,
    deviationFromTsx60Pp: round(deviationFromTsx60Pp, 2),
    rawScore: round(rawScore, 4),
  };

  return { scoreValue, normalizedValue: round(normalizedValue, 8), confidenceScore, detail };
}

// ═════════════════════════════════════════════════════════════════════════════
// P-003  Supply Chain Labor Risk
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Validates raw P-003 inputs.
 * Rules:
 *  - All ratio fields must be in [0, 1]
 *  - incidentCount must be a non-negative integer
 *  - supplyChainNarrative is optional
 */
export function validateP003Input(input: P003RawInput): PrimerValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const ratioFields: Array<keyof Pick<P003RawInput,
    "auditedSuppliersRatio" | "codeOfConductCoverage" | "documentedPoliciesScore" | "grievanceMechanismScore"
  >> = [
    "auditedSuppliersRatio",
    "codeOfConductCoverage",
    "documentedPoliciesScore",
    "grievanceMechanismScore",
  ];

  for (const field of ratioFields) {
    const value = input[field];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      errors.push(
        `${field} must be a finite number in [0, 1]; received: ${String(value)}`,
      );
    }
  }

  if (!Number.isInteger(input.incidentCount) || input.incidentCount < 0) {
    errors.push(
      `incidentCount must be a non-negative integer; received: ${String(input.incidentCount)}`,
    );
  }

  if (
    input.supplyChainNarrative !== undefined &&
    typeof input.supplyChainNarrative === "string" &&
    input.supplyChainNarrative.trim().length === 0
  ) {
    warnings.push(
      "supplyChainNarrative is present but empty. LLM qualitative adjustment will use only quantitative data.",
    );
  }

  if (errors.length === 0 && !input.supplyChainNarrative) {
    warnings.push(
      "supplyChainNarrative is absent. LLM qualitative adjustment confidence will be reduced.",
    );
  }

  return { isValid: errors.length === 0, errors, warnings };
}

/**
 * Computes the P-003 weighted base score from quantitative metrics only.
 * The LLM qualitative adjustment is applied separately in the p003Node after
 * the structured LLM tool call.
 *
 * Weight allocation:
 *   audited_suppliers_ratio    → 30 %
 *   code_of_conduct_coverage   → 25 %
 *   documented_policies_score  → 20 %
 *   grievance_mechanism_score  → 15 %
 *   incident_penalty           → −10 %
 *
 * @param input  Validated P-003 raw inputs.
 * @returns      Weighted base score in [0, 100] and component breakdown.
 */
export function computeP003BaseScore(input: P003RawInput): {
  weightedBaseScore: number;
  componentScores: P003ComputationDetail["componentScores"];
} {
  // ── Step 1: Incident penalty normalization ───────────────────────────────
  // Penalty saturates linearly to 1.0 at P003_INCIDENT_SATURATION incidents.
  const incidentPenaltyFactor = clamp(
    input.incidentCount / P003_INCIDENT_SATURATION,
    0,
    1,
  );

  // ── Step 2: Weighted component contributions (before ×100) ───────────────
  const auditedSuppliersContribution = input.auditedSuppliersRatio * 0.30;
  const codeOfConductContribution = input.codeOfConductCoverage * 0.25;
  const documentedPoliciesContribution = input.documentedPoliciesScore * 0.20;
  const grievanceMechanismContribution = input.grievanceMechanismScore * 0.15;
  const incidentPenaltyDeduction = incidentPenaltyFactor * 0.10;

  // ── Step 3: Aggregate and convert to 0-100 scale ────────────────────────
  const rawBaseScore =
    (auditedSuppliersContribution +
      codeOfConductContribution +
      documentedPoliciesContribution +
      grievanceMechanismContribution -
      incidentPenaltyDeduction) *
    100;

  const weightedBaseScore = round(clamp(rawBaseScore, 0, 100), 4);

  const componentScores: P003ComputationDetail["componentScores"] = {
    auditedSuppliersContribution: round(auditedSuppliersContribution * 100, 4),
    codeOfConductContribution: round(codeOfConductContribution * 100, 4),
    documentedPoliciesContribution: round(documentedPoliciesContribution * 100, 4),
    grievanceMechanismContribution: round(grievanceMechanismContribution * 100, 4),
    incidentPenaltyDeduction: round(incidentPenaltyDeduction * 100, 4),
  };

  return { weightedBaseScore, componentScores };
}

/**
 * Applies the LLM qualitative adjustment to the P-003 base score and
 * assembles the full computation detail object.
 *
 * @param input          Validated P-003 raw inputs (for context in the detail).
 * @param baseResult     Output of computeP003BaseScore.
 * @param llmAdjustment  Qualitative adjustment in [P003_LLM_ADJ_MIN, P003_LLM_ADJ_MAX].
 *                       Pass null if the LLM call was skipped or failed.
 * @param llmOutput      Full structured output from the LLM tool call, or null.
 */
export function applyP003LlmAdjustment(
  _input: P003RawInput,
  baseResult: ReturnType<typeof computeP003BaseScore>,
  llmAdjustment: number | null,
  llmOutput: {
    rationale: string;
    riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    keyFindings: string[];
  } | null,
): {
  scoreValue: number;
  normalizedValue: number;
  confidenceScore: number;
  detail: P003ComputationDetail;
} {
  // Clamp the LLM adjustment to the allowable range.
  const clampedAdjustment =
    llmAdjustment !== null
      ? clamp(llmAdjustment, P003_LLM_ADJ_MIN, P003_LLM_ADJ_MAX)
      : 0;

  const finalScore = round(
    clamp(baseResult.weightedBaseScore + clampedAdjustment, 0, 100),
    2,
  );

  const normalizedValue = clamp(finalScore / 100, 0, 1);

  // Confidence is reduced when the LLM was not invoked or produced a large swing.
  let confidenceScore = 1.0;
  if (llmAdjustment === null) {
    // No LLM call — qualitative dimension is unscored.
    confidenceScore = 0.75;
  } else if (Math.abs(clampedAdjustment) >= 15) {
    // Large LLM swing — flag for human review.
    confidenceScore = 0.85;
  }

  const detail: P003ComputationDetail = {
    primerCode: "P-003",
    weightedBaseScore: baseResult.weightedBaseScore,
    componentScores: baseResult.componentScores,
    llmQualitativeAdjustment: llmAdjustment !== null ? round(clampedAdjustment, 2) : null,
    llmRationale: llmOutput?.rationale ?? null,
    llmRiskLevel: llmOutput?.riskLevel ?? null,
    llmKeyFindings: llmOutput?.keyFindings ?? null,
    finalScore,
  };

  return {
    scoreValue: finalScore,
    normalizedValue: round(normalizedValue, 8),
    confidenceScore: round(confidenceScore, 4),
    detail,
  };
}

// ─── Percentile Rank Computation ─────────────────────────────────────────────

/**
 * Computes the percentile rank of a score within an array of peer scores.
 * Uses the standard "less than" formulation:
 *   percentile = (count of scores strictly less than target) / total × 100
 *
 * @param targetScore  The score to rank.
 * @param peerScores   Array of peer scores (including the target, or excluding — both valid).
 * @returns            Percentile rank in [0, 100].
 */
export function computePercentileRank(
  targetScore: number,
  peerScores: number[],
): number {
  if (peerScores.length === 0) {
    return 50; // No peers — default to median.
  }
  const below = peerScores.filter((s) => s < targetScore).length;
  return round((below / peerScores.length) * 100, 2);
}
