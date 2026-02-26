import fs from 'fs';
import path from 'path';

// --- Types ---

export interface BrandColor {
  name: string;
  hex: string;
  usage: string;
}

export interface BrandLink {
  label: string;
  url: string;
}

export interface BrandFont {
  usage: string;
  font: string;
  notes: string;
}

export interface BrandInfo {
  colors: BrandColor[];
  logos: BrandLink[];
  guidelines: BrandLink[];
  fonts: BrandFont[];
}

// --- Cache ---

let cached: BrandInfo | null = null;

export function getBrandInfo(): BrandInfo {
  if (cached) return cached;

  const markdown = fs.readFileSync(
    path.join(__dirname, 'knowledge-base.md'),
    'utf-8',
  );

  cached = parseBrandInfo(markdown);
  return cached;
}

// --- Parser ---

export function parseBrandInfo(markdown: string): BrandInfo {
  const section = extractSection(markdown, '## Brand Quick Reference');
  if (!section) {
    return { colors: [], logos: [], guidelines: [], fonts: [] };
  }

  return {
    colors: parseColorTable(extractSection(section, '### Brand Colors')),
    logos: parseLinkTable(extractSection(section, '### Logo Files')),
    guidelines: parseLinkTable(extractSection(section, '### Brand Guidelines')),
    fonts: parseFontTable(extractSection(section, '### Fonts')),
  };
}

function extractSection(markdown: string, heading: string): string | null {
  const level = heading.match(/^#+/)?.[0].length ?? 2;
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `${escapedHeading}\\s*\\n([\\s\\S]*?)(?=\\n#{1,${level}}\\s|$)`,
  );
  const match = markdown.match(pattern);
  return match ? match[1].trim() : null;
}

function parseTableRows(text: string | null): string[][] {
  if (!text) return [];

  const lines = text.split('\n').filter((line) => line.trim().startsWith('|'));
  // Need at least header + separator + one data row
  if (lines.length < 3) return [];

  // Skip header (index 0) and separator (index 1)
  return lines.slice(2).map((line) =>
    line
      .split('|')
      .slice(1, -1) // remove empty first/last from leading/trailing |
      .map((cell) => cell.trim()),
  );
}

function parseColorTable(text: string | null): BrandColor[] {
  return parseTableRows(text)
    .filter((cols) => cols.length >= 3)
    .map(([name, hex, usage]) => ({ name, hex, usage }));
}

function parseLinkTable(text: string | null): BrandLink[] {
  return parseTableRows(text)
    .filter((cols) => cols.length >= 2)
    .map(([label, url]) => ({ label, url }));
}

function parseFontTable(text: string | null): BrandFont[] {
  return parseTableRows(text)
    .filter((cols) => cols.length >= 3)
    .map(([usage, font, notes]) => ({ usage, font, notes }));
}
