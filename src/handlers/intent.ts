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
  /\bbrand\s+colors?\b/i,
  /\bwhere\s+(can\s+i\s+find|do\s+i\s+find|are)\s+(the\s+)?(brand|logo|asset|template)s?\b/i,
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

export function getHelpMessage(channelRole?: 'intake' | 'alerts' | 'test'): string {
  if (channelRole === 'alerts') {
    return [
      "Hey — I'm Sage. This is the marketing alerts channel — I post here when new requests come in and reply with status updates as they progress.",
      '',
      "• *Marketing's reply threads here are private to the team* — I don't listen to anything that isn't @-mentioned. Use those threads for internal coordination.",
      '• *@Sage what\'s BD working on?* or *@Sage show me open Product requests* — cross-division status reports.',
      "• *@Sage what's our logo?* — logos, colors, fonts, brand guidelines, email signature, and more.",
      "• *@Sage I need to talk to marketing* — I'll share a link to schedule time.",
      "• *@Sage I found a bug* — I'll get it to the marketing team.",
      "• *@Sage I have a feature idea* — I'll pass your suggestion along.",
      '',
      'To *file* a new request, head to your division\'s `#mktg_{division}_requests` channel. This channel is alerts-only.',
    ].join('\n');
  }

  if (channelRole === 'test') {
    return [
      "Hey — I'm Sage running in *[TEST mode]*. This channel mirrors the production flow so you can try things out.",
      '',
      "• *@Sage I need [a thing]* — I'll open a request form for you to review.",
      "• *@Sage what's our logo?* — logos, colors, fonts, brand guidelines, email signature, and more.",
      "• *@Sage is this on-brand: [paste copy or document link]* — quick brand-check on a draft.",
      "• *@Sage where's my request?* — status lookup.",
      "• *@Sage I need to talk to marketing* — I'll share a link to schedule time.",
      "• *@Sage I found a bug* — I'll get it to the marketing team.",
      "• *@Sage I have a feature idea* — I'll pass your suggestion along.",
    ].join('\n');
  }

  // Default: intake channel — also covers undefined for backwards
  // compatibility with the v3 mention handler.
  return [
    "Hey — I'm Sage, the marketing team's helper. In this channel:",
    '',
    "• *@Sage I need [a thing]* — I'll open a request form for you to review.",
    "• *@Sage what's our logo?* — logos, brand colors, fonts, tagline, brand guidelines, email signature, or slide template — just ask.",
    "• *@Sage is this on-brand: [paste copy or document link]* — quick brand-check on a draft.",
    "• *@Sage where's my request?* — status lookup from Monday.",
    "• *@Sage I need to talk to marketing* — I'll share a link to schedule time.",
    "• *@Sage I found a bug* — I'll get it to the marketing team.",
      "• *@Sage I have a feature idea* — I'll pass your suggestion along.",
    "• *In an existing request thread:* tag me with what you want to add or change and I'll update the request.",
    '',
    'I only respond when you @mention me — channel chatter without @Sage is ignored.',
  ].join('\n');
}
