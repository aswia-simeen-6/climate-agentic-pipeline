/**
 * src/db/seed.ts
 *
 * Idempotent seed script that provisions the reference data required for the
 * Aurora Energy ESG pipeline:
 *   - One company record  : Aurora Energy (AUR.TO)
 *   - Three primer records : P-001, P-002, P-003
 *
 * Run: `npm run db:seed`
 * The script is safe to re-run; existing rows are upserted via ON CONFLICT DO NOTHING.
 */

import * as dotenv from "dotenv";
dotenv.config();

import { db, pool } from "./index";
import { companies, primers } from "./schema";
import { sql } from "drizzle-orm";

// ─── Seed Data ────────────────────────────────────────────────────────────────

const AURORA_ENERGY_ID = "00000000-0000-0000-0000-000000000001";

const companyRecord = {
  id: AURORA_ENERGY_ID,
  name: "Aurora Energy Inc.",
  ticker: "AUR.TO",
  industryGroup: "Energy — Oil, Gas & Consumable Fuels",
};

const primerRecords = [
  {
    id: "10000000-0000-0000-0000-000000000001",
    code: "P-001",
    name: "Scope 1 CO₂ Emissions",
    category: "E" as const,
    dataType: "QUANTITATIVE" as const,
    validationRules: {
      required: ["scope1Emissions", "revenueMillions"],
      scope1Emissions: {
        type: "number",
        minimum: 0.01,
        maximum: 50_000_000,
        description: "Gross Scope 1 GHG emissions in metric tonnes CO₂e",
      },
      revenueMillions: {
        type: "number",
        minimum: 0.01,
        maximum: 500_000,
        description: "Annual revenue in millions of Canadian dollars",
      },
      peerBenchmarkIntensity: {
        description: "Industry peer average CO₂ intensity (tCO₂/$M revenue)",
        value: 52.3,
      },
    },
  },
  {
    id: "10000000-0000-0000-0000-000000000002",
    code: "P-002",
    name: "Board Gender Diversity",
    category: "G" as const,
    dataType: "QUANTITATIVE" as const,
    validationRules: {
      required: ["boardSize", "femaleDirectors"],
      boardSize: {
        type: "integer",
        minimum: 3,
        maximum: 25,
        description: "Total number of board directors",
      },
      femaleDirectors: {
        type: "integer",
        minimum: 0,
        description: "Number of female-identifying directors",
        constraint: "must be <= boardSize",
      },
      tsx60AverageDiversity: {
        description: "TSX60 average board gender diversity (decimal fraction)",
        value: 0.282,
      },
    },
  },
  {
    id: "10000000-0000-0000-0000-000000000003",
    code: "P-003",
    name: "Supply Chain Labor Risk",
    category: "S" as const,
    dataType: "HYBRID" as const,
    validationRules: {
      required: [
        "auditedSuppliersRatio",
        "codeOfConductCoverage",
        "documentedPoliciesScore",
        "grievanceMechanismScore",
        "incidentCount",
      ],
      auditedSuppliersRatio: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Fraction of tier-1 suppliers audited against labor standards",
      },
      codeOfConductCoverage: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Fraction of supply chain covered by a code of conduct",
      },
      documentedPoliciesScore: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Normalized score for existence of documented labor policies",
      },
      grievanceMechanismScore: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Normalized score for accessible worker grievance mechanism",
      },
      incidentCount: {
        type: "integer",
        minimum: 0,
        description: "Number of reported labor-related incidents in the reporting year",
      },
      supplyChainNarrative: {
        type: "string",
        description: "Optional free-text qualitative description of supply chain practices",
      },
      weights: {
        auditedSuppliersRatio: 0.30,
        codeOfConductCoverage: 0.25,
        documentedPoliciesScore: 0.20,
        grievanceMechanismScore: 0.15,
        incidentPenalty: 0.10,
      },
      llmQualitativeAdjustmentRange: {
        min: -20,
        max: 20,
      },
    },
  },
];

// ─── Seed Runner ──────────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  console.info("[seed] Starting ESG pipeline reference data seed...");

  // Upsert company
  await db
    .insert(companies)
    .values(companyRecord)
    .onConflictDoNothing({ target: companies.id });

  console.info(`[seed] Upserted company: ${companyRecord.name} (${companyRecord.ticker})`);

  // Upsert primers
  for (const primer of primerRecords) {
    await db
      .insert(primers)
      .values(primer)
      .onConflictDoNothing({ target: primers.id });

    console.info(`[seed] Upserted primer: ${primer.code} — ${primer.name}`);
  }

  // Verify inserts
  const companyCount = await db.execute(
    sql`SELECT COUNT(*) AS cnt FROM companies`,
  );
  const primerCount = await db.execute(
    sql`SELECT COUNT(*) AS cnt FROM primers`,
  );

  console.info(
    `[seed] Verification — companies: ${(companyCount.rows[0] as { cnt: string }).cnt}, ` +
    `primers: ${(primerCount.rows[0] as { cnt: string }).cnt}`,
  );

  console.info("[seed] Seed completed successfully.");
}

// ─── Sample Fixture Data for Integration Tests ────────────────────────────────

/**
 * Returns a deterministic set of Aurora Energy primer inputs for 2023.
 * Used by integration test suites to bypass external data ingestion.
 */
export function getAuroraEnergyFixture2023(): {
  companyId: string;
  reportingYear: number;
  p001Input: {
    scope1Emissions: number;
    revenueMillions: number;
  };
  p002Input: {
    boardSize: number;
    femaleDirectors: number;
  };
  p003Input: {
    auditedSuppliersRatio: number;
    codeOfConductCoverage: number;
    documentedPoliciesScore: number;
    grievanceMechanismScore: number;
    incidentCount: number;
    supplyChainNarrative: string;
  };
} {
  return {
    companyId: AURORA_ENERGY_ID,
    reportingYear: 2023,
    p001Input: {
      // Intensity = 38,250 / 850 = 45.0 tCO₂/$M  → below benchmark (52.3)
      scope1Emissions: 38_250,
      revenueMillions: 850,
    },
    p002Input: {
      // Diversity = 4/13 ≈ 30.8%  → slightly above TSX60 avg (28.2%)
      boardSize: 13,
      femaleDirectors: 4,
    },
    p003Input: {
      auditedSuppliersRatio: 0.72,
      codeOfConductCoverage: 0.88,
      documentedPoliciesScore: 0.65,
      grievanceMechanismScore: 0.80,
      incidentCount: 2,
      supplyChainNarrative:
        "Aurora Energy completed third-party labor audits for 72% of tier-1 suppliers " +
        "in 2023. A revised Supplier Code of Conduct was published in Q2 and distributed " +
        "to 88% of the supply chain by year-end. The company maintains a confidential " +
        "grievance hotline with a 14-day response SLA. Two minor labor incidents were " +
        "reported and remediated within 30 days with no regulatory escalation.",
    },
  };
}

export { AURORA_ENERGY_ID };

// ─── Entry Point ──────────────────────────────────────────────────────────────

seed()
  .then(() => {
    void pool.end();
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("[seed] Fatal error:", err);
    void pool.end();
    process.exit(1);
  });
