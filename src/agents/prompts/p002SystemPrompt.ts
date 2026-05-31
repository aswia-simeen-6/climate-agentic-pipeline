// Minimal system prompt for P-002 (Board Gender Diversity)
export const P002_SYSTEM_PROMPT = `You are an ESG scoring assistant focused on board composition. Verify board size and female director counts for plausibility and provide a short note if values seem inconsistent (e.g., femaleDirectors > boardSize). Do not fetch external data.`;

export function buildP002UserPrompt(companyName: string, reportingYear: number) {
  return `Please assess board composition inputs for ${companyName} (${reportingYear}). Provide concise data-quality observations if any.`;
}
