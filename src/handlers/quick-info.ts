import type { SayFn } from '@slack/bolt';
import { getBrandInfo, type BrandInfo } from '../lib/brand-info';

type Topic = 'colors' | 'logos' | 'guidelines' | 'fonts' | 'tagline' | 'all';

const FOOTER = '\n_Need something else? Just ask, or say *help* to see what I can do._';

export async function handleQuickInfo(opts: {
  text: string;
  threadTs: string;
  say: SayFn;
}): Promise<void> {
  const { text, threadTs, say } = opts;
  const brandInfo = getBrandInfo();
  const topic = detectTopic(text);
  const response = formatResponse(topic, brandInfo);

  await say({ text: response + FOOTER, thread_ts: threadTs });
}

export function detectTopic(rawText: string): Topic {
  const text = rawText.replace(/<@[A-Z0-9]+>/g, '').trim().toLowerCase();

  if (/\bcolou?rs?\b/.test(text) || /\b(palette|hex)\b/.test(text)) return 'colors';
  if (/\blogos?\b/.test(text)) return 'logos';
  if (/\bguidelines?\b/.test(text) || /\bstyle\s+guide\b/.test(text)) return 'guidelines';
  if (/\bfonts?\b/.test(text) || /\btypography\b/.test(text)) return 'fonts';
  if (/\btagline\b/.test(text) || /\b(slogan|motto)\b/.test(text)) return 'tagline';
  if (/\b(template|master\s+(slide|deck)|email\s+signature)\b/.test(text)) return 'guidelines';

  return 'all';
}

function formatResponse(topic: Topic, info: BrandInfo): string {
  switch (topic) {
    case 'colors':
      return formatColors(info);
    case 'logos':
      return formatLogos(info);
    case 'guidelines':
      return formatGuidelines(info);
    case 'fonts':
      return formatFonts(info);
    case 'tagline':
      return formatTagline();
    case 'all':
      return formatAll(info);
  }
}

function formatColors(info: BrandInfo): string {
  if (info.colors.length === 0) return ':art: No brand colors on file yet.';
  const rows = info.colors.map((c) => `• *${c.name}* \`${c.hex}\` — ${c.usage}`);
  return [':art: *Brand Colors*', '', ...rows].join('\n');
}

function formatLogos(info: BrandInfo): string {
  if (info.logos.length === 0) return ':frame_with_picture: No logo files on file yet.';
  const rows = info.logos.map((l) => `• <${l.url}|${l.label}>`);
  return [':frame_with_picture: *Logo Files*', '', ...rows].join('\n');
}

function formatGuidelines(info: BrandInfo): string {
  if (info.guidelines.length === 0) return ':book: No brand guidelines on file yet.';
  const rows = info.guidelines.map((g) => `• <${g.url}|${g.label}>`);
  return [':book: *Brand Guidelines*', '', ...rows].join('\n');
}

function formatFonts(info: BrandInfo): string {
  if (info.fonts.length === 0) return ':pencil2: No font info on file yet.';
  const rows = info.fonts.map((f) => `• *${f.usage}:* ${f.font} — ${f.notes}`);
  return [':pencil2: *Fonts*', '', ...rows].join('\n');
}

function formatTagline(): string {
  return ':speech_balloon: *Tagline:* "Making Home Performance Matter."';
}

function formatAll(info: BrandInfo): string {
  const sections: string[] = [':sparkles: *Brand Quick Reference*', ''];

  if (info.colors.length > 0) {
    sections.push(formatColors(info), '');
  }
  if (info.logos.length > 0) {
    sections.push(formatLogos(info), '');
  }
  if (info.guidelines.length > 0) {
    sections.push(formatGuidelines(info), '');
  }
  if (info.fonts.length > 0) {
    sections.push(formatFonts(info), '');
  }

  if (sections.length === 2) {
    return ':sparkles: No brand info on file yet.';
  }

  return sections.join('\n');
}
