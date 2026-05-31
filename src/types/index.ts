/**
 * src/types/index.ts
 *
 * Shared type definitions for the Aurora Energy ESG Agentic Pipeline.
 *
 * These types form the canonical contract between:
 *   - LangGraph node functions (AgentState)
 *   - The scoring engine (scoring.ts)
 *   - The tRPC API layer (Phase 2)
 *   - Drizzle persistence helpers
 *
 * Design notes:
 *   - AgentState is the "TypedDict equivalent" that LangGraph carries
 *     through the StateGraph.  All fields are either replaced or appended
 *     via Annotation reducers defined in graph.ts.
 *   - Immutability: nodes return Partial<AgentState>; the framework merges.
 */

// ─── Company Context ──────────────────────────────────────────────────────────

/**
 * Immutable descriptor for the company being evaluated.
 * Populated once at graph entry and never mutated by downstream nodes.
 */
export interface CompanyContext {
  /** UUID primary key from the `companies` table. */
  id: string;
  name: string;
  ticker: string;
  industryGroup: string;
}

// ─── Raw Input Data ───────────────────────────────────────────────────────────

/**
 * Raw, unvalidated inputs supplied by the data-ingestion layer.
 * Each primer's fields are namespaced under its own sub-interface
 * to prevent collision and to allow partial pipeline runs.
 */
export interface P001RawInput {
  /** Gross Scope 1 GHG emissions in metric tonnes CO₂e for the reporting year. */
  scope1Emissions: number;
  /** Annual revenue in millions of Canadian dollars. */
  revenueMillions: number;
}

export interface P002RawInput {
  /** Total number of seats on the board of directors. */
  boardSize: number;
  /** Number of female-identifying directors. */
  femaleDirectors: number;
}

export interface P003RawInput {
  /** Fraction of tier-1 suppliers audited against labor standards. Range [0, 1]. */
  auditedSuppliersRatio: number;
  /** Fraction of supply chain covered by a signed code of conduct. Range [0, 1]. */
  codeOfConductCoverage: number;
  /** Normalized existence score for documented human-rights / labor policies. Range [0, 1]. */
  documentedPoliciesScore: number;
  /** Normalized score for accessibility and quality of worker grievance mechanisms. Range [0, 1]. */
  grievanceMechanismScore: number;
  /** Number of reported labor-related incidents during the reporting year. Integer ≥ 0. */
  incidentCount: number;
  /** Optional free-text qualitative narrative for LLM qualitative adjustment. */
  supplyChainNarrative?: string;
}

export interface RawInputData {
  p001?: P001RawInput;
  p002?: P002RawInput;
  p003?: P003RawInput;
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface PrimerValidationResult {
  /** Whether this primer passed all validation checks. */
  isValid: boolean;
  /** Human-readable error messages, empty when isValid === true. */
  errors: string[];
  /** Non-fatal warnings that do not block scoring. */
  warnings: string[];
}

export interface ValidationFlags {
  p001: PrimerValidationResult;
  p002: PrimerValidationResult;
  p003: PrimerValidationResult;
}

// ─── Scoring Intermediates ────────────────────────────────────────────────────

/**
 * Complete scoring result for a single primer, produced by a scoring node
 * and accumulated in AgentState.accumulatedScores.
 */
export interface PrimerScore {
  /** DB primary key of the primer row. */
  primerId: string;
  /** Canonical code: P-001 | P-002 | P-003. */
  primerCode: "P-001" | "P-002" | "P-003";
  /** Final score in [0, 100]. */
  scoreValue: number;
  /**
   * Dimensionless normalized value in [0, 1] that bridges the raw measurement
   * to the 0-100 score (e.g. CO₂ intensity ratio, diversity ratio, weighted sum).
   */
  normalizedValue: number;
  /**
   * Agent-assigned confidence in [0, 1].
   * Reduced for boundary-condition inputs or when LLM output shows low certainty.
   */
  confidenceScore: number;
  /** Semver methodology version tag. */
  methodologyVersion: string;
  /** Intermediate computation detail for auditability. */
  computationDetail: P001ComputationDetail | P002ComputationDetail | P003ComputationDetail;
}

// ─── Per-Primer Computation Detail ───────────────────────────────────────────

export interface P001ComputationDetail {
  primerCode: "P-001";
  /** tCO₂ / $M revenue. */
  intensityRatio: number;
  /** Peer average benchmark: 52.3 tCO₂/$M. */
  peerBenchmarkIntensity: number;
  /**
   * Percentage by which this company's intensity is below (negative) or
   * above (positive) the peer benchmark.
   */
  deviationFromBenchmarkPct: number;
  /** Raw score before any final clamping. */
  rawScore: number;
}

export interface P002ComputationDetail {
  primerCode: "P-002";
  /** femaleDirectors / boardSize. */
  diversityRatio: number;
  /** TSX60 average: 0.282. */
  tsx60AverageDiversity: number;
  /**
   * Percentage points above (positive) or below (negative) TSX60 average.
   */
  deviationFromTsx60Pp: number;
  rawScore: number;
}

export interface P003ComputationDetail {
  primerCode: "P-003";
  /** Weighted mathematical base score before LLM adjustment. Range [0, 100]. */
  weightedBaseScore: number;
  /** Individual component contributions. */
  componentScores: {
    auditedSuppliersContribution: number;
    codeOfConductContribution: number;
    documentedPoliciesContribution: number;
    grievanceMechanismContribution: number;
    incidentPenaltyDeduction: number;
  };
  /** Qualitative adjustment from LLM in range [-20, +20]. null if LLM was not invoked. */
  llmQualitativeAdjustment: number | null;
  /** LLM's rationale text for the qualitative adjustment. */
  llmRationale: string | null;
  /** LLM-assigned categorical risk level. */
  llmRiskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | null;
  /** Key findings surfaced by the LLM analysis. */
  llmKeyFindings: string[] | null;
  /** Final score after clamping: base + llmAdjustment. Range [0, 100]. */
  finalScore: number;
}

// ─── LLM Structured Output ────────────────────────────────────────────────────

/**
 * Structured output returned by the LLM tool call in the P-003 node.
 * The Zod schema that enforces this shape lives in p003Node.ts.
 */
export interface P003LlmOutput {
  qualitativeAdjustment: number;
  rationale: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  keyFindings: string[];
}

// ─── Execution Tracing ────────────────────────────────────────────────────────

/**
 * Snapshot record for a single LangGraph node execution, persisted to
 * the `agent_traces` table by the persistenceNode.
 */
export interface ExecutionTrace {
  /** DB-assigned UUID (v4). */
  id: string;
  /** Matches the LangGraph node name (e.g. "p001Processing"). */
  nodeName: string;
  /** Unix timestamp (ms) at node entry. */
  startTimeMs: number;
  /** Unix timestamp (ms) at node exit. */
  endTimeMs: number;
  /** Computed duration in ms. */
  executionDurationMs: number;
  /** Serialisable snapshot of the AgentState fields this node read. */
  inputSnapshot: Record<string, unknown>;
  /** Serialisable snapshot of the Partial<AgentState> this node returned. */
  outputSnapshot: Record<string, unknown>;
  /** Anthropic/OpenAI model identifier, undefined for non-LLM nodes. */
  llmModelUsed?: string;
}

// ─── LangGraph Agent State ────────────────────────────────────────────────────

/**
 * AgentState is the single source of truth carried through the entire
 * LangGraph StateGraph.  Every node function receives a read-only snapshot
 * and returns a Partial<AgentState> that the framework merges via the
 * reducers declared in graph.ts.
 *
 * Conceptually equivalent to a LangGraph `TypedDict` (Python) or a
 * `MessagesAnnotation`-style annotated state (JS/TS).
 */
export interface AgentState {
  // ── Identity ──────────────────────────────────────────────────────────────
  companyContext: CompanyContext;
  reportingYear: number;

  // ── Input ─────────────────────────────────────────────────────────────────
  rawInputData: RawInputData;

  // ── Validation ────────────────────────────────────────────────────────────
  validationFlags: ValidationFlags;

  // ── Scores ────────────────────────────────────────────────────────────────
  /**
   * Scoring nodes append to this array; the persistence node reads it.
   * Reducer: array append (not replace).
   */
  accumulatedScores: PrimerScore[];

  // ── Tracing ───────────────────────────────────────────────────────────────
  /**
   * Each node appends its own ExecutionTrace entry.
   * Reducer: array append.
   */
  executionTraces: ExecutionTrace[];

  // ── Diagnostics ───────────────────────────────────────────────────────────
  /**
   * Non-fatal error messages accumulated across nodes.
   * A primer is skipped when its validation flag is false; the error is recorded here.
   * Reducer: array append.
   */
  errors: string[];

  /**
   * Set to true only by the persistenceNode after all DB writes succeed.
   */
  processingComplete: boolean;
}

// ─── Pipeline Run Request ─────────────────────────────────────────────────────

/**
 * External interface used to kick off a pipeline run.
 * Consumed by the tRPC router (Phase 2) and the CLI entry point.
 */
export interface PipelineRunRequest {
  companyId: string;
  reportingYear: number;
  rawInputData: RawInputData;
}

/**
 * Summary returned at the end of a successful pipeline run.
 */
export interface PipelineRunResult {
  companyId: string;
  reportingYear: number;
  scores: PrimerScore[];
  processingComplete: boolean;
  errors: string[];
  executionTraces: ExecutionTrace[];
}

// ─── Scoring Engine Inputs ────────────────────────────────────────────────────

/**
 * Validated inputs passed directly into the pure scoring functions.
 * These types are used inside scoring.ts after validation has been confirmed.
 */
export interface ValidatedP001Input extends P001RawInput {
  readonly _validated: true;
}

export interface ValidatedP002Input extends P002RawInput {
  readonly _validated: true;
}

export interface ValidatedP003Input extends P003RawInput {
  readonly _validated: true;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const PRIMER_IDS = {
  P001: "10000000-0000-0000-0000-000000000001",
  P002: "10000000-0000-0000-0000-000000000002",
  P003: "10000000-0000-0000-0000-000000000003",
} as const;

export const METHODOLOGY_VERSION = process.env["METHODOLOGY_VERSION"] ?? "v1.0.0";

export const P001_PEER_BENCHMARK_INTENSITY = Number(
  process.env["P001_PEER_BENCHMARK_INTENSITY"] ?? "52.3",
);

export const P002_TSX60_AVERAGE_DIVERSITY = Number(
  process.env["P002_TSX60_AVERAGE_DIVERSITY"] ?? "0.282",
);

/** P-003 LLM qualitative adjustment bounds. */
export const P003_LLM_ADJ_MIN = -20;
export const P003_LLM_ADJ_MAX = 20;

/** Incident count at which the penalty factor saturates to 1.0. */
export const P003_INCIDENT_SATURATION = 10;
