/**
 * src/api/schemas/index.ts
 *
 * Runtime Zod validation schemas for all tRPC procedure inputs and outputs.
 *
 * Design principles:
 *  - Input schemas validate at the API boundary before any business logic runs.
 *  - The P-003 raw input uses a strict discriminated object (all fields typed
 *    individually) so that field-level errors are surfaced to the caller.
 *  - Output schemas are declared for documentation and type inference; they
 *    are attached to procedures via `.output()` in the router.
 *  - All numeric fields that map to Postgres `numeric` columns are represented
 *    as JS `number` — the conversion from string happens in the router.
 */

import { z } from "zod";

// ═════════════════════════════════════════════════════════════════════════════
// ── Shared primitives ────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

export const UuidSchema = z.string().uuid({ message: "Must be a valid UUID v4." });

export const ReportingYearSchema = z
  .number()
  .int({ message: "Reporting year must be an integer." })
  .min(2000, { message: "Reporting year must be ≥ 2000." })
  .max(2100, { message: "Reporting year must be ≤ 2100." });

export const PrimerCodeSchema = z.enum(["P-001", "P-002", "P-003"], {
  errorMap: () => ({ message: 'primerCode must be one of "P-001", "P-002", "P-003".' }),
});

// ═════════════════════════════════════════════════════════════════════════════
// ── P-001 Raw Input ──────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

export const P001RawInputSchema = z
  .object({
    scope1Emissions: z
      .number()
      .positive({ message: "scope1Emissions must be a positive number." })
      .finite({ message: "scope1Emissions must be finite." })
      .describe("Gross Scope 1 GHG emissions in metric tonnes CO₂e for the reporting year."),

    revenueMillions: z
      .number()
      .positive({ message: "revenueMillions must be a positive number." })
      .finite({ message: "revenueMillions must be finite." })
      .describe("Annual revenue in millions of Canadian dollars."),
  })
  .strict();

export type P001RawInputPayload = z.infer<typeof P001RawInputSchema>;

// ═════════════════════════════════════════════════════════════════════════════
// ── P-002 Raw Input ──────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

export const P002RawInputSchema = z
  .object({
    boardSize: z
      .number()
      .int({ message: "boardSize must be an integer." })
      .min(3, { message: "boardSize must be at least 3." })
      .max(25, { message: "boardSize must not exceed 25." })
      .describe("Total number of seats on the board of directors."),

    femaleDirectors: z
      .number()
      .int({ message: "femaleDirectors must be an integer." })
      .min(0, { message: "femaleDirectors must be non-negative." })
      .describe("Number of female-identifying directors."),
  })
  .strict()
  .refine(
    (data) => data.femaleDirectors <= data.boardSize,
    {
      message: "femaleDirectors cannot exceed boardSize.",
      path: ["femaleDirectors"],
    },
  );

export type P002RawInputPayload = z.infer<typeof P002RawInputSchema>;

// ═════════════════════════════════════════════════════════════════════════════
// ── P-003 Raw Input ──────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

const RatioField = (fieldName: string) =>
  z
    .number()
    .min(0, { message: `${fieldName} must be ≥ 0.` })
    .max(1, { message: `${fieldName} must be ≤ 1.` })
    .finite({ message: `${fieldName} must be finite.` });

export const P003RawInputSchema = z
  .object({
    auditedSuppliersRatio: RatioField("auditedSuppliersRatio").describe(
      "Fraction of tier-1 suppliers audited against labor standards. Range [0, 1].",
    ),

    codeOfConductCoverage: RatioField("codeOfConductCoverage").describe(
      "Fraction of supply chain covered by a signed code of conduct. Range [0, 1].",
    ),

    documentedPoliciesScore: RatioField("documentedPoliciesScore").describe(
      "Normalized existence score for documented human-rights / labor policies. Range [0, 1].",
    ),

    grievanceMechanismScore: RatioField("grievanceMechanismScore").describe(
      "Normalized score for accessibility and quality of worker grievance mechanisms. Range [0, 1].",
    ),

    incidentCount: z
      .number()
      .int({ message: "incidentCount must be an integer." })
      .min(0, { message: "incidentCount must be non-negative." })
      .describe("Number of reported labor-related incidents during the reporting year."),

    supplyChainNarrative: z
      .string()
      .max(8000, { message: "supplyChainNarrative must not exceed 8,000 characters." })
      .optional()
      .describe(
        "Optional free-text narrative describing supply chain practices. " +
        "Provided to the LLM for qualitative adjustment scoring.",
      ),
  })
  .strict();

export type P003RawInputPayload = z.infer<typeof P003RawInputSchema>;

// ═════════════════════════════════════════════════════════════════════════════
// ── Raw Input Data (container) ────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

export const RawInputDataSchema = z
  .object({
    p001: P001RawInputSchema.optional(),
    p002: P002RawInputSchema.optional(),
    p003: P003RawInputSchema.optional(),
  })
  .refine(
    (data) =>
      data.p001 !== undefined ||
      data.p002 !== undefined ||
      data.p003 !== undefined,
    {
      message:
        "At least one primer input (p001, p002, or p003) must be provided.",
    },
  );

export type RawInputDataPayload = z.infer<typeof RawInputDataSchema>;

// ═════════════════════════════════════════════════════════════════════════════
// ── Procedure Input Schemas ───────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

/** Input for `primer.submitData` (mutation). */
export const SubmitDataInputSchema = z
  .object({
    companyId: UuidSchema.describe("UUID of the company record in the `companies` table."),
    reportingYear: ReportingYearSchema,
    rawInputData: RawInputDataSchema,
  })
  .strict();

export type SubmitDataInput = z.infer<typeof SubmitDataInputSchema>;

/** Input for `primer.getScore` (query). */
export const GetScoreInputSchema = z
  .object({
    companyId: UuidSchema,
    primerCode: PrimerCodeSchema,
    reportingYear: ReportingYearSchema,
  })
  .strict();

export type GetScoreInput = z.infer<typeof GetScoreInputSchema>;

/** Input for `primer.listScores` (query). */
export const ListScoresInputSchema = z
  .object({
    companyId: UuidSchema,
    reportingYear: ReportingYearSchema,
  })
  .strict();

export type ListScoresInput = z.infer<typeof ListScoresInputSchema>;

/** Input for `primer.getAgentTrace` (query). */
export const GetAgentTraceInputSchema = z
  .object({
    traceId: UuidSchema.describe("UUID of the `agent_traces` row to retrieve."),
  })
  .strict();

export type GetAgentTraceInput = z.infer<typeof GetAgentTraceInputSchema>;

// ═════════════════════════════════════════════════════════════════════════════
// ── Procedure Output Schemas ──────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════

export const ExecutionSummaryItemSchema = z.object({
  nodeName: z.string(),
  traceId: z.string(),
  durationMs: z.number(),
  llmModelUsed: z.string().nullable(),
});

export const ScoreSummarySchema = z.object({
  primerCode: PrimerCodeSchema,
  scoreValue: z.number(),
  confidenceScore: z.number(),
  methodologyVersion: z.string(),
});

/** Output for `primer.submitData`. */
export const SubmitDataOutputSchema = z.object({
  requestId: z.string(),
  companyId: UuidSchema,
  reportingYear: ReportingYearSchema,
  processingComplete: z.boolean(),
  scores: z.array(ScoreSummarySchema),
  errors: z.array(z.string()),
  executionSummary: z.array(ExecutionSummaryItemSchema),
  totalDurationMs: z.number(),
});

export type SubmitDataOutput = z.infer<typeof SubmitDataOutputSchema>;

/** Output for `primer.getScore`. */
export const ScoreDetailSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  primerCode: z.string(),
  primerName: z.string(),
  category: z.enum(["E", "S", "G"]),
  dataType: z.enum(["QUANTITATIVE", "QUALITATIVE", "HYBRID"]),
  reportingYear: z.number(),
  scoreValue: z.number(),
  percentileRank: z.number().nullable(),
  methodologyVersion: z.string(),
  computedAt: z.date(),
  normalizedValue: z.number().nullable(),
  confidenceScore: z.number().nullable(),
});

export const AgentTraceSummarySchema = z.object({
  id: z.string(),
  agentName: z.string(),
  executionDurationMs: z.number(),
  llmModelUsed: z.string().nullable(),
  createdAt: z.date(),
});

export const GetScoreOutputSchema = z.object({
  score: ScoreDetailSchema,
  agentTrace: AgentTraceSummarySchema.nullable(),
});

export type GetScoreOutput = z.infer<typeof GetScoreOutputSchema>;

/** Output for `primer.listScores`. */
export const ScoreListItemSchema = z.object({
  id: z.string(),
  primerCode: z.string(),
  primerName: z.string(),
  category: z.enum(["E", "S", "G"]),
  dataType: z.enum(["QUANTITATIVE", "QUALITATIVE", "HYBRID"]),
  scoreValue: z.number(),
  percentileRank: z.number().nullable(),
  methodologyVersion: z.string(),
  computedAt: z.date(),
});

export const PillarSummarySchema = z.object({
  averageScore: z.number().nullable(),
  primerCount: z.number(),
});

export const ListScoresOutputSchema = z.object({
  companyId: z.string(),
  reportingYear: z.number(),
  scoreCount: z.number(),
  scores: z.array(ScoreListItemSchema),
  pillars: z.object({
    environmental: PillarSummarySchema,
    social: PillarSummarySchema,
    governance: PillarSummarySchema,
    composite: z.object({ averageScore: z.number().nullable() }),
  }),
});

export type ListScoresOutput = z.infer<typeof ListScoresOutputSchema>;

/** Output for `primer.getAgentTrace`. */
export const GetAgentTraceOutputSchema = z.object({
  id: z.string(),
  agentName: z.string(),
  inputSnapshot: z.record(z.unknown()),
  outputSnapshot: z.record(z.unknown()),
  executionDurationMs: z.number(),
  llmModelUsed: z.string().nullable(),
  createdAt: z.date(),
});

export type GetAgentTraceOutput = z.infer<typeof GetAgentTraceOutputSchema>;
