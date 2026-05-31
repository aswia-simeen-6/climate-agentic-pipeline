/**
 * tests/agents.test.ts
 *
 * Integration tests for the LangGraph agent nodes and the compiled StateGraph.
 *
 * Strategy:
 *   - Node-level tests call each node function directly with a constructed
 *     AgentState, asserting on the Partial<AgentState> returned.
 *     These tests require NO mocking (validation/p001/p002 nodes are pure).
 *
 *   - p003Node requires mocking @langchain/anthropic.
 *
 *   - persistenceNode requires mocking the Drizzle DB module.
 *
 *   - The full graph is tested via runEsgPipeline with both the LLM and DB
 *     mocked, verifying end-to-end state accumulation.
 *
 * Mocking approach:
 *   vi.mock() calls are hoisted to the top of the module by Vitest and
 *   intercept both static imports and dynamic `await import(...)` calls.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import type { AgentState, PrimerScore } from "../src/types/index";

// ─── Hoist ALL variables that are referenced inside vi.mock() factories ───────
// vi.hoisted() is evaluated BEFORE vi.mock() factories AND before module-level
// variable declarations, so anything needed in a factory must live here.

const {
  mockLlmInvoke,
  mockDb,
  mockTransactionFn,
  mockDbSelectChain,
} = vi.hoisted(() => {
  const mockLlmInvoke = vi.fn();
  const mockTransactionFn = vi.fn();

  const mockDbSelectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(),
  };

  const mockDb = {
    select: vi.fn().mockReturnValue(mockDbSelectChain),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue([]),
    }),
    execute: vi.fn().mockResolvedValue({ rows: [{ cnt: "1" }] }),
    transaction: mockTransactionFn,
  };

  return { mockLlmInvoke, mockDb, mockTransactionFn, mockDbSelectChain };
});

vi.mock("@langchain/anthropic", () => ({
  ChatAnthropic: vi.fn().mockImplementation(() => ({
    withStructuredOutput: vi.fn().mockReturnValue({ invoke: mockLlmInvoke }),
  })),
}));

vi.mock("../src/db/index", () => ({
  db: mockDb,
  pool: { end: vi.fn() },
}));

// ─── Source imports (after mocks are registered) ──────────────────────────────

import { validationNode } from "../src/agents/nodes/validationNode";
import { p001Node } from "../src/agents/nodes/p001Node";
import { p002Node } from "../src/agents/nodes/p002Node";
import { p003Node } from "../src/agents/nodes/p003Node";
import { persistenceNode } from "../src/agents/nodes/persistenceNode";

// ─── State Factory ────────────────────────────────────────────────────────────

function makeValidatedState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    companyContext: {
      id: "00000000-0000-0000-0000-000000000001",
      name: "Aurora Energy Inc.",
      ticker: "AUR.TO",
      industryGroup: "Energy — Oil, Gas & Consumable Fuels",
    },
    reportingYear: 2023,
    rawInputData: {
      p001: { scope1Emissions: 38_250, revenueMillions: 850 },
      p002: { boardSize: 13, femaleDirectors: 4 },
      p003: {
        auditedSuppliersRatio: 0.72,
        codeOfConductCoverage: 0.88,
        documentedPoliciesScore: 0.65,
        grievanceMechanismScore: 0.80,
        incidentCount: 2,
        supplyChainNarrative: "Aurora completed third-party audits for 72% of suppliers.",
      },
    },
    validationFlags: {
      p001: { isValid: true, errors: [], warnings: [] },
      p002: { isValid: true, errors: [], warnings: [] },
      p003: { isValid: true, errors: [], warnings: [] },
    },
    accumulatedScores: [],
    executionTraces: [],
    errors: [],
    processingComplete: false,
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// validationNode
// ═════════════════════════════════════════════════════════════════════════════

describe("validationNode", () => {
  it("marks all three primers valid for the Aurora Energy fixture", async () => {
    const state = makeValidatedState();
    // Reset validationFlags so validationNode re-computes them
    state.validationFlags = {
      p001: { isValid: false, errors: [], warnings: [] },
      p002: { isValid: false, errors: [], warnings: [] },
      p003: { isValid: false, errors: [], warnings: [] },
    };

    const result = await validationNode(state);

    expect(result.validationFlags?.p001.isValid).toBe(true);
    expect(result.validationFlags?.p002.isValid).toBe(true);
    expect(result.validationFlags?.p003.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("marks P-001 invalid and adds an error message when input is absent", async () => {
    const state = makeValidatedState();
    state.rawInputData.p001 = undefined;
    state.validationFlags = {
      p001: { isValid: false, errors: [], warnings: [] },
      p002: { isValid: true, errors: [], warnings: [] },
      p003: { isValid: true, errors: [], warnings: [] },
    };

    const result = await validationNode(state);

    expect(result.validationFlags?.p001.isValid).toBe(false);
    expect(result.errors?.some((e) => e.includes("P-001"))).toBe(true);
  });

  it("marks all primers invalid when rawInputData is empty", async () => {
    const state = makeValidatedState({ rawInputData: {} });

    const result = await validationNode(state);

    expect(result.validationFlags?.p001.isValid).toBe(false);
    expect(result.validationFlags?.p002.isValid).toBe(false);
    expect(result.validationFlags?.p003.isValid).toBe(false);
    expect(result.errors).toHaveLength(3);
  });

  it("appends exactly one ExecutionTrace", async () => {
    const state = makeValidatedState();
    const result = await validationNode(state);
    expect(result.executionTraces).toHaveLength(1);
    expect(result.executionTraces?.[0]?.nodeName).toBe("validation");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// p001Node
// ═════════════════════════════════════════════════════════════════════════════

describe("p001Node", () => {
  it("produces a P-001 score for the Aurora Energy fixture", async () => {
    const state = makeValidatedState();
    const result = await p001Node(state);

    expect(result.accumulatedScores).toHaveLength(1);
    const score = result.accumulatedScores?.[0];
    expect(score?.primerCode).toBe("P-001");
    expect(score?.scoreValue).toBeCloseTo(56.98, 1);
    expect(score?.confidenceScore).toBe(1.0);
  });

  it("skips computation when P-001 validation flag is false", async () => {
    const state = makeValidatedState();
    state.validationFlags.p001 = {
      isValid: false,
      errors: ["Invalid emission value"],
      warnings: [],
    };

    const result = await p001Node(state);

    expect(result.accumulatedScores).toBeUndefined();
    expect(result.executionTraces?.[0]?.outputSnapshot).toMatchObject({ skipped: true });
  });

  it("appends exactly one ExecutionTrace", async () => {
    const state = makeValidatedState();
    const result = await p001Node(state);
    expect(result.executionTraces).toHaveLength(1);
    expect(result.executionTraces?.[0]?.nodeName).toBe("p001Processing");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// p002Node
// ═════════════════════════════════════════════════════════════════════════════

describe("p002Node", () => {
  it("produces a P-002 score for the Aurora Energy fixture", async () => {
    const state = makeValidatedState();
    const result = await p002Node(state);

    expect(result.accumulatedScores).toHaveLength(1);
    const score = result.accumulatedScores?.[0];
    expect(score?.primerCode).toBe("P-002");
    expect(score?.scoreValue).toBeCloseTo(61.54, 1);
  });

  it("skips computation when P-002 validation flag is false", async () => {
    const state = makeValidatedState();
    state.validationFlags.p002 = {
      isValid: false,
      errors: ["Invalid board size"],
      warnings: [],
    };

    const result = await p002Node(state);
    expect(result.accumulatedScores).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// p003Node (requires LLM mock)
// ═════════════════════════════════════════════════════════════════════════════

describe("p003Node", () => {
  beforeEach(() => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";
    mockLlmInvoke.mockResolvedValue({
      qualitativeAdjustment: 5.0,
      rationale:
        "The company demonstrates credible third-party audit coverage and a responsive grievance hotline.",
      riskLevel: "LOW",
      keyFindings: [
        "72% of tier-1 suppliers underwent third-party labor audits.",
        "Grievance hotline maintains a 14-day SLA.",
      ],
    });
  });

  afterEach(() => {
    delete process.env["ANTHROPIC_API_KEY"];
    vi.clearAllMocks();
  });

  it("produces a P-003 score with LLM adjustment applied", async () => {
    const state = makeValidatedState();
    const result = await p003Node(state);

    expect(result.accumulatedScores).toHaveLength(1);
    const score = result.accumulatedScores?.[0];
    expect(score?.primerCode).toBe("P-003");
    // base ≈ 66.6 + 5.0 (LLM adj) = 71.6
    expect(score?.scoreValue).toBeCloseTo(71.6, 1);
  });

  it("sets the LLM model in the execution trace", async () => {
    const state = makeValidatedState();
    const result = await p003Node(state);

    const trace = result.executionTraces?.[0];
    expect(trace?.llmModelUsed).toBeDefined();
  });

  it("falls back to base score with reduced confidence when LLM call throws", async () => {
    mockLlmInvoke.mockRejectedValueOnce(new Error("LLM API timeout"));
    const state = makeValidatedState();
    const result = await p003Node(state);

    const score = result.accumulatedScores?.[0];
    // Score should equal base score (66.6) since LLM failed
    expect(score?.scoreValue).toBeCloseTo(66.6, 1);
    expect(score?.confidenceScore).toBeCloseTo(0.75, 2);
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it("skips when P-003 validation flag is false", async () => {
    const state = makeValidatedState();
    state.validationFlags.p003 = {
      isValid: false,
      errors: ["Invalid ratio"],
      warnings: [],
    };

    const result = await p003Node(state);
    expect(result.accumulatedScores).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// persistenceNode (requires DB mock)
// ═════════════════════════════════════════════════════════════════════════════

describe("persistenceNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Build a fresh insert mock that handles both:
    //   tx.insert(x).values(y)                       → plain insert (traces, primerData)
    //   tx.insert(x).values(y).onConflictDoUpdate(z)  → score upsert
    const mockInsertChain = {
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate:   vi.fn().mockResolvedValue([]),
        onConflictDoNothing:  vi.fn().mockResolvedValue([]),
        // Awaiting the values() result directly also works:
        then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
      }),
    };

    mockTransactionFn.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const mockTx = { insert: vi.fn().mockReturnValue(mockInsertChain) };
      await fn(mockTx);
    });

    // Post-transaction own trace insert uses mockDb.insert directly.
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockResolvedValue([]),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sets processingComplete to true on successful write", async () => {
    const mockScore: PrimerScore = {
      primerId: "10000000-0000-0000-0000-000000000001",
      primerCode: "P-001",
      scoreValue: 56.98,
      normalizedValue: 0.5698,
      confidenceScore: 1.0,
      methodologyVersion: "v1.0.0",
      computationDetail: {
        primerCode: "P-001",
        intensityRatio: 45.0,
        peerBenchmarkIntensity: 52.3,
        deviationFromBenchmarkPct: -13.96,
        rawScore: 56.9789,
      },
    };

    const state: AgentState = {
      ...makeValidatedState(),
      accumulatedScores: [mockScore],
      executionTraces: [
        {
          id: "aaaaaaaa-0000-0000-0000-000000000001",
          nodeName: "p001Processing",
          startTimeMs: Date.now() - 10,
          endTimeMs: Date.now(),
          executionDurationMs: 10,
          inputSnapshot: {},
          outputSnapshot: {},
        },
      ],
    };

    const result = await persistenceNode(state);

    expect(result.processingComplete).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("sets processingComplete to false when no scores are available", async () => {
    const state = makeValidatedState();

    const result = await persistenceNode(state);

    expect(result.processingComplete).toBe(false);
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it("appends an ExecutionTrace for the persistence node itself", async () => {
    const mockScore: PrimerScore = {
      primerId: "10000000-0000-0000-0000-000000000001",
      primerCode: "P-001",
      scoreValue: 56.98,
      normalizedValue: 0.5698,
      confidenceScore: 1.0,
      methodologyVersion: "v1.0.0",
      computationDetail: {
        primerCode: "P-001",
        intensityRatio: 45.0,
        peerBenchmarkIntensity: 52.3,
        deviationFromBenchmarkPct: -13.96,
        rawScore: 56.9789,
      },
    };

    const state: AgentState = {
      ...makeValidatedState(),
      accumulatedScores: [mockScore],
      executionTraces: [],
    };

    const result = await persistenceNode(state);
    expect(result.executionTraces).toHaveLength(1);
    expect(result.executionTraces?.[0]?.nodeName).toBe("persistence");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Full Graph — runEsgPipeline (end-to-end with all mocks active)
// ═════════════════════════════════════════════════════════════════════════════

describe("runEsgPipeline (end-to-end)", () => {
  beforeEach(() => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key";

    // Company lookup in runEsgPipeline
    mockDbSelectChain.limit.mockResolvedValue([
      {
        id: "00000000-0000-0000-0000-000000000001",
        name: "Aurora Energy Inc.",
        ticker: "AUR.TO",
        industryGroup: "Energy — Oil, Gas & Consumable Fuels",
        createdAt: new Date(),
      },
    ]);

    mockTransactionFn.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const valuesResult = {
        onConflictDoUpdate:  vi.fn().mockResolvedValue([]),
        onConflictDoNothing: vi.fn().mockResolvedValue([]),
        // Make the values() result directly awaitable (plain insert without conflict handler)
        then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
      };
      const mockTx = {
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue(valuesResult) }),
      };
      await fn(mockTx);
    });

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockResolvedValue([]),
    });

    mockLlmInvoke.mockResolvedValue({
      qualitativeAdjustment: 5.0,
      rationale: "Strong audit coverage and responsive grievance mechanisms.",
      riskLevel: "LOW",
      keyFindings: ["72% supplier audit coverage.", "14-day grievance SLA."],
    });
  });

  afterEach(() => {
    delete process.env["ANTHROPIC_API_KEY"];
    vi.clearAllMocks();
  });

  it("produces three scores for all valid inputs", async () => {
    const { runEsgPipeline } = await import("../src/agents/graph");

    const result = await runEsgPipeline({
      companyId: "00000000-0000-0000-0000-000000000001",
      reportingYear: 2023,
      rawInputData: {
        p001: { scope1Emissions: 38_250, revenueMillions: 850 },
        p002: { boardSize: 13, femaleDirectors: 4 },
        p003: {
          auditedSuppliersRatio: 0.72,
          codeOfConductCoverage: 0.88,
          documentedPoliciesScore: 0.65,
          grievanceMechanismScore: 0.80,
          incidentCount: 2,
          supplyChainNarrative: "Aurora completed third-party audits for 72% of suppliers.",
        },
      },
    });

    expect(result.scores).toHaveLength(3);
    expect(result.processingComplete).toBe(true);
    expect(result.errors).toHaveLength(0);

    const p001 = result.scores.find((s) => s.primerCode === "P-001");
    const p002 = result.scores.find((s) => s.primerCode === "P-002");
    const p003 = result.scores.find((s) => s.primerCode === "P-003");

    expect(p001?.scoreValue).toBeCloseTo(56.98, 1);
    expect(p002?.scoreValue).toBeCloseTo(61.54, 1);
    expect(p003?.scoreValue).toBeCloseTo(71.6, 1); // base 66.6 + 5.0 LLM adj
  });

  it("produces two scores when only P-001 and P-002 inputs are provided", async () => {
    const { runEsgPipeline } = await import("../src/agents/graph");

    const result = await runEsgPipeline({
      companyId: "00000000-0000-0000-0000-000000000001",
      reportingYear: 2023,
      rawInputData: {
        p001: { scope1Emissions: 38_250, revenueMillions: 850 },
        p002: { boardSize: 13, femaleDirectors: 4 },
      },
    });

    expect(result.scores).toHaveLength(2);
    expect(result.scores.map((s) => s.primerCode).sort()).toEqual(["P-001", "P-002"]);
  });

  it("throws when the company is not found", async () => {
    mockDbSelectChain.limit.mockResolvedValueOnce([]);

    const { runEsgPipeline } = await import("../src/agents/graph");

    await expect(
      runEsgPipeline({
        companyId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        reportingYear: 2023,
        rawInputData: {
          p001: { scope1Emissions: 38_250, revenueMillions: 850 },
        },
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("execution traces include entries for all executed nodes", async () => {
    const { runEsgPipeline } = await import("../src/agents/graph");

    const result = await runEsgPipeline({
      companyId: "00000000-0000-0000-0000-000000000001",
      reportingYear: 2023,
      rawInputData: {
        p001: { scope1Emissions: 38_250, revenueMillions: 850 },
        p002: { boardSize: 13, femaleDirectors: 4 },
        p003: {
          auditedSuppliersRatio: 0.72,
          codeOfConductCoverage: 0.88,
          documentedPoliciesScore: 0.65,
          grievanceMechanismScore: 0.80,
          incidentCount: 2,
        },
      },
    });

    const nodeNames = result.executionTraces.map((t) => t.nodeName);
    expect(nodeNames).toContain("validation");
    expect(nodeNames).toContain("p001Processing");
    expect(nodeNames).toContain("p002Processing");
    expect(nodeNames).toContain("p003Processing");
    expect(nodeNames).toContain("persistence");
  });
});
