export type Intent = 'help' | 'quick_info' | 'status' | 'search' | 'intake' | 'document_review';

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

const DOCUMENT_REVIEW_PATTERNS = [
  /\breview\s+(this|a|my|the|our)\s+(doc|document|draft|copy|content|article|blog|post|page|email)/i,
  /\b(doc|document|draft|copy|content|article|blog|post)\s+(review|check|qc|quality)/i,
  /\b(qc|quality\s*check|quality\s*control|quality\s*review)\s+(this|a|my|the|our)/i,
  /\bneed(s)?\s+(a\s+)?(content|copy|document|doc)\s+review/i,
  /\bcheck\s+(this|my|the|our)\s+(doc|document|draft|copy|content)\s+(for|against)/i,
  /\breview\s+against\s+(brand|guidelines|positioning)/i,
  /\bbrand\s+(compliance|review|check)/i,
  /\bcontent\s+qc\b/i,
  /\brun\s+(a\s+)?qc\b/i,
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
  /^\s*(hello|hi|hey|hey there|hi there|howdy)\s*[!.]?\s*$/i,
  /^\s*(yo|sup|what'?s\s*up)\s*[!.]?\s*$/i,
  /^\s*(good\s+(morning|afternoon|evening))\s*[!.]?\s*$/i,
];

function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

export function detectIntent(rawText: string): Intent {
  const text = stripMention(rawText);

  // Empty messages or bare greetings → show help
  if (!text || text.length === 0) {
    return 'help';
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

  // Document review — check before generic intake fallback
  for (const pattern of DOCUMENT_REVIEW_PATTERNS) {
    if (pattern.test(text)) return 'document_review';
  }

  // If message contains a Google Docs link + review-related words
  const hasGoogleDocLink = /docs\.google\.com\/document\/d\//.test(text);
  const hasReviewIntent = /\b(review|check|qc|feedback|look\s+at|look\s+over)\b/i.test(text);
  if (hasGoogleDocLink && hasReviewIntent) return 'document_review';

  return 'intake';
}

export function getHelpMessage(): string {
  return [
    "Hey! I'm MarcomsBot, the marketing team's assistant. Here's what I can help with:",
    '',
    "*Submit a request* — just tell me what you need (conference support, email campaign, one-pager, etc.) and I'll walk you through it",
    '',
    '*Review a document* — share a link to something you\'d like marketing to review for brand consistency, terminology, and positioning',
    '',
    '*Brand resources* — ask me things like "what are our brand colors?" or "where are the logos?"',
    '',
    "_Just tell me what you need and I'll take it from here!_",
  ].join('\n');
}
