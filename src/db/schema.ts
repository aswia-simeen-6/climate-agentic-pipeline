/**
 * src/db/schema.ts
 *
 * Drizzle ORM schema for the Aurora Energy ESG Agentic Pipeline.
 * All tables target PostgreSQL. Foreign keys, composite indexes,
 * and JSONB validation_rules are fully declared.
 *
 * Table dependency order (to avoid forward-reference issues):
 *   1. agent_traces  (referenced by primer_data)
 *   2. companies
 *   3. primers
 *   4. primer_data   (FK → companies, primers, agent_traces)
 *   5. scores        (FK → companies, primers)
 */

import {
  pgTable,
  text,
  numeric,
  jsonb,
  timestamp,
  integer,
  index,
  uniqueIndex,
  unique,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ─── Enums ────────────────────────────────────────────────────────────────────

export const esgCategoryEnum = pgEnum("esg_category", ["E", "S", "G"]);

export const primerDataTypeEnum = pgEnum("primer_data_type", [
  "QUANTITATIVE",
  "QUALITATIVE",
  "HYBRID",
]);

// ─── 1. agent_traces ─────────────────────────────────────────────────────────
// Declared first so primer_data can FK-reference it.

export const agentTraces = pgTable(
  "agent_traces",
  {
    id: text("id").primaryKey(),

    /** Human-readable name of the LangGraph node that produced this trace. */
    agentName: text("agent_name").notNull(),

    /** Full snapshot of the AgentState at node entry. */
    inputSnapshot: jsonb("input_snapshot").notNull(),

    /** Full snapshot of the AgentState at node exit. */
    outputSnapshot: jsonb("output_snapshot").notNull(),

    /** Wall-clock milliseconds the node took to complete. */
    executionDurationMs: integer("execution_duration_ms").notNull(),

    /** Anthropic / OpenAI model identifier used, null for non-LLM nodes. */
    llmModelUsed: text("llm_model_used"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    agentNameIdx: index("agent_traces_agent_name_idx").on(table.agentName),
    createdAtIdx: index("agent_traces_created_at_idx").on(table.createdAt),
  }),
);

// ─── 2. companies ─────────────────────────────────────────────────────────────

export const companies = pgTable(
  "companies",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),

    /** Exchange ticker symbol (e.g. AUR.TO). */
    ticker: text("ticker").notNull(),

    /** GICS Industry Group classification. */
    industryGroup: text("industry_group").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    tickerUniqueIdx: uniqueIndex("companies_ticker_unique_idx").on(
      table.ticker,
    ),
  }),
);

// ─── 3. primers ───────────────────────────────────────────────────────────────

export const primers = pgTable(
  "primers",
  {
    id: text("id").primaryKey(),

    /** Canonical primer code: P-001, P-002, P-003. */
    code: text("code").notNull(),

    /** Human-readable primer name. */
    name: text("name").notNull(),

    /** ESG pillar. */
    category: esgCategoryEnum("category").notNull(),

    /** QUANTITATIVE | QUALITATIVE | HYBRID */
    dataType: primerDataTypeEnum("data_type").notNull(),

    /**
     * JSONB bag of validation rules applied at the agent validation node.
     * Schema is open to allow future extensibility.
     * Example shape: { minValue: 0, maxValue: 1000000, required: ["scope1Emissions"] }
     */
    validationRules: jsonb("validation_rules"),
  },
  (table) => ({
    codeUniqueIdx: uniqueIndex("primers_code_unique_idx").on(table.code),
    categoryIdx: index("primers_category_idx").on(table.category),
  }),
);

// ─── 4. primer_data ───────────────────────────────────────────────────────────

export const primerData = pgTable(
  "primer_data",
  {
    id: text("id").primaryKey(),

    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),

    primerId: text("primer_id")
      .notNull()
      .references(() => primers.id, { onDelete: "restrict" }),

    /** ISO calendar year this data point covers. */
    reportingYear: integer("reporting_year").notNull(),

    /**
     * Raw ingested values before normalization.
     * P-001: { scope1Emissions: number, revenueMillions: number }
     * P-002: { boardSize: number, femaleDirectors: number }
     * P-003: { auditedSuppliersRatio, codeOfConductCoverage, ... }
     */
    rawValue: jsonb("raw_value").notNull(),

    /**
     * Dimensionless normalized value in [0, 1] derived from rawValue.
     * Precision 10, scale 8.
     */
    normalizedValue: numeric("normalized_value", {
      precision: 10,
      scale: 8,
    }),

    /**
     * Agent-assigned confidence in this data point [0.0, 1.0].
     * Lower values indicate boundary conditions or LLM uncertainty.
     */
    confidenceScore: numeric("confidence_score", {
      precision: 5,
      scale: 4,
    }),

    /** FK to the agent_traces record that produced this row. */
    agentTraceId: text("agent_trace_id").references(() => agentTraces.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    /**
     * Primary lookup path for the scoring engine:
     * fetch all primer data for a (company, primer, year) triple.
     */
    companyPrimerYearIdx: index(
      "primer_data_company_primer_year_idx",
    ).on(table.companyId, table.primerId, table.reportingYear),

    companyYearIdx: index("primer_data_company_year_idx").on(
      table.companyId,
      table.reportingYear,
    ),
  }),
);

// ─── 5. scores ────────────────────────────────────────────────────────────────

export const scores = pgTable(
  "scores",
  {
    id: text("id").primaryKey(),

    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),

    primerId: text("primer_id")
      .notNull()
      .references(() => primers.id, { onDelete: "restrict" }),

    /** ISO calendar year this score covers. */
    reportingYear: integer("reporting_year").notNull(),

    /**
     * Final ESG score in [0, 100].
     * Precision 5, scale 2 (e.g. 78.34).
     */
    scoreValue: numeric("score_value", {
      precision: 5,
      scale: 2,
    }).notNull(),

    /**
     * Percentile rank within the industry cohort [0, 100].
     * Populated post-aggregation; may be null on first insert.
     */
    percentileRank: numeric("percentile_rank", {
      precision: 5,
      scale: 2,
    }),

    /**
     * Semver-tagged methodology version so scores can be reproduced
     * or invalidated when methodology changes.
     */
    methodologyVersion: text("methodology_version").notNull(),

    computedAt: timestamp("computed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    /**
     * Composite index mirrors primer_data for fast score retrieval.
     */
    companyPrimerYearIdx: index(
      "scores_company_primer_year_idx",
    ).on(table.companyId, table.primerId, table.reportingYear),

    companyYearIdx: index("scores_company_year_idx").on(
      table.companyId,
      table.reportingYear,
    ),

    /**
     * Unique constraint on (companyId, primerId, reportingYear) so that
     * the persistence node can use ON CONFLICT DO UPDATE to upsert scores.
     * Only one score per (company, primer, year) triple is canonical.
     */
    companyPrimerYearUniqueConstraint: unique(
      "scores_company_primer_year_unique",
    ).on(table.companyId, table.primerId, table.reportingYear),
  }),
);

// ─── Relations (Drizzle relational query API) ─────────────────────────────────

export const companiesRelations = relations(companies, ({ many }) => ({
  primerData: many(primerData),
  scores: many(scores),
}));

export const primersRelations = relations(primers, ({ many }) => ({
  primerData: many(primerData),
  scores: many(scores),
}));

export const primerDataRelations = relations(primerData, ({ one }) => ({
  company: one(companies, {
    fields: [primerData.companyId],
    references: [companies.id],
  }),
  primer: one(primers, {
    fields: [primerData.primerId],
    references: [primers.id],
  }),
  agentTrace: one(agentTraces, {
    fields: [primerData.agentTraceId],
    references: [agentTraces.id],
  }),
}));

export const scoresRelations = relations(scores, ({ one }) => ({
  company: one(companies, {
    fields: [scores.companyId],
    references: [companies.id],
  }),
  primer: one(primers, {
    fields: [scores.primerId],
    references: [primers.id],
  }),
}));

export const agentTracesRelations = relations(agentTraces, ({ many }) => ({
  primerData: many(primerData),
}));

// ─── Inferred TypeScript types ────────────────────────────────────────────────

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;

export type Primer = typeof primers.$inferSelect;
export type NewPrimer = typeof primers.$inferInsert;

export type PrimerData = typeof primerData.$inferSelect;
export type NewPrimerData = typeof primerData.$inferInsert;

export type Score = typeof scores.$inferSelect;
export type NewScore = typeof scores.$inferInsert;

export type AgentTrace = typeof agentTraces.$inferSelect;
export type NewAgentTrace = typeof agentTraces.$inferInsert;
