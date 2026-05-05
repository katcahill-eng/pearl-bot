/**
 * Director-brain recommendation engine for Sage v2.
 *
 * Reads src/config/request-patterns.yaml and exposes matchRecommendations,
 * which surfaces contextual suggestions ("you mentioned a webinar — also
 * need email marketing?") for the request modal. The rules file is
 * editable without a deploy; reload happens on file mtime change.
 *
 * Per PRD US-008, matchRecommendations returns up to 8 recommendations
 * (Slack modal cap) ordered by rule priority.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface ParsedRequest {
  requestType?: string | null;
  deliverable?: string | null;
  audience?: string | null;
  eventOrProject?: string | null;
}

export interface Recommendation {
  /** Short label, used as the recommendation's identity (e.g., "registration-email"). */
  name: string;
  /** Default deliverable text used when the recommendation gets checked into a sub-item. */
  deliverable: string;
  /** One-line rationale shown below the checkbox label in the modal. */
  reasoning: string;
}

interface RuleEntry {
  trigger: string | string[];
  suggest: { name: string; deliverable: string }[];
  reasoning: string;
}

interface RulesYaml {
  rules: RuleEntry[];
}

const CONFIG_PATH = path.resolve(__dirname, '../config/request-patterns.yaml');
const MAX_RECOMMENDATIONS = 8;

let cachedRules: RuleEntry[] | null = null;
let cachedMtimeMs: number | null = null;

function loadRules(): RuleEntry[] {
  const stat = fs.statSync(CONFIG_PATH);
  if (cachedRules && cachedMtimeMs === stat.mtimeMs) {
    return cachedRules;
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = yaml.load(raw) as RulesYaml | null;

  if (!parsed || !Array.isArray(parsed.rules)) {
    throw new Error(
      `[director-rules] ${CONFIG_PATH} is missing a top-level 'rules' array`,
    );
  }

  for (const rule of parsed.rules) {
    if (!rule.trigger || !Array.isArray(rule.suggest) || !rule.reasoning) {
      throw new Error(
        `[director-rules] rule missing trigger/suggest/reasoning: ${JSON.stringify(rule)}`,
      );
    }
  }

  cachedRules = parsed.rules;
  cachedMtimeMs = stat.mtimeMs;
  return parsed.rules;
}

/**
 * Match parsedFields against the configured rules and return a deduped
 * list of recommendations (up to MAX_RECOMMENDATIONS).
 *
 * Matching is case-insensitive substring against parsedFields.requestType,
 * parsedFields.deliverable, and parsedFields.eventOrProject — each rule's
 * trigger keyword(s) are checked against the joined haystack.
 */
export function matchRecommendations(
  parsedFields: ParsedRequest,
): Recommendation[] {
  const haystack = [
    parsedFields.requestType ?? '',
    parsedFields.deliverable ?? '',
    parsedFields.eventOrProject ?? '',
  ]
    .join(' ')
    .toLowerCase();

  if (!haystack.trim()) return [];

  const matched: Recommendation[] = [];
  const seenNames = new Set<string>();

  for (const rule of loadRules()) {
    const triggers = Array.isArray(rule.trigger) ? rule.trigger : [rule.trigger];
    const matches = triggers.some((t) => haystack.includes(t.toLowerCase()));
    if (!matches) continue;

    for (const suggestion of rule.suggest) {
      if (seenNames.has(suggestion.name)) continue;
      seenNames.add(suggestion.name);
      matched.push({
        name: suggestion.name,
        deliverable: suggestion.deliverable,
        reasoning: rule.reasoning,
      });
      if (matched.length >= MAX_RECOMMENDATIONS) return matched;
    }
  }

  return matched;
}

/**
 * Test-only: clear the in-memory cache. Used by unit tests that swap
 * out the config between cases.
 */
export function _resetCacheForTesting(): void {
  cachedRules = null;
  cachedMtimeMs = null;
}
