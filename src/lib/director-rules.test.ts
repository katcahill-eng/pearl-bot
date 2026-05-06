import { describe, it, expect, beforeEach } from 'vitest';
import { matchRecommendations, _resetCacheForTesting } from './director-rules';

describe('matchRecommendations', () => {
  beforeEach(() => {
    _resetCacheForTesting();
  });

  it('returns the webinar recommendations for a webinar request', () => {
    const result = matchRecommendations({
      requestType: 'webinar',
      deliverable: 'I need a webinar for May 12',
    });
    const names = result.map((r) => r.name);
    expect(names).toContain('webinar-platform');
    expect(names).toContain('registration-page');
    expect(names).toContain('social-promo');
    expect(names).toContain('slide-deck-review');
    // Marketing reviews division content — doesn't draft division-voice
    // emails. These should NOT appear in webinar recommendations.
    expect(names).not.toContain('registration-email');
    expect(names).not.toContain('post-event-followup');
  });

  it('matches conference triggers via the deliverable text', () => {
    const result = matchRecommendations({
      deliverable: 'Support our conference booth at NAR Houston',
    });
    const names = result.map((r) => r.name);
    expect(names).toContain('pre-event-social');
    expect(names).toContain('on-site-graphics');
    expect(names).toContain('booth-collateral');
    expect(names).toContain('post-event-recap');
  });

  it('matches "tradeshow" alias for the conference rule', () => {
    const result = matchRecommendations({ deliverable: 'BPA tradeshow assets' });
    expect(result.some((r) => r.name === 'on-site-graphics')).toBe(true);
  });

  it('matches product-launch triggers', () => {
    const result = matchRecommendations({
      requestType: 'product launch',
      deliverable: 'Pearl Pro launch in June',
    });
    const names = result.map((r) => r.name);
    expect(names).toContain('press-release');
    expect(names).toContain('social-series');
    expect(names).toContain('sales-enablement');
    expect(names).toContain('landing-page-update');
  });

  it('returns empty array for a generic ask with no matching trigger', () => {
    const result = matchRecommendations({
      requestType: 'email',
      deliverable: 'Quick edit on the welcome email',
    });
    expect(result).toEqual([]);
  });

  it('returns empty array for empty parsed fields', () => {
    expect(matchRecommendations({})).toEqual([]);
    expect(
      matchRecommendations({ requestType: '', deliverable: '' }),
    ).toEqual([]);
  });

  it('case-insensitively matches triggers', () => {
    const upper = matchRecommendations({ deliverable: 'WEBINAR for May' });
    const lower = matchRecommendations({ deliverable: 'webinar for may' });
    expect(upper.length).toBe(lower.length);
    expect(upper.length).toBeGreaterThan(0);
  });

  it('caps results at 8 recommendations even when multiple rules match', () => {
    const result = matchRecommendations({
      deliverable: 'Webinar at our conference for the product launch',
    });
    expect(result.length).toBeLessThanOrEqual(8);
  });

  it('attaches the rule reasoning to each recommendation', () => {
    const result = matchRecommendations({ deliverable: 'webinar' });
    expect(result.length).toBeGreaterThan(0);
    for (const rec of result) {
      expect(rec.reasoning).toBeTruthy();
      expect(typeof rec.reasoning).toBe('string');
    }
  });

  it('dedupes recommendations by name across overlapping rule matches', () => {
    const result = matchRecommendations({
      deliverable: 'webinar at the conference',
    });
    const names = result.map((r) => r.name);
    const uniqueNames = new Set(names);
    expect(names.length).toBe(uniqueNames.size);
  });
});
