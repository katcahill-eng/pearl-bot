import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/config', () => ({
  config: {
    anthropicApiKey: 'test',
    slackBotToken: 'test',
    slackAppToken: 'test',
    slackSigningSecret: 'test',
    slackMarketingChannelId: 'C0',
    googleServiceAccountJson: '{}',
    googleProjectsFolderId: 'test',
    mondayApiToken: 'test',
    marketingLeadSlackId: 'U0',
    mondayBoardId: '1',
  },
}));

import { isPubBound, extractQCContent, formatLightQCResult } from './light-qc';
import type { QCResult } from '../lib/qc-runner';

describe('isPubBound', () => {
  it('detects "for publication"', () => {
    expect(isPubBound('Is this for publication: Pearl makes home performance...')).toBe(true);
  });

  it('detects "going live"', () => {
    expect(isPubBound('@Sage check this — going live tomorrow')).toBe(true);
  });

  it('detects "shipping today"', () => {
    expect(isPubBound('shipping today, please QC')).toBe(true);
  });

  it('detects "pre-launch"', () => {
    expect(isPubBound('pre-launch copy review needed')).toBe(true);
  });

  it('returns false for benign QC asks', () => {
    expect(isPubBound('is this on-brand: Pearl scores homes')).toBe(false);
    expect(isPubBound('quick check on this draft please')).toBe(false);
  });
});

describe('extractQCContent', () => {
  it('strips the leading bot mention', () => {
    expect(extractQCContent('<@U123ABC> Pearl scores homes')).toBe('Pearl scores homes');
  });

  it('strips "is this on-brand:" preamble', () => {
    expect(extractQCContent('is this on-brand: Pearl scores homes')).toBe('Pearl scores homes');
  });

  it('strips "is this on brand:" with space variant', () => {
    expect(extractQCContent('is this on brand: Pearl scores homes')).toBe('Pearl scores homes');
  });

  it('strips a leading "qc:" prefix', () => {
    expect(extractQCContent('qc: Pearl scores homes')).toBe('Pearl scores homes');
  });

  it('strips both bot mention and preamble', () => {
    expect(
      extractQCContent('<@U123ABC> is this on-brand: Pearl scores homes'),
    ).toBe('Pearl scores homes');
  });

  it('returns the raw content when no preamble', () => {
    expect(extractQCContent('Pearl scores homes on physical attributes')).toBe(
      'Pearl scores homes on physical attributes',
    );
  });
});

describe('formatLightQCResult', () => {
  const mkResult = (overrides: Partial<QCResult> = {}): QCResult => ({
    rawOutput: '',
    criticalIssues: [],
    importantIssues: [],
    minorIssues: [],
    positioningStressTest: '',
    bunnyDetection: '',
    brandEssenceToneCheck: '',
    dataProvenanceAudit: '',
    overallAssessment: 'Looks good.',
    summary: '',
    grade: 'A',
    ...overrides,
  });

  it('renders grade and summary when no critical issues', () => {
    const result = mkResult({ summary: 'Reads on-brand.' });
    const out = formatLightQCResult(result);
    expect(out).toContain('Grade: A');
    expect(out).toContain('Reads on-brand.');
  });

  it('falls back to overallAssessment when summary is empty', () => {
    const result = mkResult({ overallAssessment: 'No issues.' });
    expect(formatLightQCResult(result)).toContain('No issues.');
  });

  it('lists critical issues with suggested fixes', () => {
    const result = mkResult({
      grade: 'C',
      summary: 'Found issues.',
      criticalIssues: [
        {
          category: 'Pillar',
          originalText: 'foo',
          issue: 'Mentions safety as protection',
          suggestedFix: 'Frame as features in place',
          confidence: 'HIGH',
        },
      ],
    });
    const out = formatLightQCResult(result);
    expect(out).toContain('Critical issues:');
    expect(out).toContain('Mentions safety as protection');
    expect(out).toContain('→ Frame as features in place');
  });

  it('truncates critical issues to 5 with a "more" footer', () => {
    const result = mkResult({
      grade: 'D',
      summary: 'Many issues.',
      criticalIssues: Array.from({ length: 7 }, (_, i) => ({
        category: 'X',
        originalText: '',
        issue: `Issue ${i}`,
        suggestedFix: '',
        confidence: 'HIGH' as const,
      })),
    });
    const out = formatLightQCResult(result);
    expect(out).toMatch(/\+\s*2\s+more/);
  });

  it('shows important issues only when no critical issues', () => {
    const result = mkResult({
      summary: 'Mostly good.',
      importantIssues: [
        {
          category: 'Tone',
          originalText: '',
          issue: 'Could be more confident',
          suggestedFix: '',
          confidence: 'MEDIUM',
        },
      ],
    });
    const out = formatLightQCResult(result);
    expect(out).toContain('Worth checking:');
    expect(out).toContain('Could be more confident');
  });
});
