import { describe, it, expect } from 'vitest';
import {
  withDisclaimer,
  withDisclaimerBlocks,
  DISCLAIMER_TEXT,
} from './disclaimer';

describe('disclaimer', () => {
  describe('withDisclaimer', () => {
    it('appends the disclaimer footer to a plain-text message', () => {
      const result = withDisclaimer('Our logo lives at https://example.com/logo.png');
      expect(result).toContain('Our logo lives at https://example.com/logo.png');
      expect(result).toContain(DISCLAIMER_TEXT);
    });

    it('separates the message and disclaimer with a blank line', () => {
      const result = withDisclaimer('hello');
      expect(result).toBe(`hello\n\n_${DISCLAIMER_TEXT}_`);
    });

    it('italicizes the disclaimer using mrkdwn underscores', () => {
      const result = withDisclaimer('hello');
      expect(result).toMatch(/_[^_]+_$/);
    });

    it('handles empty input gracefully', () => {
      const result = withDisclaimer('');
      expect(result).toBe(`\n\n_${DISCLAIMER_TEXT}_`);
    });
  });

  describe('withDisclaimerBlocks', () => {
    it('appends a context block with the disclaimer', () => {
      const input = [
        { type: 'section', text: { type: 'mrkdwn', text: 'hello' } },
      ];
      const result = withDisclaimerBlocks(input);
      expect(result).toHaveLength(2);
      expect(result[1]).toEqual({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `_${DISCLAIMER_TEXT}_`,
          },
        ],
      });
    });

    it('preserves the original blocks in order', () => {
      const input = [
        { type: 'section', text: { type: 'mrkdwn', text: 'first' } },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: 'third' } },
      ];
      const result = withDisclaimerBlocks(input);
      expect(result.slice(0, 3)).toEqual(input);
    });

    it('does not mutate the caller array', () => {
      const input = [{ type: 'section', text: { type: 'mrkdwn', text: 'hello' } }];
      const before = [...input];
      withDisclaimerBlocks(input);
      expect(input).toEqual(before);
    });

    it('handles an empty block array', () => {
      const result = withDisclaimerBlocks([]);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('context');
    });
  });

  describe('DISCLAIMER_TEXT', () => {
    it('matches the canonical wording from the PRD', () => {
      expect(DISCLAIMER_TEXT).toContain('AI-generated');
      expect(DISCLAIMER_TEXT).toContain('marketing resource documents');
      expect(DISCLAIMER_TEXT).toContain('@mention me to submit a request');
    });
  });
});
