import { describe, it, expect } from 'vitest';
import { parseBrandInfo } from './brand-info';

const SAMPLE_MARKDOWN = `
# Pearl Marketing Knowledge Base

## Request Types

Some content here.

## Brand Quick Reference

### Brand Colors

| Name | Hex | Usage |
|------|-----|-------|
| Navy | #002B5C | Primary |
| Teal | #00A8A8 | Accent |

### Logo Files

| Label | Link |
|-------|------|
| Primary Logo | https://drive.google.com/logo |
| White Logo | https://drive.google.com/white-logo |

### Brand Guidelines

| Label | Link |
|-------|------|
| Brand Guide | https://drive.google.com/guide |

### Fonts

| Usage | Font | Notes |
|-------|------|-------|
| Headings | Montserrat | Bold |
| Body | Open Sans | Regular |
`;

describe('parseBrandInfo', () => {
  it('parses colors from markdown table', () => {
    const info = parseBrandInfo(SAMPLE_MARKDOWN);
    expect(info.colors).toEqual([
      { name: 'Navy', hex: '#002B5C', usage: 'Primary' },
      { name: 'Teal', hex: '#00A8A8', usage: 'Accent' },
    ]);
  });

  it('parses logo links from markdown table', () => {
    const info = parseBrandInfo(SAMPLE_MARKDOWN);
    expect(info.logos).toEqual([
      { label: 'Primary Logo', url: 'https://drive.google.com/logo' },
      { label: 'White Logo', url: 'https://drive.google.com/white-logo' },
    ]);
  });

  it('parses guidelines from markdown table', () => {
    const info = parseBrandInfo(SAMPLE_MARKDOWN);
    expect(info.guidelines).toEqual([
      { label: 'Brand Guide', url: 'https://drive.google.com/guide' },
    ]);
  });

  it('parses fonts from markdown table', () => {
    const info = parseBrandInfo(SAMPLE_MARKDOWN);
    expect(info.fonts).toEqual([
      { usage: 'Headings', font: 'Montserrat', notes: 'Bold' },
      { usage: 'Body', font: 'Open Sans', notes: 'Regular' },
    ]);
  });

  it('returns empty arrays for missing Brand Quick Reference section', () => {
    const info = parseBrandInfo('# No brand section here\n\nJust some content.');
    expect(info.colors).toEqual([]);
    expect(info.logos).toEqual([]);
    expect(info.guidelines).toEqual([]);
    expect(info.fonts).toEqual([]);
  });

  it('returns empty arrays for empty/malformed tables', () => {
    const info = parseBrandInfo(`
## Brand Quick Reference

### Brand Colors

No table here, just text.

### Logo Files

| Label |
|-------|
`);
    expect(info.colors).toEqual([]);
    expect(info.logos).toEqual([]);
  });
});
