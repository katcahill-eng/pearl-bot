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
  /\b(give|send|share|get)\s+(me\s+)?(the|our|pearl('?s)?)\s+logo/i,
  /\bneed\s+the\s+(pearl\s+)?logo\b/i,
  /\bpearl\s+logo\b/i,
  /\bour\s+logo\b/i,
  /\bbrand\s+guidelines?\b/i,
  /\bstyle\s+guide\b/i,
  /\bbrand\s+fonts?\b/i,
  /\b(give|send|share|get)\s+(me\s+)?(the|our)\s+(brand\s+)?(colou?rs?|fonts?|guidelines?)\b/i,
  /\bbrand\s+(assets?|resources?|kit)\b/i,
  /\bwhat\s+(are|is)\s+our\s+(brand|colou?r|font|logo)/i,
  /\btagline\b/i,
  /\bwhat\s+(are|is)\s+our\s+(slogan|motto)\b/i,
  /\b(slide|presentation)\s+template\b/i,
  /\bmaster\s+(slide|deck|template)\b/i,
  /\bemail\s+signature\b/i,
];

// Only match explicit help-only messages (not "I need help with X")
const HELP_PATTERNS = [
  /^\s*help\s*$/i,
  /\bwhat\s+can\s+you\s+do\b/i,
  /\bcapabilities\b/i,
  /\bhow\s+(can|do)\s+(you|I)\s+(help|use)\b/i,
  /\bhow\s+do(es)?\s+(this|the\s+bot)\s+work\b/i,
  /\bwhat\s+do\s+you\s+(do|offer|provide)\b/i,
  /\bwhat\s+(services?|options?)\b.*\b(available|offer|have)\b/i,
  /\bwhat\s+(are|is)\s+your\s+(services?|features?|options?)\b/i,
  /^\s*menu\s*$/i,
  /^\s*options\s*$/i,
  /^\s*commands?\s*$/i,
  /\bshow\s+me\s+what\s+you\s+can\b/i,
  /\bwhat\s+are\s+you\b/i,
  /\bwho\s+are\s+you\b/i,
  /\bget\s+started\b/i,
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
    "Hey there! I'm MarcomsBot, the marketing team's intake assistant. Here's what I can help with:",
    '',
    '*Brand resources* — just ask:',
    '• "What are our brand colors?" — hex codes and usage',
    '• "Where are the logos?" — logo files, app logos, tagline logos, and badges',
    '• "What\'s our brand font?" — font and weight info',
    '• "Brand guidelines" — links to guidelines, templates, and brand assets',
    '• "Where\'s the slide template?" — how to find the master deck in Google Slides',
    '• "What\'s our tagline?"',
    '',
    '*Project info:*',
    '• "Status of [project name]" — check on a project\'s progress',
    '• "Find the brief for [project name]" — get links to briefs and folders',
    '',
    '*Submit a request:*',
    "• Just tell me what you need and I'll walk you through a few quick questions to get your request to the right people.",
  ].join('\n');
}
