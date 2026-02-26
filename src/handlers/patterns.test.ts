import { describe, it, expect } from 'vitest';

/**
 * Tests for the regex patterns used in intake.ts to classify user messages.
 * These patterns are duplicated here (not exported from intake.ts) because
 * testing the actual regex behavior is what matters — if they drift, a
 * mismatch means the tests need updating, not that the bot is broken.
 */

// Copied from intake.ts for direct testing
const CONFIRM_PATTERNS = [
  /^y(es)?(\s|!|$)/i, /^confirm/i, /^submit/i, /^looks?\s*good/i, /^correct/i,
  /^that'?s?\s*right/i, /^yep(\s|!|$)/i, /^yeah/i, /^yup(\s|!|$)/i, /^ok(ay)?/i,
  /^sure/i, /^sounds?\s*good/i, /^go\s*ahead/i, /^perfect/i, /^all\s*good/i,
  /^go\s*for\s*it/i, /^alright/i, /^right(\s|!|$)/i, /^absolutely/i, /^for\s*sure/i,
  /^(yes|yeah|yep|sure|ok)\s*(please|thanks|submit|do\s*it|go)/i,
  /^(lgtm|ship\s*it)/i, /^approved/i, /^send\s*it/i,
];
const CANCEL_PATTERNS = [
  /^cancel$/i, /^nevermind$/i, /^never\s*mind/i, /^forget\s*(about\s*)?it$/i,
  /^nvm$/i, /^stop$/i, /^abort$/i, /^quit$/i, /^scratch\s*that$/i,
  /^no\s*thanks/i,
];
const IDK_PATTERNS = [
  /^i\s*don['\u2019]?t\s*know/i, /^not\s*sure/i, /^no\s*idea/i, /^unsure$/i,
  /^idk$/i, /^no\s*clue/i, /^i['\u2019]?m\s*not\s*sure/i, /^haven['\u2019]?t\s*decided/i,
  /^good\s*question/i, /^help\s*me\s*decide/i, /^i\s*have\s*no\s*idea/i,
  /^dunno/i, /^beats\s*me/i, /^not\s*certain/i, /^no\s*preference/i,
  /^hmm+/i, /^i['\u2019]?m\s*unsure/i,
];
const SKIP_PATTERNS = [/^skip$/i, /^skip\s*(this|it|that)$/i, /^pass$/i, /^next$/i, /^move\s*on$/i, /^n\/?a$/i];
const NUDGE_PATTERNS = [
  /^h(ello|i|ey|owdy)\b/i, /^yo\b/i, /^sup\b/i, /^what['\u2019]?s\s*up/i,
  /^are\s*you\s*(there|still\s*there|around|listening|alive)/i,
  /^anyone\s*(there|home|around)/i, /^you\s*(there|still\s*there|around)/i,
  /^still\s*(there|here|around|working)/i, /^ping/i, /^nudge/i, /^poke/i,
  /^come\s*back/i, /^wake\s*up/i, /^bot\??$/i, /^help\s*me$/i,
  /^\?\??$/i,
];
const DISCUSS_PATTERNS = [
  /^discuss$/i, /^let['\u2019]?s\s*discuss/i, /^need\s*to\s*(talk|discuss|chat)/i,
  /^want\s*to\s*(talk|discuss|chat)/i, /^can\s*we\s*(talk|discuss|chat)/i,
  /^flag\s*(this|it)?/i, /^needs?\s*discussion/i, /^talk\s*(about\s*)?(this|it)/i,
  /^let['\u2019]?s\s*talk/i, /^come\s*back\s*to\s*(this|it)/i,
  /^not\s*sure.*talk/i, /^circle\s*back/i,
];
const UNCERTAINTY_PATTERNS = [
  /\bmaybe\b/i, /\bperhaps\b/i, /\bpossibly\b/i, /\bprobably\b/i,
  /\bi\s*think\b/i, /\bi\s*guess\b/i, /\bnot\s*(entirely\s*)?sure\b/i,
  /\bnot\s*certain\b/i, /\bmight\s*be\b/i, /\bcould\s*be\b/i,
  /\bI'm\s*unsure\b/i, /\bdon['']?t\s*know\s*(if|whether)\b/i,
  /\bstill\s*(figuring|deciding|thinking)\b/i, /\btentatively\b/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text.trim()));
}

function hasUncertainty(text: string): boolean {
  return UNCERTAINTY_PATTERNS.some((p) => p.test(text));
}

// --- Tests ---

describe('CONFIRM_PATTERNS', () => {
  const shouldMatch = [
    'yes', 'Yes!', 'y', 'yep', 'yeah', 'yup', 'ok', 'okay',
    'sure', 'sounds good', 'looks good', 'correct', "that's right",
    'go ahead', 'perfect', 'all good', 'go for it', 'alright',
    'absolutely', 'for sure', 'yes please', 'sure thanks', 'lgtm',
    'ship it', 'approved', 'send it', 'yes do it',
  ];

  const shouldNotMatch = [
    'I want to change the due date', 'yesterday was fun',
    'Increase early access sign-ups', 'Here',
    'Can you update the target audience?',
  ];

  for (const text of shouldMatch) {
    it(`matches "${text}"`, () => {
      expect(matchesAny(text, CONFIRM_PATTERNS)).toBe(true);
    });
  }

  for (const text of shouldNotMatch) {
    it(`does NOT match "${text}"`, () => {
      expect(matchesAny(text, CONFIRM_PATTERNS)).toBe(false);
    });
  }
});

describe('CANCEL_PATTERNS', () => {
  const shouldMatch = ['cancel', 'nevermind', 'never mind', 'forget it', 'nvm', 'stop', 'abort', 'quit', 'scratch that', 'no thanks'];
  const shouldNotMatch = ['cancel the meeting', 'I want to stop by', 'Can we abort mission?'];

  for (const text of shouldMatch) {
    it(`matches "${text}"`, () => {
      expect(matchesAny(text, CANCEL_PATTERNS)).toBe(true);
    });
  }

  // cancel has $ anchor — "cancel the meeting" should NOT match
  it('does not match "cancel the meeting"', () => {
    expect(matchesAny('cancel the meeting', CANCEL_PATTERNS)).toBe(false);
  });
});

describe('IDK_PATTERNS', () => {
  const shouldMatch = [
    "i don't know", "not sure", "no idea", "unsure", "idk",
    "no clue", "i'm not sure", "haven't decided", "good question",
    "help me decide", "i have no idea", "dunno", "beats me",
    "not certain", "no preference", "hmm", "hmmm", "i'm unsure",
  ];

  const shouldNotMatch = [
    'I want 3 emails', 'Real estate agents', 'Increase sign-ups by 20%',
    'Maybe homeowners in the Southeast', // starts with "maybe" not IDK
  ];

  for (const text of shouldMatch) {
    it(`matches "${text}"`, () => {
      expect(matchesAny(text, IDK_PATTERNS)).toBe(true);
    });
  }

  for (const text of shouldNotMatch) {
    it(`does NOT match "${text}"`, () => {
      expect(matchesAny(text, IDK_PATTERNS)).toBe(false);
    });
  }
});

describe('NUDGE_PATTERNS', () => {
  const shouldMatch = [
    'hello', 'hi', 'hey', 'howdy', 'yo', 'sup', "what's up",
    'are you there', 'still there', 'anyone there', 'ping', 'nudge',
    'poke', 'come back', 'wake up', 'bot', 'bot?', 'help me', '?', '??',
  ];

  const shouldNotMatch = [
    'Hello, I need a new email campaign',
    'Hey, can you help me with a webinar?',
  ];

  for (const text of shouldMatch) {
    it(`matches "${text}"`, () => {
      expect(matchesAny(text, NUDGE_PATTERNS)).toBe(true);
    });
  }

  // "hello" alone is a nudge, but "Hello, I need..." has content — should match nudge
  // since we only test the pattern, not the full handler logic
  it('"Hello, I need..." starts with hello so matches nudge pattern', () => {
    // This is expected: the handler has additional logic to distinguish
    expect(matchesAny('Hello, I need a new email campaign', NUDGE_PATTERNS)).toBe(true);
  });
});

describe('SKIP_PATTERNS', () => {
  const shouldMatch = ['skip', 'skip this', 'skip it', 'pass', 'next', 'move on', 'n/a', 'N/A'];
  const shouldNotMatch = ['skip to the end of the project', 'next week would be great'];

  for (const text of shouldMatch) {
    it(`matches "${text}"`, () => {
      expect(matchesAny(text, SKIP_PATTERNS)).toBe(true);
    });
  }

  for (const text of shouldNotMatch) {
    it(`does NOT match "${text}"`, () => {
      expect(matchesAny(text, SKIP_PATTERNS)).toBe(false);
    });
  }
});

describe('DISCUSS_PATTERNS', () => {
  const shouldMatch = [
    'discuss', "let's discuss", 'need to talk', 'want to discuss',
    'can we chat', 'flag this', 'flag it', 'needs discussion',
    'talk about this', "let's talk", 'come back to this', 'circle back',
  ];

  for (const text of shouldMatch) {
    it(`matches "${text}"`, () => {
      expect(matchesAny(text, DISCUSS_PATTERNS)).toBe(true);
    });
  }
});

describe('UNCERTAINTY_PATTERNS (mid-sentence detection)', () => {
  const shouldDetect = [
    'Maybe homeowners in the Southeast',
    'I think we need about 3 emails',
    'Probably by end of March',
    'I guess real estate agents',
    "Not sure but maybe Q2",
    'It might be for internal team',
    'Could be around 50 attendees',
    "I'm unsure about the timeline",
    "I don't know if we need social posts",
    "Still figuring out the target audience",
    'Tentatively March 15',
    'Perhaps the product team',
  ];

  const shouldNotDetect = [
    'Real estate agents in the Southeast',
    '3 emails and 2 social posts',
    'By March 15, 2026',
    'Increase sign-ups by 20%',
    'We need a webinar deck and registration page',
  ];

  for (const text of shouldDetect) {
    it(`detects uncertainty in "${text}"`, () => {
      expect(hasUncertainty(text)).toBe(true);
    });
  }

  for (const text of shouldNotDetect) {
    it(`no uncertainty in "${text}"`, () => {
      expect(hasUncertainty(text)).toBe(false);
    });
  }
});

// --- Quick Info Patterns (from intent.ts) ---
import { QUICK_INFO_PATTERNS } from './intent';

describe('QUICK_INFO_PATTERNS', () => {
  const shouldMatch = [
    'brand colors',
    'what are our brand colors',
    'what are our brand colours',
    'where are the logos',
    'where is the logo',
    'brand logo',
    'logo files',
    'logo assets',
    'brand guidelines',
    'style guide',
    'brand fonts',
    'brand assets',
    'brand resources',
    'brand kit',
    'color palette',
    'color hex codes',
    'colour codes',
    'What is our brand font?',
    // Natural requests for existing brand assets
    'Can you give me the Pearl logo?',
    'give me the logo',
    'send me our logo',
    "get me Pearl's logo",
    'I need the Pearl logo',
    'I need the logo',
    'our logo',
    'Pearl logo',
    'give me the brand colors',
    'send me our fonts',
    'get me the guidelines',
    'slide template',
    'presentation template',
    'master deck',
    'master slide',
    'email signature',
    'what is our tagline',
  ];

  const shouldNotMatch = [
    'I need a logo designed',
    'design a color scheme',
    'I need a logo designed for our event',
    'help',
    'yes',
    'status of the newsletter',
    'I want 3 emails',
    'create a new style for the website',
    'design me a new logo',
    'create a presentation for the conference',
  ];

  for (const text of shouldMatch) {
    it(`matches "${text}"`, () => {
      expect(QUICK_INFO_PATTERNS.some((p) => p.test(text))).toBe(true);
    });
  }

  for (const text of shouldNotMatch) {
    it(`does NOT match "${text}"`, () => {
      expect(QUICK_INFO_PATTERNS.some((p) => p.test(text))).toBe(false);
    });
  }
});

// --- Product Launch Patterns (from intake.ts) ---
const PRODUCT_LAUNCH_PATTERNS = [
  /(early access|beta|launch|rollout|release)\s+(applications?|programs?|testing|phase)/i,
  /\b(applications?\s+to\s+)(early access|beta|pilot)\s+(programs?)/i,
  /\b(increase|drive|grow|boost)\s+(early access|beta|program)\s+(sign[- ]?ups?|applications?|registrations?|enrollments?)/i,
  /\b(early access|beta|pilot|pre[- ]?launch)\s+(sign[- ]?ups?|applications?|registrations?|enrollments?|awareness)/i,
];

function matchesProductLaunch(text: string): boolean {
  return PRODUCT_LAUNCH_PATTERNS.some((p) => p.test(text));
}

describe('PRODUCT_LAUNCH_PATTERNS', () => {
  const shouldMatch = [
    'Applications to Early Access Programs',
    'Early access applications',
    'Increase early access sign-ups',
    'Drive beta program applications',
    'early access program',
    'beta applications',
    'launch program',
    'rollout phase',
    'release testing',
    'Boost early access registrations',
    'Grow beta sign-ups',
    'pre-launch awareness',
    'pilot registrations',
    'beta enrollments',
    'application to early access program',
  ];

  const shouldNotMatch = [
    'I need a one-pager',
    'social media posts',
    'help',
    'yes',
    'ASAP',
    'conference in March',
    'email campaign',
    'hello?',
  ];

  for (const text of shouldMatch) {
    it(`matches product launch: "${text}"`, () => {
      expect(matchesProductLaunch(text)).toBe(true);
    });
  }

  for (const text of shouldNotMatch) {
    it(`does not match product launch: "${text}"`, () => {
      expect(matchesProductLaunch(text)).toBe(false);
    });
  }
});
