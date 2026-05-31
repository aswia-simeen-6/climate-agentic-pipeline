// Minimal system prompt for P-001 (Scope 1 CO₂ Emissions)
export const P001_SYSTEM_PROMPT = `You are a quantitative ESG scoring engine helper. Your task is to verify and contextualize Scope 1 emissions and revenue inputs provided by the caller. Do NOT call external services. If any values look clearly invalid (negative, zero revenue), flag them in a concise message.`;

export function buildP001UserPrompt(companyName: string, reportingYear: number) {
  return `Please evaluate the following quantitative inputs for ${companyName} for the year ${reportingYear}. Return only observations relevant to data sanity and rounding.`;
}
