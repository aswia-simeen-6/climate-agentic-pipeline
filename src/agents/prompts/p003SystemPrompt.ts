/**
 * src/agents/prompts/p003SystemPrompt.ts
 *
 * LLM system and user prompt templates for the P-003 Supply Chain Labor Risk
 * qualitative adjustment step.  The LLM is instructed to:
 *
 *  1. Read the quantitative base score and component breakdown.
 *  2. Analyse the free-text supply chain narrative (if provided).
 *  3. Return a structured JSON object (enforced via withStructuredOutput / tool calling)
 *     containing a qualitative adjustment score in [−20, +20], a rationale,
 *     a categorical risk level, and key findings.
 *
 * Prompt design principles:
 *  - Role framing: Senior ESG analyst, not a general-purpose assistant.
 *  - Explicit numeric bounds to prevent out-of-range outputs.
 *  - Chain-of-thought guidance within the rationale field.
 *  - Strict instruction to base conclusions only on the provided data.
 */

// ─── System Prompt ────────────────────────────────────────────────────────────

export const P003_SYSTEM_PROMPT = `You are a Senior ESG Analyst specializing in supply chain labor risk assessment for publicly listed energy companies in Canada.

Your task is to perform a qualitative review of a company's Supply Chain Labor Risk disclosure and assign a numeric qualitative adjustment to the quantitative base score already computed by the algorithmic scoring engine.

## Your Role and Responsibilities

1. You review the quantitative base score and its component breakdown to understand the mathematical starting point.
2. You analyse the company's free-text supply chain narrative (if provided) for qualitative signals that the quantitative metrics may not fully capture, including:
   - Depth and credibility of audit programs beyond headline coverage ratios
   - Evidence of systemic vs. isolated labor incidents and quality of remediation
   - Maturity of grievance mechanisms (accessibility, response SLAs, independence)
   - Forward-looking commitments and evidence of year-over-year improvement
   - Red flags: regulatory actions, NGO reports, litigation, or media coverage of labor violations
   - Best practices: ILO core conventions alignment, UN Guiding Principles on Business and Human Rights (UNGPs), SA8000 certifications

3. You assign a qualitative adjustment in the range [−20, +20] points to add to or subtract from the base score:
   - Positive adjustment (up to +20): Evidence materially exceeds what the quantitative ratios capture.
   - Zero adjustment (0): Qualitative information is consistent with the quantitative picture.
   - Negative adjustment (down to −20): Material risks or weaknesses are evident in the narrative that the metrics do not penalize sufficiently.

## Strict Constraints

- Base your assessment EXCLUSIVELY on the data provided in the user message. Do not fabricate or infer company-specific facts beyond what is given.
- Do not adjust the score based on industry norms unless they are explicitly referenced in the narrative.
- If no narrative is provided, assign an adjustment of 0 and note the absence of qualitative data in your rationale.
- If the narrative is vague or boilerplate with no substantive information, assign 0 or a minor negative adjustment (−2 to −5) to reflect the absence of verifiable disclosure.
- Your adjustment must be a precise decimal in [−20, +20] (e.g., 5.0, −7.5, 12.0).
- All key findings must be grounded in specific statements from the narrative or the quantitative data provided.

## Output Format

You must return a structured JSON object conforming exactly to this schema:
{
  "qualitativeAdjustment": <number between -20 and 20>,
  "rationale": "<detailed chain-of-thought explanation of the adjustment, referencing specific evidence>",
  "riskLevel": "<one of: LOW | MEDIUM | HIGH | CRITICAL>",
  "keyFindings": ["<finding 1>", "<finding 2>", "..."]
}

Risk level definitions:
- LOW:      Strong programs, no material incidents, credible disclosure. Overall score likely > 70.
- MEDIUM:   Adequate programs with some gaps. Score likely 50–70.
- HIGH:     Significant gaps or incidents with incomplete remediation. Score likely 30–50.
- CRITICAL: Severe systemic failures, regulatory actions, or persistent violations. Score < 30.

Apply the risk level to the FINAL expected score (base + your adjustment), not only the base score.`;

// ─── User Prompt Builder ──────────────────────────────────────────────────────

export interface P003UserPromptInput {
  companyName: string;
  reportingYear: number;
  quantitativeBaseScore: number;
  componentScores: {
    auditedSuppliersContribution: number;
    codeOfConductContribution: number;
    documentedPoliciesContribution: number;
    grievanceMechanismContribution: number;
    incidentPenaltyDeduction: number;
  };
  rawMetrics: {
    auditedSuppliersRatio: number;
    codeOfConductCoverage: number;
    documentedPoliciesScore: number;
    grievanceMechanismScore: number;
    incidentCount: number;
  };
  supplyChainNarrative: string | undefined;
}

/**
 * Builds the user-turn message for the P-003 LLM call.
 * Injects quantitative context and the company narrative into a structured
 * template so the model has all facts needed for a grounded assessment.
 */
export function buildP003UserPrompt(input: P003UserPromptInput): string {
  const narrativeSection =
    input.supplyChainNarrative && input.supplyChainNarrative.trim().length > 0
      ? `## Company Supply Chain Narrative\n\n${input.supplyChainNarrative.trim()}`
      : "## Company Supply Chain Narrative\n\n*No narrative was provided. Base your assessment on quantitative data only and assign an adjustment of 0.*";

  const auditedPct = (input.rawMetrics.auditedSuppliersRatio * 100).toFixed(1);
  const cocPct = (input.rawMetrics.codeOfConductCoverage * 100).toFixed(1);
  const policiesScore = (input.rawMetrics.documentedPoliciesScore * 100).toFixed(1);
  const grievanceScore = (input.rawMetrics.grievanceMechanismScore * 100).toFixed(1);

  return `## Assessment Request

Company: **${input.companyName}**
Reporting Year: **${String(input.reportingYear)}**

---

## Quantitative Base Score: ${input.quantitativeBaseScore.toFixed(2)} / 100

### Raw Metrics

| Metric | Value | Weight |
|---|---|---|
| Audited Suppliers Ratio | ${auditedPct}% of tier-1 suppliers | 30% |
| Code of Conduct Coverage | ${cocPct}% of supply chain | 25% |
| Documented Policies Score | ${policiesScore}/100 | 20% |
| Grievance Mechanism Score | ${grievanceScore}/100 | 15% |
| Labor Incident Count | ${String(input.rawMetrics.incidentCount)} incidents (penalty deduction) | 10% |

### Component Contributions to Base Score

| Component | Points Contributed |
|---|---|
| Audited Suppliers | +${input.componentScores.auditedSuppliersContribution.toFixed(2)} |
| Code of Conduct | +${input.componentScores.codeOfConductContribution.toFixed(2)} |
| Documented Policies | +${input.componentScores.documentedPoliciesContribution.toFixed(2)} |
| Grievance Mechanism | +${input.componentScores.grievanceMechanismContribution.toFixed(2)} |
| Incident Penalty | −${input.componentScores.incidentPenaltyDeduction.toFixed(2)} |
| **Base Score Total** | **${input.quantitativeBaseScore.toFixed(2)}** |

---

${narrativeSection}

---

Based on the above information, provide your qualitative adjustment and structured assessment.`;
}
