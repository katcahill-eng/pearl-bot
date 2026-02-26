import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectTopic, handleQuickInfo } from './quick-info';

// Mock the brand-info module so we don't read the filesystem
vi.mock('../lib/brand-info', () => ({
  getBrandInfo: () => ({
    colors: [
      { name: 'Navy', hex: '#002B5C', usage: 'Primary' },
      { name: 'Teal', hex: '#00A8A8', usage: 'Accent' },
    ],
    logos: [
      { label: 'Primary Logo', url: 'https://drive.google.com/logo' },
    ],
    guidelines: [
      { label: 'Brand Guide', url: 'https://drive.google.com/guide' },
    ],
    fonts: [
      { usage: 'Headings', font: 'Montserrat', notes: 'Bold' },
    ],
  }),
}));

describe('detectTopic', () => {
  it('detects colors topic', () => {
    expect(detectTopic('what are our brand colors')).toBe('colors');
    expect(detectTopic('color palette')).toBe('colors');
    expect(detectTopic('hex codes')).toBe('colors');
    expect(detectTopic('brand colours')).toBe('colors');
  });

  it('detects logos topic', () => {
    expect(detectTopic('where are the logos')).toBe('logos');
    expect(detectTopic('brand logo')).toBe('logos');
    expect(detectTopic('logo files')).toBe('logos');
  });

  it('detects guidelines topic', () => {
    expect(detectTopic('brand guidelines')).toBe('guidelines');
    expect(detectTopic('style guide')).toBe('guidelines');
  });

  it('detects fonts topic', () => {
    expect(detectTopic('brand fonts')).toBe('fonts');
    expect(detectTopic('typography')).toBe('fonts');
  });

  it('falls back to all for generic brand queries', () => {
    expect(detectTopic('brand resources')).toBe('all');
    expect(detectTopic('brand kit')).toBe('all');
    expect(detectTopic('brand assets')).toBe('all');
  });

  it('strips bot mentions before detecting', () => {
    expect(detectTopic('<@U12345> brand colors')).toBe('colors');
  });
});

describe('handleQuickInfo', () => {
  let say: any;

  beforeEach(() => {
    say = vi.fn().mockResolvedValue(undefined);
  });

  it('responds with colors when topic is colors', async () => {
    await handleQuickInfo({ text: 'brand colors', threadTs: 'ts1', say });

    expect(say).toHaveBeenCalledOnce();
    const msg = say.mock.calls[0][0];
    expect(msg.text).toContain('Brand Colors');
    expect(msg.text).toContain('#002B5C');
    expect(msg.text).toContain('Navy');
    expect(msg.thread_ts).toBe('ts1');
  });

  it('responds with logos when topic is logos', async () => {
    await handleQuickInfo({ text: 'where are the logos', threadTs: 'ts1', say });

    const msg = say.mock.calls[0][0];
    expect(msg.text).toContain('Logo Files');
    expect(msg.text).toContain('Primary Logo');
  });

  it('responds with guidelines when topic is guidelines', async () => {
    await handleQuickInfo({ text: 'brand guidelines', threadTs: 'ts1', say });

    const msg = say.mock.calls[0][0];
    expect(msg.text).toContain('Brand Guidelines');
    expect(msg.text).toContain('Brand Guide');
  });

  it('responds with fonts when topic is fonts', async () => {
    await handleQuickInfo({ text: 'brand fonts', threadTs: 'ts1', say });

    const msg = say.mock.calls[0][0];
    expect(msg.text).toContain('Fonts');
    expect(msg.text).toContain('Montserrat');
  });

  it('responds with all sections for generic brand query', async () => {
    await handleQuickInfo({ text: 'brand assets', threadTs: 'ts1', say });

    const msg = say.mock.calls[0][0];
    expect(msg.text).toContain('Brand Colors');
    expect(msg.text).toContain('Logo Files');
    expect(msg.text).toContain('Brand Guidelines');
    expect(msg.text).toContain('Fonts');
  });

  it('includes footer on every response', async () => {
    await handleQuickInfo({ text: 'brand colors', threadTs: 'ts1', say });

    const msg = say.mock.calls[0][0];
    expect(msg.text).toContain('Need something else?');
    expect(msg.text).toContain('help');
  });
});
