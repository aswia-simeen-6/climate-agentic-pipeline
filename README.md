# Aurora ESG Agentic Pipeline

**AA Impact Inc. Technical Evaluation — Agentic Backend Submission**

A production-quality ESG scoring pipeline built with **LangGraph v0.2**, **tRPC v11**, **Drizzle ORM** (PostgreSQL), and **TypeScript 5.5** strict mode. It evaluates three ESG material primers for Aurora Energy Inc. (TSX: AUR.TO) for the 2023 reporting year.

---

## Primers Evaluated

| Code | Name | ESG Category | Methodology |
|------|------|-------------|-------------|
| P-001 | Scope 1 CO₂ Emissions | Environmental (E) | Quantitative — intensity relative to TSX-60 peer benchmark |
| P-002 | Board Gender Diversity | Governance (G) | Quantitative — female director ratio vs. 50% parity target |
| P-003 | Supply Chain Labor Risk | Social (S) | Hybrid — weighted quantitative base + LLM qualitative adjustment (±20 pts) |

---

## Prerequisites

| Requirement | Minimum Version |
|------------|----------------|
| Node.js | **v20.0.0** |
| npm | v10+ |
| PostgreSQL | **v14+** |
| Anthropic API key | For P-003 LLM evaluation (not required in mock mode) |

---

## Quick Start

### ⚡ Fastest Path: Docker Compose (Recommended for Evaluators)

No need to install PostgreSQL separately. One command starts everything:

```bash
git clone <repo-url>
cd climate-agentic-pipeline
docker compose up
```

The app starts on `http://localhost:3000` once the database is ready. The compose file includes:
- **PostgreSQL 16** with auto-initialization
- **Node.js app** with schema migration and seeding on startup
- **`MOCK_LLM=true` by default** — no Anthropic key required for a full end-to-end demo
- Health checks to ensure DB readiness before the app accepts requests

To use a real Anthropic key instead of mock mode:

```bash
ANTHROPIC_API_KEY=sk-ant-... docker compose up
```

---

### Manual Installation (Local Development)

#### 1. Clone and install

```bash
git clone <repo-url>
cd climate-agentic-pipeline
npm ci
```

#### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```dotenv
DATABASE_URL=postgresql://postgres:password@localhost:5432/aurora_esg
ANTHROPIC_API_KEY=sk-ant-your-key-here
LLM_MODEL=claude-3-5-sonnet-20241022
PORT=3000
METHODOLOGY_VERSION=v1.0.0
P001_PEER_BENCHMARK_INTENSITY=52.3
P002_TSX60_AVERAGE_DIVERSITY=0.282
MOCK_LLM=false
```

#### 3. Set up the database

```bash
# Apply migrations (generates tables from the Drizzle schema)
npm run db:migrate

# Seed Aurora Energy Inc. and the three ESG primers
npm run db:seed
```

#### 4. Start the development server

```bash
npm run dev
```

The server listens on `http://localhost:3000`. Health endpoints:

- `GET /health` — liveness probe
- `GET /ready` — readiness probe (verifies DB connectivity)

---

## Mock LLM Mode (No Anthropic Key Required)

Set `MOCK_LLM=true` to run the full pipeline without any API calls. The P-003 node returns a hardcoded but realistic structured output:

```bash
# Option A: Docker Compose (default behaviour)
docker compose up

# Option B: inline env var
MOCK_LLM=true npm run dev

# Option C: set in .env
# MOCK_LLM=true
```

Mock output values:
- Qualitative adjustment: **+5.0 points**
- Risk level: **MEDIUM**
- Key findings: supplier audit coverage, Code of Conduct adoption, grievance mechanism gaps

All three primer scores are computed normally and written to the database. The pipeline is fully deterministic in mock mode — ideal for evaluators and CI.

---

## Async Queue & Worker (Optional)

For production-like workflows or high-throughput evaluation, the service can enqueue pipeline runs to a Redis-backed BullMQ queue and process them with a worker.

- To enable async enqueueing: set `ASYNC_JOB_QUEUE=true` and provide a `REDIS_URL` (e.g. `redis://redis:6379`).
- The repository includes a small worker prototype at `src/worker/queueWorker.ts` and a `npm run worker` script.

Docker Compose already includes a `worker` service and a Redis instance. To run everything (app + DB + Redis + worker):

```bash
docker compose up
```

When async queueing is enabled, `submitData` returns immediately with a `jobId` and the worker performs the pipeline in the background. Use `getAgentTrace` to look up traces once the job completes.


## Running the ESG Pipeline

### Option A: CLI (direct execution)

```bash
npm run agent:run
```

Runs the full pipeline for Aurora Energy's 2023 reporting year fixture directly from the command line and prints a score and trace summary to stdout.

### Option B: tRPC API

#### Input format and data normalisation

The API expects **normalised numeric inputs** for all primers. P-001 and P-002 accept raw counts and pass them straight through. P-003 requires ratio conversion from raw case study fields.

##### P-001: Scope 1 CO₂ intensity
- `scope1Emissions` — gross Scope 1 emissions in metric tonnes CO₂e
- `revenueMillions` — annual revenue in CAD millions
- No conversion needed — pass as-is

##### P-002: Board gender diversity
- `boardSize` — total board seats (integer)
- `femaleDirectors` — number of female-identifying directors (integer)
- No conversion needed — pass as-is

##### P-003: Supply chain labor risk

The case study provides raw counts and booleans. Convert them to ratios and scores before submitting:

| Case study raw field | API schema field | Conversion |
|---|---|---|
| `scope_1_co2_tonnes` | — | P-001 only |
| `supplier_count` | — | Used as denominator, not submitted |
| `audited_suppliers` | `auditedSuppliersRatio` | `audited_suppliers / supplier_count` |
| `suppliers_with_code_of_conduct` | `codeOfConductCoverage` | `suppliers_with_code_of_conduct / supplier_count` |
| `documented_human_rights_policy` | `documentedPoliciesScore` | `1.0` if `true`, `0.0` if `false` |
| `grievance_mechanism_exists` | `grievanceMechanismScore` | `1.0` if `true`, `0.0` if `false` |
| `incident_count_12mo` | `incidentCount` | Pass as integer |
| Narrative text | `supplyChainNarrative` | Pass as string (optional, max 8,000 chars) |

**Example — converting the case study's Aurora Energy P-003 data:**

Raw (from case study):
```json
{
  "supplier_count": 147,
  "audited_suppliers": 23,
  "suppliers_with_code_of_conduct": 89,
  "documented_human_rights_policy": true,
  "grievance_mechanism_exists": false,
  "incident_count_12mo": 2
}
```

Converted for the API:
```json
{
  "auditedSuppliersRatio": 0.1565,
  "codeOfConductCoverage": 0.6054,
  "documentedPoliciesScore": 1.0,
  "grievanceMechanismScore": 0.0,
  "incidentCount": 2
}
```

---

#### Submit ESG data (triggers pipeline)

```bash
curl -X POST http://localhost:3000/trpc/primer.submitData \
  -H "Content-Type: application/json" \
  -d '{
    "companyId": "00000000-0000-0000-0000-000000000001",
    "reportingYear": 2023,
    "rawInputData": {
      "p001": { "scope1Emissions": 38250, "revenueMillions": 850 },
      "p002": { "boardSize": 13, "femaleDirectors": 4 },
      "p003": {
        "auditedSuppliersRatio": 0.72,
        "codeOfConductCoverage": 0.88,
        "documentedPoliciesScore": 0.65,
        "grievanceMechanismScore": 0.80,
        "incidentCount": 2,
        "supplyChainNarrative": "Aurora completed third-party audits for 72% of tier-1 suppliers in 2023."
      }
    }
  }'
```

Expected response (synchronous execution):

```json
{
  "result": {
    "data": {
      "jobId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "processingComplete": true,
      "scores": [
        { "primerCode": "P-001", "scoreValue": 56.98, "confidenceScore": 1.0 },
        { "primerCode": "P-002", "scoreValue": 61.54, "confidenceScore": 1.0 },
        { "primerCode": "P-003", "scoreValue": 71.60, "confidenceScore": 0.85 }
      ],
      "errors": [],
      "executionSummary": [
        { "nodeName": "validation",      "traceId": "...", "durationMs": 1,    "llmModelUsed": null },
        { "nodeName": "p001Processing",  "traceId": "...", "durationMs": 1,    "llmModelUsed": null },
        { "nodeName": "p002Processing",  "traceId": "...", "durationMs": 1,    "llmModelUsed": null },
        { "nodeName": "p003Processing",  "traceId": "...", "durationMs": 1250, "llmModelUsed": "claude-3-5-sonnet-20241022" },
        { "nodeName": "persistence",     "traceId": "...", "durationMs": 18,   "llmModelUsed": null }
      ],
      "totalDurationMs": 1271
    }
  }
}
```

> By default the server runs the pipeline synchronously and returns a complete result set. If the service is configured to use an async queue (`ASYNC_JOB_QUEUE=true` or `REDIS_URL` set), `submitData` will enqueue the request and return immediately with a `jobId` while a separate worker processes the pipeline.

---

#### List all scores for a company / year

```bash
curl "http://localhost:3000/trpc/primer.listScores?input=%7B%22companyId%22%3A%2200000000-0000-0000-0000-000000000001%22%2C%22reportingYear%22%3A2023%7D"
```

Expected response excerpt:

```json
{
  "result": {
    "data": {
      "scoreCount": 3,
      "pillars": {
        "environmental": { "averageScore": 56.98, "primerCount": 1 },
        "governance":    { "averageScore": 61.54, "primerCount": 1 },
        "social":        { "averageScore": 71.60, "primerCount": 1 },
        "composite":     { "averageScore": 63.37 }
      }
    }
  }
}
```

---

#### Retrieve a single score with agent trace

```bash
curl "http://localhost:3000/trpc/primer.getScore?input=%7B%22companyId%22%3A%2200000000-0000-0000-0000-000000000001%22%2C%22primerCode%22%3A%22P-001%22%2C%22reportingYear%22%3A2023%7D"
```

#### Retrieve a full agent trace

```bash
# Use a traceId from submitData.executionSummary
curl "http://localhost:3000/trpc/primer.getAgentTrace?input=%7B%22traceId%22%3A%22<UUID>%22%7D"
```

---

## Testing

```bash
# Run all tests
npm test

# Verbose output
npx vitest run --reporter=verbose

# Coverage report
npm run test:coverage

# Type checking (must exit with 0 errors)
npm run typecheck
```

**Test coverage across 3 suites:**

| Suite | Coverage focus |
|-------|----------------|
| `scoring.test.ts` | Pure scoring functions for all 3 primers — boundary values, clamping, confidence tiers |
| `agents.test.ts` | LangGraph nodes (validation, p001, p002, p003, persistence), full graph via mocked DB + LLM |
| `api.test.ts` | All 4 tRPC procedures — success paths, NOT_FOUND, INTERNAL_SERVER_ERROR, Zod rejection |

---

## Architecture

```
src/
  db/
    schema.ts          Drizzle ORM: 5 tables + enums (companies, primers,
                       primer_data, scores, agent_traces)
    index.ts           pg.Pool singleton + Drizzle client
    seed.ts            Idempotent seed: Aurora Energy + 3 primers
  types/
    index.ts           Shared TypeScript interfaces (AgentState, PrimerScore,
                       ExecutionTrace, RawInputData, …)
  agents/
    scoring.ts         Pure scoring + validation functions — no DB, no LLM
    prompts/
      p003SystemPrompt.ts   LLM system prompt + user message builder for P-003
    nodes/
      validationNode.ts     Validates all 3 primers; populates ValidationFlags
      p001Node.ts           Intensity-based Scope 1 score
      p002Node.ts           Diversity-ratio Governance score
      p003Node.ts           Hybrid score: weighted base + Anthropic LLM call
      persistenceNode.ts    Transactional writes: traces → primer_data → scores
    graph.ts           StateGraph, Annotation reducers, runEsgPipeline(), CLI
  api/
    trpc.ts            tRPC v11 initialisation, error formatter
    context.ts         Per-request context (db client, requestId)
    schemas/
      index.ts         Zod schemas for all 4 procedure inputs and outputs
    routers/
      primer.ts        submitData · getScore · listScores · getAgentTrace
    index.ts           Root AppRouter
  server.ts            HTTP server: /health · /ready · /trpc
tests/
  scoring.test.ts
  agents.test.ts
  api.test.ts
docs/
  infrastructure.md    Production: containerisation, secret management,
                       BullMQ queue, observability, OWASP compliance
drizzle/
  migrations/          Generated Drizzle migration SQL (committed)
```

---

## Scoring Methodology

### P-001 — Scope 1 CO₂ Emissions (Environmental)

```
intensity     = scope1Emissions / revenueMillions     [tCO₂e / $M CAD]
peerBenchmark = 52.3 tCO₂e/$M CAD  (TSX-60 energy sector average)
score         = clamp(100 × (1 − intensity / (2 × 52.3)), 0, 100)
```

| Intensity | Score |
|-----------|-------|
| 0 | 100 |
| 52.3 (at benchmark) | 50 |
| ≥ 104.6 (2× benchmark) | 0 |

**Aurora Energy 2023:** 124,500 t / 2,840 $M = 43.8 tCO₂/$M → **score ≈ 58.2**

---

### P-002 — Board Gender Diversity (Governance)

```
diversityRatio = femaleDirectors / boardSize
score          = clamp((diversityRatio / 0.5) × 100, 0, 100)
```

| Diversity | Score |
|-----------|-------|
| 0% | 0 |
| 28.2% (TSX-60 avg) | ≈ 56.4 |
| 50% (parity) | 100 |

**Aurora Energy 2023:** 3/11 = 27.3% → **score ≈ 54.5**

---

### P-003 — Supply Chain Labor Risk (Social / Hybrid)

```
baseScore = (audited×0.30 + coc×0.25 + policies×0.20
           + grievance×0.15 − penaltyRatio×0.10) × 100

penaltyRatio = clamp(incidentCount / 10, 0, 1)

llmAdjustment ∈ [−20, +20]   (ChatAnthropic structured output)
finalScore    = clamp(baseScore + llmAdjustment, 0, 100)
```

Confidence score:
- `1.00` — LLM invoked, |adjustment| < 15
- `0.85` — LLM invoked, |adjustment| ≥ 15
- `0.75` — LLM call failed (falls back to base score only)

---

## Design Decisions

**Why sequential primer nodes instead of parallel fan-out?**
P-001 and P-002 are pure CPU-bound functions completing in < 1 ms each — parallelisation overhead is not justified. P-003 is I/O-bound (LLM call) and runs last so that earlier scores are available in state context if needed. A `Send`-API parallel variant is noted in `graph.ts` comments for production scale-out.

**Why normalised P-003 inputs instead of raw counts?**
The scoring layer sits downstream of ETL. Accepting pre-normalised ratios keeps the scoring functions pure and stateless. The conversion table in this README covers the mapping from raw case study fields to the API schema for evaluators.

**Why synchronous pipeline execution in `submitData`?**
Appropriate for a prototype handling ≤ 50 concurrent evaluations. `docs/infrastructure.md` documents the BullMQ + Redis queue architecture for the 1,000+ concurrency production target, with a `primer.getJobStatus` procedure and worker tier.

**Why is `percentileRank` always null?**
Peer cohort construction for TSX-60 percentile ranking is outside the scope of this evaluation — it would require a separate `computePercentiles` batch job once sufficient company data is ingested. The column, scoring utility function (`computePercentileRank`), and schema unique constraint are all in place for that future job.

---

## Docker Deployment

```bash
# Build production image (~90 MB compressed)
docker build -t aurora-esg-pipeline:latest .

# Run
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:password@db-host:5432/aurora_esg" \
  -e ANTHROPIC_API_KEY="sk-ant-..." \
  -e NODE_ENV=production \
  aurora-esg-pipeline:latest
```

For full infrastructure documentation — connection pooling, secret management, OpenTelemetry tracing, Prometheus metrics, and the BullMQ queue architecture — see [docs/infrastructure.md](docs/infrastructure.md).

---

## Available npm Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start server with `tsx` watch mode |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Run compiled output from `dist/` |
| `npm run db:generate` | Generate Drizzle migration SQL from schema changes |
| `npm run db:migrate` | Apply pending migrations to the database |
| `npm run db:seed` | Seed Aurora Energy + three ESG primers |
| `npm run agent:run` | Run pipeline CLI for the 2023 Aurora fixture |
| `npm test` | Run Vitest test suite |
| `npm run test:coverage` | Run tests + emit V8 coverage report |
| `npm run typecheck` | `tsc --noEmit` — must exit 0 |
| `npm run lint` | ESLint over `src/` |

---

## License

Internal evaluation artefact — AA Impact Inc. Technical Evaluation. Not for distribution.