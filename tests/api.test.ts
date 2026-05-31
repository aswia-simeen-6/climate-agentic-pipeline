/**
 * tests/api.test.ts
 *
 * Unit tests for all four tRPC primer router procedures.
 *
 * Strategy:
 *   - db.select() returns a fresh chain per call; both `limit` and `orderBy`
 *     are terminal methods that resolve the next item from `selectQueue`.
 *     This handles both limit-terminated and orderBy-terminated queries.
 *   - runEsgPipeline is mocked to return a deterministic result.
 *   - Procedures are called via appRouter.createCaller(ctx) — no HTTP server.
 *
 * Test coverage:
 *   submitData   — success, company not found, pipeline error, Zod rejection
 *   getScore     — success with trace, null trace, primer not found, score not found
 *   listScores   — three primers (E/S/G pillars), empty, company not found, category split
 *   getAgentTrace — success, not found, llmModelUsed from p003
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Context } from "../src/api/context";
import type { Database } from "../src/db/index";
import type { PipelineRunResult } from "../src/types/index";

// ─── Hoist ALL variables referenced in vi.mock() factories ───────────────────
// vi.mock() calls are hoisted to the top of the file; any variable they close
// over must also be hoisted via vi.hoisted() so it's initialised in time.

const { mockRunEsgPipeline, mockDb } = vi.hoisted(() => {
  const mockRunEsgPipeline = vi.fn<() => Promise<PipelineRunResult>>();

  // select() is configured in the global beforeEach via the selectQueue helper.
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
    transaction: vi.fn(),
  };

  return { mockRunEsgPipeline, mockDb };
});

vi.mock("../src/agents/graph", () => ({ runEsgPipeline: mockRunEsgPipeline }));
vi.mock("../src/db/index",     () => ({ db: mockDb, pool: { end: vi.fn() } }));

// ─── Import router after mocks are registered ─────────────────────────────────

import { appRouter } from "../src/api/index";

// ─── Queue-based select helper ────────────────────────────────────────────────
// Each db.select() call pops the next result from the queue.
//
// The chain is made THENABLE so that `await chain` works for orderBy-terminated
// queries (listScores has no .limit() call). `orderBy` returns `this` so that
// `.orderBy(...).limit(1)` also works (primerData query in getScore).

const selectQueue: unknown[][] = [];

function makeSelectChain() {
  const result: unknown[] = selectQueue.shift() ?? [];
  const resultPromise = Promise.resolve(result);

  const chain = {
    from:      vi.fn().mockReturnThis(),
    where:     vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    // orderBy returns `this` so `.orderBy().limit()` chains work.
    orderBy:   vi.fn().mockReturnThis(),
    // limit is the terminal call that produces the resolved rows.
    limit:     vi.fn().mockReturnValue(resultPromise),
    // `then` makes the whole chain awaitable when there is no .limit() call.
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resultPromise.then(resolve, reject),
  };
  return chain;
}

// Global lifecycle: reset queue and re-wire mockDb.select before every test.
beforeEach(() => {
  selectQueue.length = 0;
  mockDb.select.mockImplementation(makeSelectChain);
});

afterEach(() => {
  vi.clearAllMocks();
  // Re-wire after clearAllMocks so subsequent tests start with a fresh mock.
  mockDb.select.mockImplementation(makeSelectChain);
});

// ─── Context factory ──────────────────────────────────────────────────────────

function makeCtx(): Context {
  return {
    db: mockDb as unknown as Database,
    // Must be a valid UUID — used in SubmitDataOutputSchema.requestId
    requestId: "11111111-0000-0000-0000-000000000099",
  };
}

// ─── Fixtures (all IDs use valid UUID format) ─────────────────────────────────

const COMPANY_ID      = "00000000-0000-0000-0000-000000000001";
const COMPANY_MISSING = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const REPORTING_YEAR  = 2023;

const PRIMER_P001_ID = "10000000-0000-0000-0000-000000000001";
const PRIMER_P002_ID = "10000000-0000-0000-0000-000000000002";
const PRIMER_P003_ID = "10000000-0000-0000-0000-000000000003";
const SCORE_ID       = "20000000-0000-0000-0000-000000000001";
const PRIMER_DATA_ID = "30000000-0000-0000-0000-000000000001";
const TRACE_ID       = "40000000-0000-0000-0000-000000000001";

const mockCompanyRow = {
  id: COMPANY_ID,
  name: "Aurora Energy Inc.",
  ticker: "AUR.TO",
  industryGroup: "Energy",
  createdAt: new Date("2024-01-01"),
};

const mockPrimerP001 = { id: PRIMER_P001_ID, code: "P-001", name: "Scope 1 CO₂ Emissions", category: "E",  dataType: "QUANTITATIVE", validationRules: null };
const mockPrimerP002 = { id: PRIMER_P002_ID, code: "P-002", name: "Board Gender Diversity",  category: "G",  dataType: "QUANTITATIVE", validationRules: null };
const mockPrimerP003 = { id: PRIMER_P003_ID, code: "P-003", name: "Supply Chain Labor Risk", category: "S",  dataType: "HYBRID",       validationRules: null };

const mockScoreRow = {
  id: SCORE_ID,
  companyId: COMPANY_ID,
  primerId: PRIMER_P001_ID,
  reportingYear: REPORTING_YEAR,
  scoreValue: "56.98",
  percentileRank: null as null,
  methodologyVersion: "v1.0.0",
  computedAt: new Date("2024-03-15"),
};

const mockPrimerDataRow = {
  id: PRIMER_DATA_ID,
  companyId: COMPANY_ID,
  primerId: PRIMER_P001_ID,
  reportingYear: REPORTING_YEAR,
  rawValue: { intensityRatio: 45.0 },
  normalizedValue: "0.56977",
  confidenceScore: "1.0000",
  agentTraceId: TRACE_ID,
  createdAt: new Date("2024-03-15"),
};

const mockAgentTraceRow = {
  id: TRACE_ID,
  agentName: "p001Processing",
  inputSnapshot: { companyId: COMPANY_ID },
  outputSnapshot: { scoreValue: 56.98 },
  executionDurationMs: 12,
  llmModelUsed: null as null,
  createdAt: new Date("2024-03-15"),
};

const mockPipelineResult: PipelineRunResult = {
  companyId: COMPANY_ID,
  reportingYear: REPORTING_YEAR,
  scores: [
    {
      primerId: PRIMER_P001_ID,
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
        rawScore: 56.98,
      },
    },
  ],
  processingComplete: true,
  errors: [],
  executionTraces: [
    {
      id: TRACE_ID,
      nodeName: "p001Processing",
      startTimeMs: 1_700_000_000_000,
      endTimeMs:   1_700_000_000_012,
      executionDurationMs: 12,
      inputSnapshot: {},
      outputSnapshot: {},
    },
  ],
};

// ═════════════════════════════════════════════════════════════════════════════
// primer.submitData
// ═════════════════════════════════════════════════════════════════════════════

describe("primer.submitData", () => {
  beforeEach(() => {
    mockRunEsgPipeline.mockResolvedValue(mockPipelineResult);
  });

  it("returns a score summary and executionSummary on success", async () => {
    selectQueue.push([mockCompanyRow]);

    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.primer.submitData({
      companyId: COMPANY_ID,
      reportingYear: REPORTING_YEAR,
      rawInputData: { p001: { scope1Emissions: 38_250, revenueMillions: 850 } },
    });

    expect(result.processingComplete).toBe(true);
    expect(result.scores).toHaveLength(1);
    expect(result.scores[0]?.primerCode).toBe("P-001");
    expect(result.scores[0]?.scoreValue).toBeCloseTo(56.98, 2);
    expect(result.errors).toHaveLength(0);
    expect(result.requestId).toBe("11111111-0000-0000-0000-000000000099");
    expect(result.executionSummary).toHaveLength(1);
    expect(result.executionSummary[0]?.traceId).toBe(TRACE_ID);
  });

  it("throws NOT_FOUND when the company does not exist", async () => {
    selectQueue.push([]); // empty company row

    const caller = appRouter.createCaller(makeCtx());
    await expect(
      caller.primer.submitData({
        companyId: COMPANY_MISSING,
        reportingYear: REPORTING_YEAR,
        rawInputData: { p001: { scope1Emissions: 38_250, revenueMillions: 850 } },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws INTERNAL_SERVER_ERROR when the pipeline throws", async () => {
    selectQueue.push([mockCompanyRow]);
    mockRunEsgPipeline.mockRejectedValueOnce(new Error("DB connection lost"));

    const caller = appRouter.createCaller(makeCtx());
    await expect(
      caller.primer.submitData({
        companyId: COMPANY_ID,
        reportingYear: REPORTING_YEAR,
        rawInputData: { p001: { scope1Emissions: 38_250, revenueMillions: 850 } },
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("rejects with BAD_REQUEST when rawInputData has no primer fields", async () => {
    const caller = appRouter.createCaller(makeCtx());
    await expect(
      caller.primer.submitData({
        companyId: COMPANY_ID,
        reportingYear: REPORTING_YEAR,
        rawInputData: {} as never,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// primer.getScore
// ═════════════════════════════════════════════════════════════════════════════

describe("primer.getScore", () => {
  it("returns score detail and agent trace on success", async () => {
    // Query order: primers → scores → primer_data → agent_traces
    selectQueue.push([mockPrimerP001]);
    selectQueue.push([mockScoreRow]);
    selectQueue.push([mockPrimerDataRow]);
    selectQueue.push([mockAgentTraceRow]);

    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.primer.getScore({
      companyId: COMPANY_ID,
      primerCode: "P-001",
      reportingYear: REPORTING_YEAR,
    });

    expect(result.score.primerCode).toBe("P-001");
    expect(result.score.scoreValue).toBeCloseTo(56.98, 2);
    expect(result.score.category).toBe("E");
    expect(result.score.confidenceScore).toBeCloseTo(1.0, 2);
    expect(result.agentTrace).not.toBeNull();
    expect(result.agentTrace?.agentName).toBe("p001Processing");
    expect(result.agentTrace?.executionDurationMs).toBe(12);
  });

  it("returns null agentTrace when primer_data has no agentTraceId", async () => {
    selectQueue.push([mockPrimerP001]);
    selectQueue.push([mockScoreRow]);
    selectQueue.push([{ ...mockPrimerDataRow, agentTraceId: null }]);

    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.primer.getScore({
      companyId: COMPANY_ID,
      primerCode: "P-001",
      reportingYear: REPORTING_YEAR,
    });

    expect(result.agentTrace).toBeNull();
  });

  it("throws NOT_FOUND when primer code is unknown", async () => {
    selectQueue.push([]); // primers lookup empty

    const caller = appRouter.createCaller(makeCtx());
    await expect(
      caller.primer.getScore({
        companyId: COMPANY_ID,
        primerCode: "P-001",
        reportingYear: REPORTING_YEAR,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws NOT_FOUND when no score exists for the given parameters", async () => {
    selectQueue.push([mockPrimerP001]); // primer found
    selectQueue.push([]);               // score not found

    const caller = appRouter.createCaller(makeCtx());
    await expect(
      caller.primer.getScore({
        companyId: COMPANY_ID,
        primerCode: "P-001",
        reportingYear: 2022,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// primer.listScores
// ═════════════════════════════════════════════════════════════════════════════

describe("primer.listScores", () => {
  it("returns all three scores with correct E/S/G pillar averages", async () => {
    // The router calls .select({ score: scores, primer: primers }).innerJoin(...).orderBy(...)
    // Drizzle returns rows shaped as { score: ..., primer: ... }
    const joinedRows = [
      { score: { ...mockScoreRow, id: "20000000-0000-0000-0000-000000000001", primerId: PRIMER_P001_ID, scoreValue: "56.98" }, primer: mockPrimerP001 },
      { score: { ...mockScoreRow, id: "20000000-0000-0000-0000-000000000002", primerId: PRIMER_P002_ID, scoreValue: "61.54" }, primer: mockPrimerP002 },
      { score: { ...mockScoreRow, id: "20000000-0000-0000-0000-000000000003", primerId: PRIMER_P003_ID, scoreValue: "71.60" }, primer: mockPrimerP003 },
    ];

    selectQueue.push([mockCompanyRow]); // company check (.limit)
    selectQueue.push(joinedRows);       // scores join (.orderBy)

    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.primer.listScores({
      companyId: COMPANY_ID,
      reportingYear: REPORTING_YEAR,
    });

    expect(result.scoreCount).toBe(3);
    expect(result.scores).toHaveLength(3);
    expect(result.pillars.environmental.averageScore).toBeCloseTo(56.98, 2);
    expect(result.pillars.governance.averageScore).toBeCloseTo(61.54, 2);
    expect(result.pillars.social.averageScore).toBeCloseTo(71.60, 2);
    expect(result.pillars.composite.averageScore).toBeCloseTo(
      (56.98 + 61.54 + 71.60) / 3,
      1,
    );
  });

  it("returns empty scores array and null averages when no scores exist", async () => {
    selectQueue.push([mockCompanyRow]);
    selectQueue.push([]);

    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.primer.listScores({
      companyId: COMPANY_ID,
      reportingYear: 2022,
    });

    expect(result.scoreCount).toBe(0);
    expect(result.scores).toHaveLength(0);
    expect(result.pillars.environmental.averageScore).toBeNull();
    expect(result.pillars.composite.averageScore).toBeNull();
  });

  it("throws NOT_FOUND when company does not exist", async () => {
    selectQueue.push([]); // company check returns empty

    const caller = appRouter.createCaller(makeCtx());
    await expect(
      caller.primer.listScores({
        companyId: COMPANY_MISSING,
        reportingYear: REPORTING_YEAR,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("correctly assigns E/S/G categories to separate pillar groups", async () => {
    const joinedRows = [
      { score: { ...mockScoreRow, id: "20000000-0000-0000-0000-000000000001", scoreValue: "80.00" }, primer: mockPrimerP001 }, // E
      { score: { ...mockScoreRow, id: "20000000-0000-0000-0000-000000000003", primerId: PRIMER_P003_ID, scoreValue: "60.00" }, primer: mockPrimerP003 }, // S
    ];

    selectQueue.push([mockCompanyRow]);
    selectQueue.push(joinedRows);

    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.primer.listScores({
      companyId: COMPANY_ID,
      reportingYear: REPORTING_YEAR,
    });

    expect(result.pillars.environmental.averageScore).toBeCloseTo(80.0, 2);
    expect(result.pillars.social.averageScore).toBeCloseTo(60.0, 2);
    expect(result.pillars.governance.averageScore).toBeNull();
    expect(result.pillars.governance.primerCount).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// primer.getAgentTrace
// ═════════════════════════════════════════════════════════════════════════════

describe("primer.getAgentTrace", () => {
  it("returns the full trace including input/output snapshots", async () => {
    selectQueue.push([mockAgentTraceRow]);

    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.primer.getAgentTrace({ traceId: TRACE_ID });

    expect(result.id).toBe(TRACE_ID);
    expect(result.agentName).toBe("p001Processing");
    expect(result.executionDurationMs).toBe(12);
    expect(result.llmModelUsed).toBeNull();
    expect(result.inputSnapshot).toMatchObject({ companyId: COMPANY_ID });
    expect(result.outputSnapshot).toMatchObject({ scoreValue: 56.98 });
  });

  it("throws NOT_FOUND when trace ID does not exist", async () => {
    selectQueue.push([]);

    const caller = appRouter.createCaller(makeCtx());
    await expect(
      caller.primer.getAgentTrace({ traceId: COMPANY_MISSING }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns llmModelUsed when the trace originates from p003Node", async () => {
    selectQueue.push([
      {
        ...mockAgentTraceRow,
        id: TRACE_ID,
        agentName: "p003Processing",
        llmModelUsed: "claude-3-5-sonnet-20241022",
      },
    ]);

    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.primer.getAgentTrace({ traceId: TRACE_ID });

    expect(result.llmModelUsed).toBe("claude-3-5-sonnet-20241022");
    expect(result.agentName).toBe("p003Processing");
  });
});

