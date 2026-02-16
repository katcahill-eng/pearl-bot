import Anthropic from '@anthropic-ai/sdk';
import {
  getRecentUnrecognizedMessages,
  getConversationMetricsSummary,
  createImprovement,
  cleanOldMetrics,
} from './db';

const client = new Anthropic({ timeout: 60_000 });

const ANALYSIS_PROMPT = `You are an engineer analyzing a Slack intake bot's performance data. The bot collects marketing request information from users through a conversational flow.

You will receive:
1. Messages where the bot failed to extract structured fields from user input
2. Conversation outcome metrics (completions, cancellations, timeouts)

Your job: identify the highest-impact improvements to the bot's extraction logic, prompts, or conversation flow.

Categorize each suggestion as:
- "pattern": A new regex or matching pattern is needed (e.g., the bot doesn't recognize a department name variant)
- "prompt": A question or example text should be adjusted to reduce confusion
- "flow": The conversation design should change (e.g., step ordering, skip logic)
- "bug": Something is broken and needs a code fix

Rules:
- Be specific — include actual regex patterns, prompt text, or code changes where possible
- Limit to 3-5 highest-impact suggestions
- If nothing needs improving, return an empty array
- Focus on patterns that appear multiple times, not one-off oddities

Respond with ONLY a JSON array of objects, no markdown, no code blocks:
[
  {
    "category": "pattern|prompt|flow|bug",
    "summary": "One-line description",
    "details": "Specific fix with code/regex/text changes",
    "evidence": { "messages": ["example user message"], "step": "field_name", "count": 3 }
  }
]

If nothing needs fixing, respond with: []`;

export async function runSelfAnalysis(): Promise<void> {
  console.log('[self-analysis] Starting daily analysis...');

  try {
    const [unrecognized, metrics] = await Promise.all([
      getRecentUnrecognizedMessages(7, 100),
      getConversationMetricsSummary(7),
    ]);

    // Skip if not enough data
    if (metrics.total < 3 && unrecognized.length === 0) {
      console.log(`[self-analysis] Not enough data (${metrics.total} conversations, ${unrecognized.length} unrecognized). Skipping.`);
      return;
    }

    // Build the data payload for Claude
    const dataPayload = JSON.stringify({
      unrecognized_messages: unrecognized.map((m) => ({
        message: m.user_message.substring(0, 200),
        step: m.current_step,
        confidence: m.confidence,
        fields_extracted: m.fields_extracted,
        raw_fallback: m.raw_fallback_used,
      })),
      conversation_metrics: {
        total: metrics.total,
        by_status: metrics.byStatus,
        avg_duration_seconds: metrics.avgDurationSeconds,
        by_classification: metrics.byClassification,
      },
    });

    console.log(`[self-analysis] Sending ${unrecognized.length} unrecognized messages and ${metrics.total} conversation metrics to Claude`);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: ANALYSIS_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Here is the bot's performance data from the last 7 days:\n\n${dataPayload}`,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    let suggestions: {
      category: 'pattern' | 'prompt' | 'flow' | 'bug';
      summary: string;
      details: string;
      evidence?: Record<string, unknown>;
    }[];

    try {
      suggestions = JSON.parse(text);
    } catch {
      console.error('[self-analysis] Failed to parse Claude response as JSON:', text.substring(0, 200));
      return;
    }

    if (!Array.isArray(suggestions)) {
      console.error('[self-analysis] Claude response was not an array');
      return;
    }

    if (suggestions.length === 0) {
      console.log('[self-analysis] No improvements suggested. Bot is performing well.');
      return;
    }

    // Store suggestions
    for (const s of suggestions.slice(0, 5)) {
      const validCategories = ['pattern', 'prompt', 'flow', 'bug'] as const;
      if (!validCategories.includes(s.category as any)) continue;

      await createImprovement({
        category: s.category,
        summary: s.summary,
        details: s.details,
        evidence: s.evidence,
      });
      console.log(`[self-analysis] Created improvement: [${s.category}] ${s.summary}`);
    }

    // Clean up old metrics while we're at it
    const cleaned = await cleanOldMetrics(30);
    if (cleaned > 0) {
      console.log(`[self-analysis] Cleaned ${cleaned} old metric rows`);
    }

    console.log(`[self-analysis] Analysis complete. ${suggestions.length} suggestion(s) stored.`);
  } catch (err) {
    console.error('[self-analysis] Analysis failed:', err);
  }
}
