# Infrastructure & Architecture Documentation

## Aurora ESG Agentic Pipeline — Technical Reference

> **Version:** v1.0.0 | **Last Updated:** 2024 | **Author:** AA Impact Inc. Technical Evaluation

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Containerization](#2-containerization)
3. [Database Architecture](#3-database-architecture)
4. [Secret Management](#4-secret-management)
5. [Scalability & Queue Architecture](#5-scalability--queue-architecture)
6. [Observability](#6-observability)
7. [Security Hardening](#7-security-hardening)
8. [Engineering Assumptions & Constraints](#8-engineering-assumptions--constraints)

---

## 1. System Overview

The Aurora ESG Agentic Pipeline is a **stateful LangGraph v0.2 workflow** that evaluates three ESG material primers for a given company / reporting-year pair.  It is served by a **tRPC v11** HTTP API backed by **PostgreSQL** (via Drizzle ORM).

```
┌────────────────────────────────────────────────────────────┐
│                         HTTP Layer                          │
│  POST /trpc/primer.submitData   GET /trpc/primer.getScore   │
│  GET  /trpc/primer.listScores   GET /trpc/primer.getAgentTrace│
│  GET  /health                   GET  /ready                  │
└────────────────────┬───────────────────────────────────────┘
                     │ tRPC caller
┌────────────────────▼───────────────────────────────────────┐
│                   LangGraph StateGraph                      │
│                                                             │
│  START → validation → p001Processing → p002Processing      │
│       → p003Processing (+ Anthropic LLM) → persistence → END│
└────────────────────┬───────────────────────────────────────┘
                     │ Drizzle ORM / pg Pool
┌────────────────────▼───────────────────────────────────────┐
│               PostgreSQL 14+                                │
│  tables: companies · primers · primer_data · scores         │
│          agent_traces                                       │
└────────────────────────────────────────────────────────────┘
```

The pipeline currently executes **synchronously within the HTTP request** (suitable for ≤ 50 concurrent evaluations). A decoupled queue architecture for 1,000+ concurrent assessments is documented in [Section 5](#5-scalability--queue-architecture).

---

## 2. Containerization

### 2.1 Multi-Stage Dockerfile

The production image uses three stages to minimise the final image surface area:

| Stage | Base Image | Purpose |
|-------|-----------|---------|
| `deps` | `node:20-alpine` | Install all `node_modules` (dev + prod); Docker-cached unless `package*.json` changes |
| `builder` | `node:20-alpine` | Copy deps, compile TypeScript via `tsc` to `./dist` |
| `runner` | `node:20-alpine` | Copy only `dist/` + prod `node_modules`; run as non-root user |

**Key security properties of the runner stage:**

- `dumb-init` as PID 1 — ensures `SIGTERM` is forwarded to Node, triggering the graceful shutdown handler in `src/server.ts` (closes HTTP server, drains the pg `Pool`).
- Non-root OS user (`nodeuser`, UID 1001) — satisfies CIS Docker Benchmark control 4.1.
- No secrets baked in — all credentials are injected at runtime via environment variables or a mounted Kubernetes Secret.

### 2.2 Building & Running Locally

```bash
# Build image
docker build -t aurora-esg-pipeline:latest .

# Run with environment injection
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:password@db:5432/esgs" \
  -e ANTHROPIC_API_KEY="sk-ant-..." \
  aurora-esg-pipeline:latest
```

### 2.3 Image Size Estimation

| Stage | Approximate Compressed Size |
|-------|-----------------------------|
| `deps` + `builder` (build cache) | ~450 MB |
| **runner** (final image) | **~90 MB** |

The reduction is achieved by:

1. Excluding all `devDependencies` (`npm ci --omit=dev` in runner stage).
2. Excluding test files, docs, and migration tooling via `.dockerignore`.
3. Using `alpine` variant (musl libc vs glibc).

---

## 3. Database Architecture

### 3.1 Schema Design

Five PostgreSQL tables are managed by Drizzle ORM (`src/db/schema.ts`):

```
companies
  id (uuid PK)  name  ticker  industry_group  created_at

primers
  id (uuid PK)  code (P-001|P-002|P-003)  name  category (E|S|G)
  data_type (QUANTITATIVE|QUALITATIVE|HYBRID)  validation_rules (jsonb)

primer_data
  id (uuid PK)  company_id (FK→companies)  primer_id (FK→primers)
  reporting_year  raw_value (jsonb)  normalized_value (numeric 8,4)
  confidence_score (numeric 5,4)  agent_trace_id (FK→agent_traces nullable)
  created_at
  INDEX: (company_id, primer_id, reporting_year)

scores
  id (uuid PK)  company_id (FK→companies)  primer_id (FK→primers)
  reporting_year  score_value (numeric 6,2)  percentile_rank (numeric 5,2)
  methodology_version  computed_at
  UNIQUE: (company_id, primer_id, reporting_year)  ← required for ON CONFLICT DO UPDATE

agent_traces
  id (uuid PK)  agent_name  input_snapshot (jsonb)  output_snapshot (jsonb)
  execution_duration_ms  llm_model_used  created_at
```

### 3.2 Connection Pooling

The application creates a single `pg.Pool` instance with the following settings (see `src/db/index.ts`):

```typescript
{ max: 10, idleTimeoutMillis: 30_000 }
```

**Production recommendation:** Deploy **PgBouncer** in transaction-mode between the application and PostgreSQL when scaling beyond a single instance:

```
                        ┌──────────────┐
  App Container 1 ──────►              │
  App Container 2 ──────► PgBouncer   ├──── PostgreSQL Primary
  App Container 3 ──────►  (tx mode)  │
  App Container N ──────►              │
                        └──────────────┘
```

PgBouncer pool parameters for this workload:

```ini
pool_mode = transaction
max_client_conn = 500
default_pool_size = 25
reserve_pool_size = 5
reserve_pool_timeout = 3
server_idle_timeout = 600
```

### 3.3 Indexing Strategy

| Index | Columns | Query Type |
|-------|---------|-----------|
| `primer_data_company_primer_year_idx` | `(company_id, primer_id, reporting_year)` | Point-lookup in `getScore` and `persistenceNode` |
| `scores` unique constraint | `(company_id, primer_id, reporting_year)` | `ON CONFLICT DO UPDATE` in `persistenceNode` |

**Recommendation for read-heavy deployments:** Add a covering index on `scores(company_id, reporting_year) INCLUDE (score_value, primer_id)` to enable index-only scans in `listScores`.

### 3.4 Migrations

Database schema is managed via **drizzle-kit**:

```bash
# Generate migration SQL from schema changes
npx drizzle-kit generate

# Apply migrations (CI/CD pre-deploy hook)
npx drizzle-kit push

# Interactive migration explorer
npx drizzle-kit studio
```

Migration files are stored in `drizzle/migrations/` and should be committed to source control.  Apply them as a **Kubernetes Job** or **ECS Task** before rolling out new application containers.

---

## 4. Secret Management

### 4.1 Secrets Inventory

| Secret | Usage | Rotation Frequency |
|--------|-------|--------------------|
| `DATABASE_URL` | PostgreSQL connection string (includes password) | 90 days |
| `ANTHROPIC_API_KEY` | P-003 LLM structured output call | 30 days |

### 4.2 AWS Secrets Manager Integration (Recommended)

Store each secret as a separate `SecretString` entry.  The application init code fetches and injects them at startup:

```typescript
// src/secrets.ts (recommended addition for production)
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({ region: process.env["AWS_REGION"] ?? "ca-central-1" });

export async function loadSecrets(): Promise<void> {
  const [dbSecret, anthropicSecret] = await Promise.all([
    client.send(new GetSecretValueCommand({ SecretId: "aurora-esg/database-url" })),
    client.send(new GetSecretValueCommand({ SecretId: "aurora-esg/anthropic-api-key" })),
  ]);

  process.env["DATABASE_URL"] = dbSecret.SecretString!;
  process.env["ANTHROPIC_API_KEY"] = anthropicSecret.SecretString!;
}
```

Call `await loadSecrets()` at the top of `src/server.ts` before `createHTTPHandler()`.

### 4.3 HashiCorp Vault (Alternative)

For on-premises or multi-cloud deployments, use Vault's dynamic database credentials:

```hcl
# Vault policy: aurora-esg-pipeline
path "database/creds/aurora-esg-role" {
  capabilities = ["read"]
}
path "secret/data/aurora-esg/anthropic" {
  capabilities = ["read"]
}
```

Use the Vault Agent Sidecar Injector (Kubernetes) or the `node-vault` client library to refresh dynamic credentials before the 1-hour TTL expires — critical for long-running workers in the queue architecture described in Section 5.

---

## 5. Scalability & Queue Architecture

### 5.1 Current Synchronous Model

In the prototype, `submitData` executes the full LangGraph pipeline synchronously in the HTTP request handler.  This is suitable for interactive evaluation of ≤ 50 concurrent assessments but has two constraints:

1. **Request timeout risk** — the P-003 LLM call adds 1–4 s latency.  Long-tail retries can exceed load balancer timeouts (typically 60 s).
2. **Horizontal scaling limit** — each Node.js worker blocks a V8 event-loop tick while awaiting the LLM.

### 5.2 BullMQ + Redis Queue Architecture (Production Target)

```
                           ┌──────────────────────────────────────┐
  Client ─► POST submitData │  Web Tier (multiple instances)        │
            returns jobId   │  src/server.ts                        │
                           │  Enqueues job into Redis/BullMQ        │
                           └─────────────────┬────────────────────┘
                                             │ Bull job
                           ┌─────────────────▼────────────────────┐
                           │  Worker Tier (auto-scaled)             │
                           │  Consumes ESG scoring jobs             │
                           │  Runs runEsgPipeline()                 │
                           │  Writes scores → PostgreSQL            │
                           └──────────────────────────────────────┘
```

**Implementation steps:**

1. Install `bullmq` and `ioredis`.
2. Create an `EsgScoringQueue` in `src/queue/esgQueue.ts`:

```typescript
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { runEsgPipeline } from "../agents/graph";
import type { PipelineRunRequest } from "../types/index";

const redisConnection = new IORedis(process.env["REDIS_URL"] ?? "redis://localhost:6379");

export const esgQueue = new Queue<PipelineRunRequest>("esg-scoring", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: { age: 86_400 }, // retain 24 h for audit
    removeOnFail: false,               // retain failed jobs indefinitely
  },
});

export const esgWorker = new Worker<PipelineRunRequest>(
  "esg-scoring",
  async (job) => {
    const result = await runEsgPipeline(job.data);
    return result;
  },
  {
    connection: redisConnection,
    concurrency: 10, // Process 10 evaluations per worker instance
  },
);
```

3. In `submitData`, replace the direct `runEsgPipeline()` call with:

```typescript
const job = await esgQueue.add("score", { companyId, reportingYear, rawInputData });
return { jobId: job.id, status: "queued", ...};
```

4. Expose a new `primer.getJobStatus` tRPC query that polls BullMQ for job completion and returns the final score summary once the worker writes it to PostgreSQL.

### 5.3 Throughput Estimates

| Configuration | Target Throughput |
|---------------|-----------------|
| 1 web instance + synchronous | ~5 concurrent assessments |
| 2 web + 4 worker instances (BullMQ) | ~200 concurrent assessments |
| 4 web + 10 worker instances + PgBouncer | **1,000+ concurrent assessments** |

Worker instances are stateless and can be auto-scaled based on the BullMQ queue depth (`waiting` + `active` job count) via Kubernetes HPA or ECS auto-scaling.

---

## 6. Observability

### 6.1 Structured Logging

Replace `console.*` with **pino** for production-grade structured JSON logging:

```typescript
import pino from "pino";

export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  base: { service: "aurora-esg-pipeline", version: process.env["npm_package_version"] },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: ["DATABASE_URL", "ANTHROPIC_API_KEY"], // never log secrets
});
```

Each LangGraph node should log its `ExecutionTrace` on completion, enabling per-assessment audit trails in a log aggregator (Datadog, CloudWatch Logs, or OpenSearch).

### 6.2 OpenTelemetry Tracing

Instrument the LangGraph workflow and tRPC handler with **OpenTelemetry** for distributed traces:

```typescript
import { NodeTracerProvider } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";

const provider = new NodeTracerProvider();
provider.addSpanProcessor(
  new BatchSpanProcessor(new OTLPTraceExporter({ url: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] })),
);
provider.register();

registerInstrumentations({
  instrumentations: [new HttpInstrumentation(), new PgInstrumentation()],
});
```

Key trace spans to add manually:

| Span | Attributes |
|------|-----------|
| `esg.pipeline.run` | `company_id`, `reporting_year`, `primer_count` |
| `esg.node.p003Processing` | `llm_model`, `llm_adjustment`, `base_score` |
| `esg.persistence.transaction` | `rows_inserted`, `duration_ms` |

### 6.3 Prometheus Metrics

Expose a `/metrics` endpoint for Prometheus scraping using `prom-client`:

```typescript
import { Registry, Counter, Histogram, collectDefaultMetrics } from "prom-client";

const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const pipelineRuns = new Counter({
  name: "esg_pipeline_runs_total",
  help: "Total ESG pipeline executions",
  labelNames: ["status", "primer_count"],
  registers: [registry],
});

export const pipelineDuration = new Histogram({
  name: "esg_pipeline_duration_seconds",
  help: "ESG pipeline execution duration",
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});
```

Alert thresholds (recommended SLOs):

| Metric | Warning | Critical |
|--------|---------|---------|
| `esg_pipeline_duration_seconds` p99 | > 10 s | > 30 s |
| `esg_pipeline_runs_total{status="error"}` rate | > 1% | > 5% |
| `pg_pool_idle_connections` | < 2 | < 1 |

---

## 7. Security Hardening

### 7.1 OWASP Top 10 Compliance

| OWASP Risk | Mitigation Applied |
|------------|-------------------|
| A01 Broken Access Control | tRPC procedures are public in prototype; add JWT/OAuth middleware before production |
| A02 Cryptographic Failures | TLS required for `DATABASE_URL` (`?sslmode=require`); secrets never logged |
| A03 Injection | All DB queries use Drizzle's parameterised builder — no raw SQL interpolation |
| A04 Insecure Design | Separation of concerns: pure scoring functions have no side effects; LLM output is schema-validated via Zod before use |
| A05 Security Misconfiguration | Non-root Docker user; `NODE_ENV=production` removes stack traces from error responses |
| A06 Vulnerable Components | `npm audit` run in CI; `@langchain/core` pinned to a specific version |
| A07 Auth Failures | Not applicable in prototype; add `@trpc/server` middleware for HMAC/JWT validation |
| A08 Software Integrity | `npm ci --frozen-lockfile` ensures `package-lock.json` integrity |
| A09 Logging Failures | All LangGraph node execution traces are persisted to `agent_traces`; errors recorded in `AgentState.errors` |
| A10 SSRF | LLM calls are outbound-only via Anthropic SDK; no user-controlled URLs are fetched |

### 7.2 Input Validation Layers

The pipeline enforces **three validation layers** before any computation:

1. **Zod schema validation** (`src/api/schemas/index.ts`) — enforced by tRPC's `.input()` at the HTTP boundary.
2. **Domain validation** (`src/agents/scoring.ts` `validate*Input` functions) — enforced in `validationNode`.
3. **LLM output schema validation** (`P003LlmOutputSchema` Zod schema in `p003Node.ts`) — prevents prompt injection from affecting score computation.

---

## 8. Engineering Assumptions & Constraints

| # | Assumption | Rationale |
|---|-----------|-----------|
| 1 | `ANTHROPIC_API_KEY` is present when `p003` input is provided | The p003Node falls back to the quantitative base score (confidence 0.75) if the LLM call fails, but the API key is expected for production runs |
| 2 | All monetary values (`revenueMillions`) are in **CAD millions** | Consistent with the TSX-60 peer benchmark derived from SEDAR+ disclosures |
| 3 | Scope 1 emissions are in **metric tonnes CO₂e** | Consistent with GHG Protocol Corporate Standard |
| 4 | Reporting year refers to the fiscal year end date | Aurora Energy's fiscal year ends December 31 |
| 5 | The `scores` table is append-only per (company, primer, year) triple using upsert | Re-running `submitData` for the same triple overwrites the previous score; this is intentional to support methodology version upgrades |
| 6 | `percentileRank` on `scores` is `null` in the prototype | Peer cohort construction for TSX-60 percentile ranking is outside the scope of this evaluation and would require a separate `computePercentiles` job |
| 7 | LLM adjustment is bounded to ±20 points | Defined in `P003_LLM_ADJ_MIN` / `P003_LLM_ADJ_MAX` constants; validated in `applyP003LlmAdjustment` |
| 8 | Node.js ≥ v20 and PostgreSQL ≥ 14 are required | Drizzle ORM requires `pg` v8+ which requires PostgreSQL 14+ for full `jsonb` support; `tsx` (ESM-compatible TypeScript runner) requires Node 20+ |
