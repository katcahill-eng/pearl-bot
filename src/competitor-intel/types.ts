/**
 * Competitor Intelligence spoke — shared types.
 */

export interface Competitor {
  name: string;
  category: string;
  domain: string;
  tier: number;
  pillars: string[];
  notes: string;
}

export interface Watchlist {
  pillars: string[];
  competitors: Competitor[];
  watch_categories: string[];
  standing_threads: string[];
  ai_visibility_prompts: string[];
  proposed: ProposedCompetitor[];
}

export interface ProposedCompetitor {
  name: string;
  category: string;
  reason: string;
  source?: string;
}

/** One Perplexity-sourced finding about a competitor or theme. */
export interface ResearchFinding {
  subject: string; // competitor name or theme
  headline: string;
  detail: string;
  category: 'news' | 'funding' | 'm&a' | 'product' | 'pricing' | 'partnership' | 'other';
  date?: string;
  sources: string[];
}

/** SEMrush snapshot for one competitor domain. */
export interface SemrushSnapshot {
  domain: string;
  organicKeywords?: number;
  organicTraffic?: number;
  organicCost?: number;
  adwordsKeywords?: number;
  topKeywords?: Array<{ phrase: string; position: number; volume: number; url: string }>;
  error?: string;
}

/** Who shows up when AI engines answer a category question. */
export interface AiVisibilityResult {
  prompt: string;
  engine: string; // 'perplexity' | 'gemini' | ...
  mentionedBrands: string[]; // brands detected in the answer, in order
  pearlMentioned: boolean;
  citationDomains: string[];
}

/** Everything collected in one weekly run, before synthesis. */
export interface WeeklyRawData {
  runDate: string; // YYYY-MM-DD
  findings: ResearchFinding[];
  semrush: SemrushSnapshot[];
  aiVisibility: AiVisibilityResult[];
  proposedCompetitors: ProposedCompetitor[];
}

/** Claude's synthesized output for the board. */
export interface WeeklySynthesis {
  analystTake: string; // one paragraph — the "one thing that matters"
  movements: string[]; // bullet list of what changed vs last week
  threats: string[]; // threats / escalations
  opportunities: string[]; // gaps Pearl can take ground in
  pillarNotes: string; // narrative tied to the 5-pillar frame
  suggestedAdditions: ProposedCompetitor[];
}

/** A material event detected by the daily pulse — worth an immediate alert. */
export interface MaterialEvent {
  competitor: string;
  headline: string;
  category: 'funding' | 'm&a' | 'product' | 'pricing' | 'partnership' | 'coverage' | 'ai-visibility' | 'ranking' | 'other';
  why: string; // why it matters to Pearl
  source: string;
  dedupKey: string; // stable key so we never alert the same thing twice
}

/** A flat row written to the Sheet data layer (one metric, one competitor, one week). */
export interface SheetRow {
  runDate: string;
  competitor: string;
  metric: string;
  value: string | number;
  notes: string;
}
