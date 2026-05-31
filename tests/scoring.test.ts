/**
 * tests/scoring.test.ts
 *
 * Unit tests for all pure mathematical scoring and validation functions.
 * No database, no LLM, no side effects — deterministic assertions only.
 *
 * Test coverage:
 *   P-001 — validateP001Input, computeP001Score
 *   P-002 — validateP002Input, computeP002Score
 *   P-003 — validateP003Input, computeP003BaseScore, applyP003LlmAdjustment
 *   Utils — computePercentileRank
 *
 * Expected values are hand-computed from the formulas documented in scoring.ts.
 */

import { describe, it, expect } from "vitest";
import {
  validateP001Input,
  computeP001Score,
  validateP002Input,
  computeP002Score,
  validateP003Input,
  computeP003BaseScore,
  applyP003LlmAdjustment,
  computePercentileRank,
} from "../src/agents/scoring";
import type { P001RawInput, P002RawInput, P003RawInput } from "../src/types/index";

// ─── Aurora Energy 2023 Fixture ───────────────────────────────────────────────

const AURORA_P001: P001RawInput = {
  scope1Emissions: 38_250,
  revenueMillions: 850,
};

const AURORA_P002: P002RawInput = {
  boardSize: 13,
  femaleDirectors: 4,
};

const AURORA_P003: P003RawInput = {
  auditedSuppliersRatio: 0.72,
  codeOfConductCoverage: 0.88,
  documentedPoliciesScore: 0.65,
  grievanceMechanismScore: 0.80,
  incidentCount: 2,
  supplyChainNarrative: "Test narrative for unit tests.",
};

// ═════════════════════════════════════════════════════════════════════════════
// P-001 — Scope 1 CO₂ Emissions
// ═════════════════════════════════════════════════════════════════════════════

describe("P-001: validateP001Input", () => {
  it("passes a valid input with no warnings", () => {
    const result = validateP001Input(AURORA_P001);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails when scope1Emissions is zero", () => {
    const result = validateP001Input({ scope1Emissions: 0, revenueMillions: 850 });
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toMatch(/scope1Emissions/);
  });

  it("fails when scope1Emissions is negative", () => {
    const result = validateP001Input({ scope1Emissions: -100, revenueMillions: 850 });
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toMatch(/scope1Emissions/);
  });

  it("fails when revenueMillions is zero", () => {
    const result = validateP001Input({ scope1Emissions: 38_250, revenueMillions: 0 });
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toMatch(/revenueMillions/);
  });

  it("fails when both fields are invalid", () => {
    const result = validateP001Input({ scope1Emissions: -1, revenueMillions: -1 });
    expect(result.isValid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it("issues a warning for suspiciously high emissions (still valid — ceiling only warns)", () => {
    const result = validateP001Input({
      scope1Emissions: 50_000_001,
      revenueMillions: 1_000,
    });
    // Exceeding the ceiling triggers a warning, not a hard error.
    expect(result.isValid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/ceiling/i);
  });

  it("issues a warning when intensity is >20× peer benchmark", () => {
    const result = validateP001Input({
      scope1Emissions: 52.3 * 21 * 100,
      revenueMillions: 100,
    });
    expect(result.isValid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/intensity/i);
  });

  it("accepts NaN-like strings coerced to NaN", () => {
    const result = validateP001Input({
      scope1Emissions: NaN,
      revenueMillions: 850,
    });
    expect(result.isValid).toBe(false);
  });
});

describe("P-001: computeP001Score", () => {
  it("computes the correct score for Aurora Energy 2023 fixture", () => {
    // intensity = 38250 / 850 = 45.0 tCO₂/$M
    // rawScore = 100 × (1 − 45 / 104.6) = 100 × 0.56977 ≈ 56.98
    const { scoreValue } = computeP001Score(AURORA_P001);
    expect(scoreValue).toBeCloseTo(56.98, 1);
  });

  it("returns 50 when intensity exactly equals the peer benchmark (52.3)", () => {
    // score = 100 × (1 − 52.3 / 104.6) = 50.00
    const { scoreValue } = computeP001Score({
      scope1Emissions: 52.3,
      revenueMillions: 1,
    });
    expect(scoreValue).toBeCloseTo(50.0, 4);
  });

  it("returns 100 when intensity is effectively zero", () => {
    const { scoreValue } = computeP001Score({
      scope1Emissions: 0.001,
      revenueMillions: 1_000_000,
    });
    expect(scoreValue).toBeCloseTo(100, 0);
  });

  it("clamps to 0 when intensity equals 2× benchmark", () => {
    // intensity = 104.6 → score = 0
    const { scoreValue } = computeP001Score({
      scope1Emissions: 104.6,
      revenueMillions: 1,
    });
    expect(scoreValue).toBeCloseTo(0, 4);
  });

  it("clamps to 0 for intensity well above 2× benchmark", () => {
    const { scoreValue } = computeP001Score({
      scope1Emissions: 1_000_000,
      revenueMillions: 1,
    });
    expect(scoreValue).toBe(0);
  });

  it("returns normalizedValue in [0, 1]", () => {
    const { normalizedValue } = computeP001Score(AURORA_P001);
    expect(normalizedValue).toBeGreaterThanOrEqual(0);
    expect(normalizedValue).toBeLessThanOrEqual(1);
  });

  it("exposes the correct intensityRatio in detail", () => {
    const { detail } = computeP001Score(AURORA_P001);
    expect(detail.intensityRatio).toBeCloseTo(45.0, 2);
    expect(detail.primerCode).toBe("P-001");
  });

  it("sets full confidence (1.0) for typical values", () => {
    const { confidenceScore } = computeP001Score(AURORA_P001);
    expect(confidenceScore).toBe(1.0);
  });

  it("reduces confidence for extreme intensity (>5× benchmark)", () => {
    const { confidenceScore } = computeP001Score({
      scope1Emissions: 52.3 * 6,
      revenueMillions: 1,
    });
    expect(confidenceScore).toBeLessThan(1.0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// P-002 — Board Gender Diversity
// ═════════════════════════════════════════════════════════════════════════════

describe("P-002: validateP002Input", () => {
  it("passes a valid input", () => {
    const result = validateP002Input(AURORA_P002);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails when boardSize is below minimum (3)", () => {
    const result = validateP002Input({ boardSize: 2, femaleDirectors: 1 });
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toMatch(/boardSize/);
  });

  it("fails when boardSize exceeds maximum (25)", () => {
    const result = validateP002Input({ boardSize: 26, femaleDirectors: 0 });
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toMatch(/boardSize/);
  });

  it("fails when femaleDirectors is negative", () => {
    const result = validateP002Input({ boardSize: 10, femaleDirectors: -1 });
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toMatch(/femaleDirectors/);
  });

  it("fails when femaleDirectors exceeds boardSize", () => {
    const result = validateP002Input({ boardSize: 10, femaleDirectors: 11 });
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toMatch(/femaleDirectors.*cannot exceed/i);
  });

  it("passes when femaleDirectors equals boardSize", () => {
    const result = validateP002Input({ boardSize: 10, femaleDirectors: 10 });
    expect(result.isValid).toBe(true);
  });

  it("issues a warning for very small boards (< 5)", () => {
    const result = validateP002Input({ boardSize: 3, femaleDirectors: 1 });
    expect(result.isValid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("accepts non-integer values and fails appropriately", () => {
    const result = validateP002Input({ boardSize: 10.5, femaleDirectors: 3 });
    expect(result.isValid).toBe(false);
  });
});

describe("P-002: computeP002Score", () => {
  it("computes the correct score for Aurora Energy 2023 fixture", () => {
    // diversity = 4/13 ≈ 0.3077
    // score = (0.3077 / 0.5) × 100 ≈ 61.54
    const { scoreValue } = computeP002Score(AURORA_P002);
    expect(scoreValue).toBeCloseTo(61.54, 1);
  });

  it("returns 0 for all-male board", () => {
    const { scoreValue } = computeP002Score({ boardSize: 10, femaleDirectors: 0 });
    expect(scoreValue).toBe(0);
  });

  it("returns 100 for 50 % gender parity", () => {
    const { scoreValue } = computeP002Score({ boardSize: 10, femaleDirectors: 5 });
    expect(scoreValue).toBeCloseTo(100, 4);
  });

  it("caps at 100 when diversity exceeds 50 %", () => {
    const { scoreValue } = computeP002Score({ boardSize: 10, femaleDirectors: 7 });
    expect(scoreValue).toBe(100);
  });

  it("scores approx 56.4 for TSX60 average diversity (28 %)", () => {
    // diversity ≈ 0.28 → score ≈ 56
    const { scoreValue } = computeP002Score({ boardSize: 100, femaleDirectors: 28 });
    expect(scoreValue).toBeCloseTo(56, 0);
  });

  it("returns diversityRatio in detail object", () => {
    const { detail } = computeP002Score(AURORA_P002);
    expect(detail.diversityRatio).toBeCloseTo(4 / 13, 4);
    expect(detail.primerCode).toBe("P-002");
  });

  it("returns normalizedValue in [0, 1]", () => {
    const { normalizedValue } = computeP002Score(AURORA_P002);
    expect(normalizedValue).toBeGreaterThanOrEqual(0);
    expect(normalizedValue).toBeLessThanOrEqual(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// P-003 — Supply Chain Labor Risk
// ═════════════════════════════════════════════════════════════════════════════

describe("P-003: validateP003Input", () => {
  it("passes a valid input with narrative", () => {
    const result = validateP003Input(AURORA_P003);
    expect(result.isValid).toBe(true);
  });

  it("passes a valid input without narrative (with warning)", () => {
    const { supplyChainNarrative: _omit, ...rest } = AURORA_P003;
    const result = validateP003Input(rest);
    expect(result.isValid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("fails when a ratio field is below 0", () => {
    const result = validateP003Input({ ...AURORA_P003, auditedSuppliersRatio: -0.1 });
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toMatch(/auditedSuppliersRatio/);
  });

  it("fails when a ratio field exceeds 1", () => {
    const result = validateP003Input({ ...AURORA_P003, codeOfConductCoverage: 1.01 });
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toMatch(/codeOfConductCoverage/);
  });

  it("fails when incidentCount is negative", () => {
    const result = validateP003Input({ ...AURORA_P003, incidentCount: -1 });
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toMatch(/incidentCount/);
  });

  it("fails when incidentCount is non-integer", () => {
    const result = validateP003Input({ ...AURORA_P003, incidentCount: 2.5 });
    expect(result.isValid).toBe(false);
  });

  it("issues a warning for empty narrative string", () => {
    const result = validateP003Input({ ...AURORA_P003, supplyChainNarrative: "   " });
    expect(result.isValid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("P-003: computeP003BaseScore", () => {
  it("computes the correct weighted base score for Aurora Energy 2023 fixture", () => {
    // auditedSuppliersRatio = 0.72 × 0.30 × 100 = 21.6
    // codeOfConductCoverage = 0.88 × 0.25 × 100 = 22.0
    // documentedPoliciesScore = 0.65 × 0.20 × 100 = 13.0
    // grievanceMechanismScore = 0.80 × 0.15 × 100 = 12.0
    // incidentPenalty = (2/10) × 0.10 × 100 = 2.0
    // base = 21.6 + 22.0 + 13.0 + 12.0 − 2.0 = 66.6
    const { weightedBaseScore } = computeP003BaseScore(AURORA_P003);
    expect(weightedBaseScore).toBeCloseTo(66.6, 2);
  });

  it("returns 0 for all-zero inputs", () => {
    const { weightedBaseScore } = computeP003BaseScore({
      auditedSuppliersRatio: 0,
      codeOfConductCoverage: 0,
      documentedPoliciesScore: 0,
      grievanceMechanismScore: 0,
      incidentCount: 0,
    });
    expect(weightedBaseScore).toBe(0);
  });

  it("returns maximum possible score (90) for all-max inputs with zero incidents", () => {
    // max = (0.30 + 0.25 + 0.20 + 0.15) × 100 = 90
    const { weightedBaseScore } = computeP003BaseScore({
      auditedSuppliersRatio: 1,
      codeOfConductCoverage: 1,
      documentedPoliciesScore: 1,
      grievanceMechanismScore: 1,
      incidentCount: 0,
    });
    expect(weightedBaseScore).toBeCloseTo(90, 4);
  });

  it("deducts 10 points when incidentCount saturates penalty (>=10)", () => {
    const full = computeP003BaseScore({
      auditedSuppliersRatio: 1,
      codeOfConductCoverage: 1,
      documentedPoliciesScore: 1,
      grievanceMechanismScore: 1,
      incidentCount: 0,
    });
    const penalised = computeP003BaseScore({
      auditedSuppliersRatio: 1,
      codeOfConductCoverage: 1,
      documentedPoliciesScore: 1,
      grievanceMechanismScore: 1,
      incidentCount: 10,
    });
    expect(full.weightedBaseScore - penalised.weightedBaseScore).toBeCloseTo(10, 4);
  });

  it("clamps score at 0 when penalty exceeds positive contributions", () => {
    const { weightedBaseScore } = computeP003BaseScore({
      auditedSuppliersRatio: 0,
      codeOfConductCoverage: 0,
      documentedPoliciesScore: 0,
      grievanceMechanismScore: 0,
      incidentCount: 100,
    });
    expect(weightedBaseScore).toBe(0);
  });

  it("exposes correct component scores", () => {
    const { componentScores } = computeP003BaseScore(AURORA_P003);
    expect(componentScores.auditedSuppliersContribution).toBeCloseTo(21.6, 2);
    expect(componentScores.codeOfConductContribution).toBeCloseTo(22.0, 2);
    expect(componentScores.documentedPoliciesContribution).toBeCloseTo(13.0, 2);
    expect(componentScores.grievanceMechanismContribution).toBeCloseTo(12.0, 2);
    expect(componentScores.incidentPenaltyDeduction).toBeCloseTo(2.0, 2);
  });
});

describe("P-003: applyP003LlmAdjustment", () => {
  const baseResult = computeP003BaseScore(AURORA_P003);

  it("applies a positive LLM adjustment correctly", () => {
    const { scoreValue } = applyP003LlmAdjustment(AURORA_P003, baseResult, 5.0, {
      rationale: "Strong programs.",
      riskLevel: "LOW",
      keyFindings: ["Finding A"],
    });
    expect(scoreValue).toBeCloseTo(71.6, 1);
  });

  it("applies a negative LLM adjustment correctly", () => {
    const { scoreValue } = applyP003LlmAdjustment(AURORA_P003, baseResult, -10.0, {
      rationale: "Gaps in supplier audits.",
      riskLevel: "MEDIUM",
      keyFindings: ["Finding B"],
    });
    expect(scoreValue).toBeCloseTo(56.6, 1);
  });

  it("returns base score unchanged when LLM adjustment is null", () => {
    const { scoreValue } = applyP003LlmAdjustment(AURORA_P003, baseResult, null, null);
    expect(scoreValue).toBeCloseTo(66.6, 1);
  });

  it("reduces confidence to 0.75 when LLM is not invoked", () => {
    const { confidenceScore } = applyP003LlmAdjustment(AURORA_P003, baseResult, null, null);
    expect(confidenceScore).toBeCloseTo(0.75, 4);
  });

  it("reduces confidence to 0.85 for large LLM swing (|adj| >= 15)", () => {
    const { confidenceScore } = applyP003LlmAdjustment(AURORA_P003, baseResult, 16.0, {
      rationale: "Exceptional transparency.",
      riskLevel: "LOW",
      keyFindings: ["Finding C"],
    });
    expect(confidenceScore).toBeCloseTo(0.85, 4);
  });

  it("clamps final score at 100 when base + adjustment exceeds 100", () => {
    const maxBase = computeP003BaseScore({
      auditedSuppliersRatio: 1,
      codeOfConductCoverage: 1,
      documentedPoliciesScore: 1,
      grievanceMechanismScore: 1,
      incidentCount: 0,
    });
    const { scoreValue } = applyP003LlmAdjustment(AURORA_P003, maxBase, 20.0, {
      rationale: "Best in class.",
      riskLevel: "LOW",
      keyFindings: ["Finding D"],
    });
    expect(scoreValue).toBe(100);
  });

  it("clamps final score at 0 when base + adjustment is negative", () => {
    const zeroBase = computeP003BaseScore({
      auditedSuppliersRatio: 0,
      codeOfConductCoverage: 0,
      documentedPoliciesScore: 0,
      grievanceMechanismScore: 0,
      incidentCount: 0,
    });
    const { scoreValue } = applyP003LlmAdjustment(AURORA_P003, zeroBase, -20.0, {
      rationale: "Critical failure.",
      riskLevel: "CRITICAL",
      keyFindings: ["Finding E"],
    });
    expect(scoreValue).toBe(0);
  });

  it("clamps LLM adjustment to max +20 even if provided value is higher", () => {
    const { detail } = applyP003LlmAdjustment(AURORA_P003, baseResult, 25.0, {
      rationale: "Out of bounds.",
      riskLevel: "LOW",
      keyFindings: ["Finding F"],
    });
    expect((detail as { llmQualitativeAdjustment: number }).llmQualitativeAdjustment).toBe(20);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Utility — computePercentileRank
// ═════════════════════════════════════════════════════════════════════════════

describe("computePercentileRank", () => {
  it("returns 50 for an empty peer set", () => {
    expect(computePercentileRank(75, [])).toBe(50);
  });

  it("returns 0 when the target score is the lowest in the peer set", () => {
    expect(computePercentileRank(10, [20, 30, 40, 50])).toBe(0);
  });

  it("returns 100 when the target score is the highest", () => {
    expect(computePercentileRank(100, [10, 20, 30, 40, 50])).toBe(100);
  });

  it("correctly ranks a middle score", () => {
    // [10, 20, 30, 40, 50] — target 30 → 2 scores below → 2/5 × 100 = 40
    expect(computePercentileRank(30, [10, 20, 30, 40, 50])).toBe(40);
  });

  it("handles a single-element peer set", () => {
    expect(computePercentileRank(60, [60])).toBe(0);
    expect(computePercentileRank(70, [60])).toBe(100);
  });
});
