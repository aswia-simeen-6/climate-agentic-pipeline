# Aurora ESG Agentic Pipeline

**AA Impact Inc. Technical Evaluation — Agentic Backend Submission**

A production-quality ESG scoring pipeline built with **LangGraph v0.2**, **tRPC v11**, **Drizzle ORM** (PostgreSQL), and **TypeScript 5.5** strict mode.  It evaluates three ESG material primers for Aurora Energy Inc. (TSX: AUR.TO) for the 2023 reporting year.

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
| Anthropic API key | For P-003 LLM evaluation |

---

## Quick Start

### 1. Clone and Install

```bash
git clone <repo-url>
cd climate-agentic-pipeline
npm ci
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your actual values:

```dotenv
DATABASE_URL=postgresql://postgres:password@localhost:5432/aurora_esg
ANTHROPIC_API_KEY=sk-ant-...
LLM_MODEL=claude-3-5-sonnet-20241022
PORT=3000
METHODOLOGY_VERSION=v1.0.0
P001_PEER_BENCHMARK_INTENSITY=52.3
P002_TSX60_AVERAGE_DIVERSITY=0.282
```

### 3. Set Up the Database

```bash
# Push the schema to your PostgreSQL instance
npx drizzle-kit push

# Seed Aurora Energy Inc. and the three ESG primers
npm run db:seed
```

### 4. Start the Development Server

```bash
npm run dev
```

The server listens on `http://localhost:3000`.  Health endpoints:

- `GET /health` — liveness probe
- `GET /ready` — readiness probe (verifies DB connectivity)

---

## Running the ESG Pipeline

### Option A: CLI (direct execution)

```bash
npm run agent:run
```

Runs the full pipeline for Aurora Energy's 2023 reporting year fixture directly from the command line.

### Option B: tRPC API

#### Submit ESG Data (triggers pipeline)

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

**Expected response excerpt:**

```json
{
  "result": {
    "data": {
      "processingComplete": true,
      "scores": [
        { "primerCode": "P-001", "scoreValue": 56.98, "confidenceScore": 1.0 },
        { "primerCode": "P-002", "scoreValue": 61.54, "confidenceScore": 1.0 },
        { "primerCode": "P-003", "scoreValue": 71.60, "confidenceScore": 0.85 }
      ],
      "errors": []
    }
  }
}
```

#### List All Scores for a Company / Year

```bash
curl "http://localhost:3000/trpc/primer.listScores?input=%7B%22companyId%22%3A%2200000000-0000-0000-0000-000000000001%22%2C%22reportingYear%22%3A2023%7D"
```

**Expected response excerpt:**

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

#### Retrieve a Single Score with Agent Trace

```bash
curl "http://localhost:3000/trpc/primer.getScore?input=%7B%22companyId%22%3A%2200000000-0000-0000-0000-000000000001%22%2C%22primerCode%22%3A%22P-001%22%2C%22reportingYear%22%3A2023%7D"
```

#### Retrieve an Agent Trace

```bash
# Use a traceId returned from submitData.executionSummary
curl "http://localhost:3000/trpc/primer.getAgentTrace?input=%7B%22traceId%22%3A%22<UUID>%22%7D"
```

---

## Testing

```bash
# Run all tests
npm test

# Run with verbose output
npx vitest run --reporter=verbose

# Coverage report
npm run test:coverage
```

**Test coverage (93 tests across 3 suites):**

| Suite | Tests | Coverage Focus |
|-------|-------|----------------|
| `scoring.test.ts` | ~40 | Pure scoring functions, all 3 primers, edge cases |
| `agents.test.ts` | ~25 | LangGraph nodes, persistenceNode, end-to-end pipeline |
| `api.test.ts` | ~14 | tRPC procedures, NOT_FOUND/INTERNAL_SERVER_ERROR paths |

```bash
# Type checking (must report 0 errors)
npm run typecheck
```

---

## Architecture

```
src/
  db/
    schema.ts         Drizzle ORM table definitions (5 tables + enums)
    index.ts          pg.Pool singleton, Drizzle client
    seed.ts           Idempotent seed: Aurora Energy + primers + fixture function
  types/
    index.ts          All shared TypeScript interfaces (AgentState, PrimerScore, etc.)
  agents/
    scoring.ts        Pure scoring functions (no side effects, no DB, no LLM)
    prompts/
      p003SystemPrompt.ts  LLM system prompt + user message builder for P-003
    nodes/
      validationNode.ts    Validates all three primer inputs
      p001Node.ts          Computes P-001 intensity score
      p002Node.ts          Computes P-002 diversity score
      p003Node.ts          Computes P-003 hybrid score (incl. Anthropic LLM call)
      persistenceNode.ts   Transactional DB writes (traces + primerData + scores)
    graph.ts          Builds StateGraph, exports runEsgPipeline(), CLI entry
  api/
    trpc.ts           tRPC v11 init, context type, error formatter
    context.ts        Per-request context factory (db, requestId)
    schemas/
      index.ts        All Zod input/output schemas for the 4 procedures
    routers/
      primer.ts       submitData · getScore · listScores · getAgentTrace
    index.ts          Root AppRouter assembly
  server.ts           Node HTTP server: /health · /ready · /trpc
tests/
  scoring.test.ts     Unit tests for pure scoring functions
  agents.test.ts      Integration tests for LangGraph nodes + full pipeline
  api.test.ts         Unit tests for all 4 tRPC procedures
docs/
  infrastructure.md   Production infrastructure, containerization, security
```

---

## Scoring Methodology

### P-001 — Scope 1 CO₂ Emissions (Environmental)

```
intensity      = scope1Emissions / revenueMillions            [tCO₂e / $M CAD]
peerBenchmark  = 52.3 tCO₂e/$M CAD  (TSX-60 energy sector)
score          = clamp(100 × (1 − intensity / (2 × 52.3)), 0, 100)
```

- Score of **100** → zero emissions.
- Score of **50** → exactly at peer benchmark.
- Score of **0** → emissions ≥ 2× peer benchmark.

**Aurora Energy 2023:** intensity = 45.0 → **score ≈ 56.98**

### P-002 — Board Gender Diversity (Governance)

```
diversityRatio = femaleDirectors / boardSize
score          = clamp((diversityRatio / 0.5) × 100, 0, 100)
```

- Score of **100** → 50% female directors (parity).
- Score of **50** → 25% female directors.

**Aurora Energy 2023:** 4/13 = 30.8% → **score ≈ 61.54**

### P-003 — Supply Chain Labor Risk (Social / Hybrid)

```
baseScore = (audited×0.30 + coc×0.25 + policies×0.20
           + grievance×0.15 − penaltyRatio×0.10) × 100
penaltyRatio = clamp(incidentCount / 10, 0, 1)

llmAdjustment ∈ [−20, +20]  (from ChatAnthropic structured output)
finalScore = clamp(baseScore + llmAdjustment, 0, 100)
```

Confidence:
- `1.00` if |llmAdjustment| < 15
- `0.85` if |llmAdjustment| ≥ 15
- `0.75` if LLM call failed (fallback to base score)

**Aurora Energy 2023:** base ≈ 66.60, LLM adj = +5.0 → **score ≈ 71.60**

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

For full infrastructure documentation, connection pooling, secret management, observability, and the BullMQ queue architecture for 1,000+ concurrent assessments, see [docs/infrastructure.md](docs/infrastructure.md).

---

## Available npm Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start server with `tsx` watch mode |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run db:seed` | Seed Aurora Energy + primers |
| `npm run agent:run` | Run pipeline CLI for 2023 fixture |
| `npm test` | Run Vitest test suite |
| `npm run test:coverage` | Run tests + emit coverage report |
| `npm run typecheck` | `tsc --noEmit` — must exit 0 |

---

## License

Internal evaluation artefact — AA Impact Inc. Technical Evaluation.  Not for distribution.

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
