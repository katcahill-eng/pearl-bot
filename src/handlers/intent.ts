export type Intent = 'help' | 'status' | 'search' | 'intake';

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
