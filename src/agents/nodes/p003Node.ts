/**
 * src/agents/nodes/p003Node.ts
 *
 * LangGraph node: "p003Processing"
 *
 * Responsibilities:
 *  1. Guards against invalid P-003 inputs (skips gracefully if validation failed).
 *  2. Computes the quantitative weighted base score via computeP003BaseScore.
 *  3. Invokes a structured LLM tool call (Anthropic Claude via LangChain) to
 *     obtain the qualitative adjustment and narrative analysis.
 *  4. Applies the LLM adjustment via applyP003LlmAdjustment.
 *  5. Builds a PrimerScore and appends it to AgentState.accumulatedScores.
 *  6. Appends an ExecutionTrace (tagged with the LLM model used).
 *
 * LLM Invocation:
 *  - Uses ChatAnthropic.withStructuredOutput() to enforce the P003LlmOutputSchema
 *    (Zod schema declared here).
 *  - If the LLM call fails, the node falls back to the pure base score with
 *    reduced confidence and records the error in AgentState.errors.
 */

import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { ChatAnthropic } from "@langchain/anthropic";

import { computeP003BaseScore, applyP003LlmAdjustment } from "../scoring";
import {
  P003_SYSTEM_PROMPT,
  buildP003UserPrompt,
} from "../prompts/p003SystemPrompt";
import type {
  AgentState,
  ExecutionTrace,
  PrimerScore,
  P003ComputationDetail,
} from "../../types/index";
import {
  PRIMER_IDS,
  METHODOLOGY_VERSION,
  P003_LLM_ADJ_MIN,
  P003_LLM_ADJ_MAX,
} from "../../types/index";

// ─── Zod Schema for LLM Structured Output ────────────────────────────────────

/**
 * Enforces the shape of the LLM's JSON response.
 * LangChain's withStructuredOutput uses this schema to bind a tool or
 * JSON-mode constraint, guaranteeing the output can be parsed safely.
 */
export const P003LlmOutputSchema = z.object({
  qualitativeAdjustment: z
    .number()
    .min(P003_LLM_ADJ_MIN)
    .max(P003_LLM_ADJ_MAX)
    .describe(
      `Numeric qualitative adjustment in [${String(P003_LLM_ADJ_MIN)}, ${String(P003_LLM_ADJ_MAX)}] to add to the base score.`,
    ),
  rationale: z
    .string()
    .min(20)
    .describe(
      "Detailed chain-of-thought rationale explaining the adjustment with specific evidence from the narrative.",
    ),
  riskLevel: z
    .enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"])
    .describe("Categorical risk level applied to the expected final score."),
  keyFindings: z
    .array(z.string().min(5))
    .min(1)
    .max(8)
    .describe("Array of specific, grounded key findings from the analysis."),
});

export type P003LlmOutputSchemaType = z.infer<typeof P003LlmOutputSchema>;

// ─── LLM Client Factory ───────────────────────────────────────────────────────

/**
 * Creates and configures the Anthropic LLM client with structured output binding.
 * If MOCK_LLM=true, returns a mock client that generates deterministic output without
 * requiring an API key or network access. Useful for demonstrations and testing.
 * Extracted into a factory function so it can be swapped in tests.
 */
function createP003LlmClient(): ReturnType<ChatAnthropic["withStructuredOutput"]> {
  // ── Check for mock mode ────────────────────────────────────────────────────
  if (process.env["MOCK_LLM"] === "true") {
    const mockOutput: P003LlmOutputSchemaType = {
      qualitativeAdjustment: 5.0,
      rationale:
        "Mock mode enabled (MOCK_LLM=true). Returned deterministic output for demonstration/testing purposes without Anthropic API access. " +
        "This represents a typical positive adjustment scenario reflecting strong documented labor policies, comprehensive supplier audit programs, " +
        "and a mature grievance mechanism with no critical incidents.",
      riskLevel: "MEDIUM",
      keyFindings: [
        "Mock output: Enables end-to-end pipeline execution without requiring an Anthropic API key.",
        "Demonstrates comprehensive supplier audit programs covering approximately 70% of tier-1 suppliers.",
        "Code of Conduct documented to cover 80% of supply chain operations with annual renewal.",
        "Grievance mechanism established with documented response procedures and accessibility.",
        "Zero critical labor incidents reported; minor issues addressed within 30 days.",
        "Supply chain visibility program includes third-party monitoring and audit certifications.",
      ],
    };

    // Return a mock invoker that matches the ChatAnthropic.withStructuredOutput interface
    const mockInvoker = {
      invoke: async () => mockOutput,
    } as unknown as ReturnType<ChatAnthropic["withStructuredOutput"]>;

    console.info("[p003Node] MOCK_LLM mode enabled — using deterministic mock output");
    return mockInvoker;
  }

  // ── Production mode: use Anthropic API ─────────────────────────────────────
  const modelName =
    process.env["LLM_MODEL"] ?? "claude-3-5-sonnet-20241022";

  const maxTokens = Number(process.env["LLM_MAX_TOKENS"] ?? "1024");

  const temperature = Number(process.env["LLM_TEMPERATURE"] ?? "0.1");

  if (!process.env["ANTHROPIC_API_KEY"]) {
    throw new Error(
      "[p003Node] ANTHROPIC_API_KEY is not set. Cannot invoke LLM for P-003 qualitative analysis. " +
      "Set MOCK_LLM=true to enable mock mode for demonstrations without an API key.",
    );
  }

  const chatModel = new ChatAnthropic({
    model: modelName,
    maxTokens,
    temperature,
  });

  // Cast through unknown so that exactOptionalPropertyTypes does not reject
  // the narrowed Zod-inferred generic against the broader base return type.
  return chatModel.withStructuredOutput(P003LlmOutputSchema, {
    name: "supply_chain_labor_risk_assessment",
  }) as unknown as ReturnType<ChatAnthropic["withStructuredOutput"]>;
}

// ─── Node Function ────────────────────────────────────────────────────────────

export async function p003Node(
  state: AgentState,
): Promise<Partial<AgentState>> {
  const startTimeMs = Date.now();
  const traceId = uuidv4();
  const llmModelName = process.env["LLM_MODEL"] ?? "claude-3-5-sonnet-20241022";

  const inputSnapshot: Record<string, unknown> = {
    companyId: state.companyContext.id,
    reportingYear: state.reportingYear,
    p003Valid: state.validationFlags.p003.isValid,
    p003Input: state.rawInputData.p003,
  };

  // ── Guard: skip if P-003 validation failed ────────────────────────────────
  if (!state.validationFlags.p003.isValid || state.rawInputData.p003 === undefined) {
    const endTimeMs = Date.now();

    const trace: ExecutionTrace = {
      id: traceId,
      nodeName: "p003Processing",
      startTimeMs,
      endTimeMs,
      executionDurationMs: endTimeMs - startTimeMs,
      inputSnapshot,
      outputSnapshot: {
        skipped: true,
        reason: "P-003 validation did not pass; node skipped.",
      },
    };

    console.info(
      `[p003Node] Skipped — validation did not pass (${state.validationFlags.p003.errors.join(", ")})`,
    );

    return { executionTraces: [trace] };
  }

  const p003Input = state.rawInputData.p003;

  // ── Step 1: Compute quantitative weighted base score ──────────────────────
  const baseResult = computeP003BaseScore(p003Input);

  console.info(
    `[p003Node] Quantitative base score: ${baseResult.weightedBaseScore.toFixed(2)} / 100`,
  );

  // ── Step 2: LLM qualitative adjustment ───────────────────────────────────
  let llmOutput: P003LlmOutputSchemaType | null = null;
  const llmErrors: string[] = [];

  try {
    const llmClient = createP003LlmClient();

    const userPrompt = buildP003UserPrompt({
      companyName: state.companyContext.name,
      reportingYear: state.reportingYear,
      quantitativeBaseScore: baseResult.weightedBaseScore,
      componentScores: baseResult.componentScores,
      rawMetrics: {
        auditedSuppliersRatio: p003Input.auditedSuppliersRatio,
        codeOfConductCoverage: p003Input.codeOfConductCoverage,
        documentedPoliciesScore: p003Input.documentedPoliciesScore,
        grievanceMechanismScore: p003Input.grievanceMechanismScore,
        incidentCount: p003Input.incidentCount,
      },
      supplyChainNarrative: p003Input.supplyChainNarrative,
    });

    console.info(
      `[p003Node] Invoking LLM (${llmModelName}) for qualitative adjustment...`,
    );

    const rawLlmOutput = await llmClient.invoke([
      { role: "system", content: P003_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ] as Parameters<typeof llmClient.invoke>[0]);

    // Validate the structured output with Zod (withStructuredOutput already
    // coerces, but we re-validate to guarantee type safety at our boundary).
    const parseResult = P003LlmOutputSchema.safeParse(rawLlmOutput);

    if (parseResult.success) {
      llmOutput = parseResult.data;
      console.info(
        `[p003Node] LLM output — adjustment: ${llmOutput.qualitativeAdjustment >= 0 ? "+" : ""}${String(llmOutput.qualitativeAdjustment)}, ` +
        `risk level: ${llmOutput.riskLevel}`,
      );
    } else {
      const zodError = parseResult.error.message;
      const errorMsg = `[P-003 LLM] Structured output Zod validation failed: ${zodError}`;
      console.error(`[p003Node] ${errorMsg}`);
      llmErrors.push(errorMsg);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const errorMsg = `[P-003 LLM] Tool call failed: ${message}. Falling back to base score with reduced confidence.`;
    console.error(`[p003Node] ${errorMsg}`);
    llmErrors.push(errorMsg);
  }

  // ── Step 3: Apply LLM adjustment (or use base score on failure) ───────────
  const adjustment = llmOutput?.qualitativeAdjustment ?? null;
  const llmOutputForAdjustment = llmOutput
    ? {
        rationale: llmOutput.rationale,
        riskLevel: llmOutput.riskLevel,
        keyFindings: llmOutput.keyFindings,
      }
    : null;

  const finalResult = applyP003LlmAdjustment(
    p003Input,
    baseResult,
    adjustment,
    llmOutputForAdjustment,
  );

  // ── Step 4: Build PrimerScore ─────────────────────────────────────────────
  const primerScore: PrimerScore = {
    primerId: PRIMER_IDS.P003,
    primerCode: "P-003",
    scoreValue: finalResult.scoreValue,
    normalizedValue: finalResult.normalizedValue,
    confidenceScore: finalResult.confidenceScore,
    methodologyVersion: METHODOLOGY_VERSION,
    computationDetail: finalResult.detail satisfies P003ComputationDetail,
  };

  const endTimeMs = Date.now();

  const outputSnapshot: Record<string, unknown> = {
    weightedBaseScore: baseResult.weightedBaseScore,
    llmAdjustment: adjustment,
    llmRiskLevel: llmOutput?.riskLevel ?? null,
    finalScore: primerScore.scoreValue,
    normalizedValue: primerScore.normalizedValue,
    confidenceScore: primerScore.confidenceScore,
    llmInvoked: llmOutput !== null,
  };

  const trace: ExecutionTrace = {
    id: traceId,
    nodeName: "p003Processing",
    startTimeMs,
    endTimeMs,
    executionDurationMs: endTimeMs - startTimeMs,
    inputSnapshot,
    outputSnapshot,
    llmModelUsed: llmModelName,
  };

  console.info(
    `[p003Node] Complete — base: ${baseResult.weightedBaseScore.toFixed(2)}, ` +
    `llm adj: ${adjustment !== null ? (adjustment >= 0 ? "+" : "") + String(adjustment) : "n/a"}, ` +
    `final: ${primerScore.scoreValue}, ` +
    `risk: ${llmOutput?.riskLevel ?? "n/a"} — ${trace.executionDurationMs}ms`,
  );

  return {
    accumulatedScores: [primerScore],
    executionTraces: [trace],
    errors: llmErrors,
  };
}
