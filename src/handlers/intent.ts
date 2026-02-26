export type Intent = 'help' | 'quick_info' | 'status' | 'search' | 'intake';

const STATUS_PATTERNS = [
  /\bstatus\s+of\b/i,
  /\bwhere\s+are\s+we\s+on\b/i,
  /\bupdate\s+on\b/i,
  /\bwhat'?s\s+the\s+progress\b/i,
];

const SEARCH_PATTERNS = [
  /\bfind\s+the\s+brief\b/i,
  /\blink\s+to\b/i,
  /\bwhere'?s\s+the\b/i,
  /\bfind\b.*\bbrief\b/i,
  /\bfind\b.*\bfolder\b/i,
  /\bfind\b.*\bproject\b/i,
];

export const QUICK_INFO_PATTERNS = [
  /\bbrand\s+colou?rs?\b/i,
  /\bcolou?r\s+(palette|hex|codes?)\b/i,
  /\bwhere\s+(are|is)\s+(the\s+)?logos?\b/i,
  /\bbrand\s+logos?\b/i,
  /\blogo\s+(files?|assets?|downloads?)\b/i,
  /\bbrand\s+guidelines?\b/i,
  /\bstyle\s+guide\b/i,
  /\bbrand\s+fonts?\b/i,
  /\bbrand\s+(assets?|resources?|kit)\b/i,
  /\bwhat\s+(are|is)\s+our\s+(brand|colou?r|font|logo)/i,
];

// Only match explicit help-only messages (not "I need help with X")
const HELP_PATTERNS = [
  /^\s*help\s*$/i,
  /\bwhat\s+can\s+you\s+do\b/i,
  /\bcapabilities\b/i,
];

function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

export function detectIntent(rawText: string): Intent {
  const text = stripMention(rawText);

  // Empty messages or bare greetings → treat as intake (bot will start questions)
  if (!text || text.length === 0) {
    return 'intake';
  }

  for (const pattern of HELP_PATTERNS) {
    if (pattern.test(text)) return 'help';
  }

  for (const pattern of QUICK_INFO_PATTERNS) {
    if (pattern.test(text)) return 'quick_info';
  }

  for (const pattern of STATUS_PATTERNS) {
    if (pattern.test(text)) return 'status';
  }

  for (const pattern of SEARCH_PATTERNS) {
    if (pattern.test(text)) return 'search';
  }

  return 'intake';
}

export function getHelpMessage(): string {
  return [
    "Hey there! I'm MarcomsBot, the marketing team's intake assistant.",
    '',
    "Just tell me what you need help with and I'll walk you through a few quick questions to get your request to the right people.",
  ].join('\n');
}
