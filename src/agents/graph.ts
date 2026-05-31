/**
 * src/agents/graph.ts
 *
 * Builds, compiles, and exports the LangGraph StateGraph for the Aurora Energy
 * ESG Agentic Pipeline.
 *
 * ─── Execution Topology ────────────────────────────────────────────────────
 *
 *   START
 *     │
 *     ▼
 *   [validation]
 *     │
 *     ├─ ALL primers fail → END (abort with errors)
 *     │
 *     └─ At least one primer valid → [p001Processing]
 *                                          │
 *                                     [p002Processing]
 *                                          │
 *                                     [p003Processing]
 *                                          │
 *                                      [persistence]
 *                                          │
 *                                         END
 *
 * Note on parallelism:
 *   The three primer nodes are intentionally sequential here to maintain a
 *   simple, deterministic trace log.  P-001 and P-002 are CPU-bound and
 *   complete in <1 ms each, so the overhead of fan-out coordination is not
 *   justified.  P-003 is I/O-bound (LLM call); it executes last so that
 *   P-001/P-002 scores are available for context if needed.  A parallel
 *   branch variant (using LangGraph's Send API) is noted in the comments
 *   but is not activated by default.
 *
 * ─── State Annotation & Reducers ────────────────────────────────────────────
 *
 *   Fields that nodes REPLACE use the identity reducer (last-write wins).
 *   Fields that nodes APPEND to use the concat reducer.
 *   This mirrors the Python TypedDict + operator_add pattern.
 */

import * as dotenv from "dotenv";
dotenv.config();

import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import type {
  AgentState,
  CompanyContext,
  RawInputData,
  ValidationFlags,
  PrimerScore,
  ExecutionTrace,
  PipelineRunRequest,
  PipelineRunResult,
} from "../types/index";
import {
  validationNode,
} from "./nodes/validationNode";
import { p001Node } from "./nodes/p001Node";
import { p002Node } from "./nodes/p002Node";
import { p003Node } from "./nodes/p003Node";
import { persistenceNode } from "./nodes/persistenceNode";

// ─── Default State Values ────────────────────────────────────────────────────

function defaultCompanyContext(): CompanyContext {
  return {
    id: "",
    name: "",
    ticker: "",
    industryGroup: "",
  };
}

function defaultValidationFlags(): ValidationFlags {
  return {
    p001: { isValid: false, errors: [], warnings: [] },
    p002: { isValid: false, errors: [], warnings: [] },
    p003: { isValid: false, errors: [], warnings: [] },
  };
}

// ─── State Annotation ─────────────────────────────────────────────────────────
//
// Each field declares:
//   default  – factory function for the initial value
//   reducer  – how node return values are merged into the current state
//
// Reducers follow the pattern:
//   REPLACE:  (_current, update) => update     (primitives, objects)
//   APPEND:   (current, update) => [...current, ...update]   (arrays)

const AgentStateAnnotation = Annotation.Root({
  // ── Identity ───────────────────────────────────────────────────────────────
  companyContext: Annotation<CompanyContext>({
    reducer: (_current: CompanyContext, update: CompanyContext): CompanyContext =>
      update,
    default: defaultCompanyContext,
  }),

  reportingYear: Annotation<number>({
    reducer: (_current: number, update: number): number => update,
    default: (): number => 0,
  }),

  // ── Input ──────────────────────────────────────────────────────────────────
  rawInputData: Annotation<RawInputData>({
    reducer: (_current: RawInputData, update: RawInputData): RawInputData =>
      update,
    default: (): RawInputData => ({}),
  }),

  // ── Validation ─────────────────────────────────────────────────────────────
  validationFlags: Annotation<ValidationFlags>({
    reducer: (
      _current: ValidationFlags,
      update: ValidationFlags,
    ): ValidationFlags => update,
    default: defaultValidationFlags,
  }),

  // ── Scores (append) ────────────────────────────────────────────────────────
  accumulatedScores: Annotation<PrimerScore[]>({
    reducer: (
      current: PrimerScore[],
      update: PrimerScore[],
    ): PrimerScore[] => [...current, ...update],
    default: (): PrimerScore[] => [],
  }),

  // ── Traces (append) ────────────────────────────────────────────────────────
  executionTraces: Annotation<ExecutionTrace[]>({
    reducer: (
      current: ExecutionTrace[],
      update: ExecutionTrace[],
    ): ExecutionTrace[] => [...current, ...update],
    default: (): ExecutionTrace[] => [],
  }),

  // ── Errors (append) ────────────────────────────────────────────────────────
  errors: Annotation<string[]>({
    reducer: (current: string[], update: string[]): string[] => [
      ...current,
      ...update,
    ],
    default: (): string[] => [],
  }),

  // ── Terminal flag ──────────────────────────────────────────────────────────
  processingComplete: Annotation<boolean>({
    reducer: (_current: boolean, update: boolean): boolean => update,
    default: (): boolean => false,
  }),
});

// Expose the inferred state type so nodes can be typed against it.
export type AgentStateAnnotationType = typeof AgentStateAnnotation.State;

// ─── Routing Functions ────────────────────────────────────────────────────────

/**
 * Determines whether to continue scoring or abort after validation.
 *
 * The pipeline proceeds to p001Processing if AT LEAST ONE primer produced
 * valid input — individual nodes self-guard via their own isValid checks.
 * Only when all three primers fail does the graph route to END.
 */
function routeAfterValidation(
  state: AgentStateAnnotationType,
): "p001Processing" | typeof END {
  const { p001, p002, p003 } = state.validationFlags;

  if (!p001.isValid && !p002.isValid && !p003.isValid) {
    console.error(
      "[graph] ALL three primers failed validation. Aborting pipeline.",
    );
    return END;
  }

  return "p001Processing";
}

// ─── Graph Construction ───────────────────────────────────────────────────────

/**
 * Builds and compiles the ESG scoring StateGraph.
 *
 * The compiled graph is a callable async function:
 *   await compiledGraph.invoke(initialState)
 *
 * Return type is intentionally inferred by TypeScript — the LangGraph generic
 * chain is too deep to annotate manually without fighting exactOptionalPropertyTypes.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function buildEsgGraph() {
  const graph = new StateGraph(AgentStateAnnotation)
    // ── Node registrations ─────────────────────────────────────────────────
    .addNode("validation", validationNode)
    .addNode("p001Processing", p001Node)
    .addNode("p002Processing", p002Node)
    .addNode("p003Processing", p003Node)
    .addNode("persistence", persistenceNode)

    // ── Entry edge ─────────────────────────────────────────────────────────
    .addEdge(START, "validation")

    // ── Conditional routing after validation ──────────────────────────────
    .addConditionalEdges("validation", routeAfterValidation, {
      p001Processing: "p001Processing",
      [END]: END,
    })

    // ── Sequential primer processing chain ─────────────────────────────────
    .addEdge("p001Processing", "p002Processing")
    .addEdge("p002Processing", "p003Processing")
    .addEdge("p003Processing", "persistence")

    // ── Optional: Parallel (fan-out) variant example (commented) ───────────
    // If you prefer to run primer nodes in parallel, LangGraph's Send/Receive
    // primitives can be used to fan-out and then join results. The example
    // below is intentionally commented out; it demonstrates the topology
    // but is not activated by default to preserve deterministic traces.
    /*
    .addEdge("p001Processing", "persistence")
    .addEdge("p002Processing", "persistence")
    .addEdge("p003Processing", "persistence")
    // Alternatively, use a dedicated join node that waits for all three
    // primers and then forwards to persistence. This requires explicit
    // coordination and is more complex but improves throughput for I/O
    // bound primers like P-003.
    */

    // ── Terminal edge ──────────────────────────────────────────────────────
    .addEdge("persistence", END);

  return graph.compile();
}

// ─── Compiled Graph Singleton ─────────────────────────────────────────────────

export const esgGraph = buildEsgGraph();

// ─── Public Pipeline Runner ───────────────────────────────────────────────────

/**
 * Top-level entry point consumed by the tRPC router (Phase 2) and CLI.
 *
 * 1. Fetches the company record from the DB to build CompanyContext.
 * 2. Assembles the initial AgentState.
 * 3. Invokes the compiled graph.
 * 4. Returns a PipelineRunResult summary.
 *
 * @param request  Caller-supplied pipeline parameters.
 */
export async function runEsgPipeline(
  request: PipelineRunRequest,
): Promise<PipelineRunResult> {
  const { db } = await import("../db/index");
  const { companies } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");

  // ── Resolve company record ────────────────────────────────────────────────
  const companyRows = await db
    .select()
    .from(companies)
    .where(eq(companies.id, request.companyId))
    .limit(1);

  if (companyRows.length === 0) {
    throw new Error(
      `[runEsgPipeline] Company with id "${request.companyId}" not found.`,
    );
  }

  const company = companyRows[0];

  if (!company) {
    throw new Error(
      `[runEsgPipeline] Company row is undefined for id "${request.companyId}".`,
    );
  }

  const companyContext: CompanyContext = {
    id: company.id,
    name: company.name,
    ticker: company.ticker,
    industryGroup: company.industryGroup,
  };

  // ── Build initial state ───────────────────────────────────────────────────
  const initialState: AgentState = {
    companyContext,
    reportingYear: request.reportingYear,
    rawInputData: request.rawInputData,
    validationFlags: {
      p001: { isValid: false, errors: [], warnings: [] },
      p002: { isValid: false, errors: [], warnings: [] },
      p003: { isValid: false, errors: [], warnings: [] },
    },
    accumulatedScores: [],
    executionTraces: [],
    errors: [],
    processingComplete: false,
  };

  console.info(
    `[runEsgPipeline] Starting pipeline — company: ${companyContext.name} (${companyContext.ticker}), ` +
    `year: ${String(request.reportingYear)}, ` +
    `primers requested: ${[
      request.rawInputData.p001 ? "P-001" : null,
      request.rawInputData.p002 ? "P-002" : null,
      request.rawInputData.p003 ? "P-003" : null,
    ]
      .filter(Boolean)
      .join(", ")}`,
  );

  const pipelineStartMs = Date.now();

  // ── Invoke the compiled graph ─────────────────────────────────────────────
  // Cast initialState through unknown: LangGraph's invoke signature accepts
  // the annotated state type at runtime but its TS overloads require Command<>.
  const finalState = (await esgGraph.invoke(
    initialState as unknown as Parameters<typeof esgGraph.invoke>[0],
  )) as AgentStateAnnotationType;

  const pipelineDurationMs = Date.now() - pipelineStartMs;

  console.info(
    `[runEsgPipeline] Pipeline complete — ` +
    `${String(finalState.accumulatedScores.length)} scores, ` +
    `${String(finalState.errors.length)} errors, ` +
    `${String(finalState.executionTraces.length)} traces, ` +
    `total: ${String(pipelineDurationMs)}ms`,
  );

  return {
    companyId: companyContext.id,
    reportingYear: request.reportingYear,
    scores: finalState.accumulatedScores,
    processingComplete: finalState.processingComplete,
    errors: finalState.errors,
    executionTraces: finalState.executionTraces,
  };
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────────
// Only runs when this file is executed directly: `tsx src/agents/graph.ts`

async function main(): Promise<void> {
  const { getAuroraEnergyFixture2023, AURORA_ENERGY_ID } = await import(
    "../db/seed"
  );

  const fixture = getAuroraEnergyFixture2023();

  const request: PipelineRunRequest = {
    companyId: AURORA_ENERGY_ID,
    reportingYear: fixture.reportingYear,
    rawInputData: {
      p001: fixture.p001Input,
      p002: fixture.p002Input,
      p003: fixture.p003Input,
    },
  };

  console.info(
    "=".repeat(60) + "\n" +
    "  Aurora Energy ESG Pipeline — CLI Run\n" +
    "=".repeat(60),
  );

  const result = await runEsgPipeline(request);

  console.info("\n" + "=".repeat(60));
  console.info("PIPELINE RESULT SUMMARY");
  console.info("=".repeat(60));
  console.info(`Company ID    : ${result.companyId}`);
  console.info(`Reporting Year: ${String(result.reportingYear)}`);
  console.info(`Complete      : ${String(result.processingComplete)}`);
  console.info(`Errors        : ${String(result.errors.length)}`);

  if (result.errors.length > 0) {
    result.errors.forEach((e) => console.error(`  ✗ ${e}`));
  }

  console.info("\nSCORES:");
  for (const score of result.scores) {
    console.info(
      `  ${score.primerCode}  score: ${score.scoreValue.toFixed(2)} / 100  ` +
      `confidence: ${(score.confidenceScore * 100).toFixed(1)}%`,
    );
  }

  console.info("\nEXECUTION TRACES:");
  for (const trace of result.executionTraces) {
    console.info(
      `  [${trace.nodeName.padEnd(20)}] ${String(trace.executionDurationMs).padStart(6)}ms` +
      (trace.llmModelUsed ? `  llm: ${trace.llmModelUsed}` : ""),
    );
  }

  console.info("=".repeat(60));
}

// Detect direct execution without crashing on import
const isDirectRun = require.main === module;
if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error("[graph CLI] Fatal:", err);
    process.exit(1);
  });
}
