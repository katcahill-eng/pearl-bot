export type Intent = 'greeting' | 'help' | 'status' | 'search' | 'intake';

const STATUS_PATTERNS = [
  /\bstatus\s+of\b/i,
  /\bwhere\s+are\s+we\s+on\b/i,
  /\bupdate\s+on\b/i,
  /\bstatus\b/i,
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

const HELP_PATTERNS = [
  /\bhelp\b/i,
  /\bwhat\s+can\s+you\s+do\b/i,
  /\bcapabilities\b/i,
];

function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

export function detectIntent(rawText: string): Intent {
  const text = stripMention(rawText);

  if (!text || text.length === 0) {
    return 'greeting';
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

export function getGreetingMessage(): string {
  return [
    "Hey there! :wave: I'm MarcomsBot, the marketing intake assistant.",
    '',
    'I can help you submit a marketing request. How would you like to get started?',
    '',
    '1. *Chat with me* — I\'ll ask a few questions and set everything up',
    '2. *Fill out the form* — If you prefer a structured form instead',
    '',
    'Just reply with `1` to chat or `2` for the form link.',
  ].join('\n');
}

export function getHelpMessage(): string {
  return [
    ":bulb: *Here's what I can help with:*",
    '',
    '• *Submit a request* — Tell me about your marketing need and I\'ll create a brief, Drive folder, and Monday.com task',
    '• *Check status* — Ask "status of [project name]" to see where a request stands',
    '• *Find a brief* — Ask "find the brief for [project name]" to get links',
    '',
    'To start a new request, just describe what you need!',
  ].join('\n');
}
