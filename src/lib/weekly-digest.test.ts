import { describe, it, expect, vi } from 'vitest';

vi.mock('./error-tracker', () => ({
  trackError: vi.fn(),
}));

vi.mock('pg', () => {
  function MockPool() {
    return { query: vi.fn() } as any;
  }
  return { Pool: MockPool };
});

import { formatDigest } from './weekly-digest';

describe('formatDigest', () => {
  it('renders all sections when populated', () => {
    const out = formatDigest({
      volumeByType: { webinar: 3, email: 5 },
      volumeByDivision: { BD: 4, P2: 2, Product: 2 },
      totalSubmissions: 8,
      abandonmentPct: 12,
      recommendationAcceptanceByRule: [
        { name: 'registration-email', accepted: 3, offered: 4 },
        { name: 'social-promo', accepted: 1, offered: 4 },
      ],
      topRequesters: [
        { user_id: 'U1', count: 4 },
        { user_id: 'U2', count: 2 },
      ],
      openLoadByDivision: { BD: 6, P2: 3 },
      turnaroundDaysByType: { webinar: 7.2, email: 1.5 },
    });

    expect(out).toContain('Sage Weekly Digest');
    expect(out).toContain('8 submissions');
    expect(out).toContain('webinar: 3');
    expect(out).toContain('email: 5');
    expect(out).toContain('BD: 4');
    expect(out).toContain('12% of modals');
    expect(out).toContain('registration-email: 3/4 = 75%');
    expect(out).toContain('social-promo: 1/4 = 25%');
    expect(out).toContain('<@U1>: 4');
    expect(out).toContain('BD: 6 open');
    expect(out).toContain('webinar: 7.2d');
    expect(out).toContain('email: 1.5d');
  });

  it('handles empty week gracefully', () => {
    const out = formatDigest({
      volumeByType: {},
      volumeByDivision: {},
      totalSubmissions: 0,
      abandonmentPct: 0,
      recommendationAcceptanceByRule: [],
      topRequesters: [],
      openLoadByDivision: {},
      turnaroundDaysByType: {},
    });
    expect(out).toContain('Sage Weekly Digest');
    expect(out).toContain('0 submissions');
    expect(out).toContain("0% of modals");
  });

  it('caps recommendation list at 8 rules', () => {
    const recs = Array.from({ length: 12 }, (_, i) => ({
      name: `rule-${i}`,
      accepted: 1,
      offered: 4,
    }));
    const out = formatDigest({
      volumeByType: {},
      volumeByDivision: {},
      totalSubmissions: 0,
      abandonmentPct: 0,
      recommendationAcceptanceByRule: recs,
      topRequesters: [],
      openLoadByDivision: {},
      turnaroundDaysByType: {},
    });
    const matches = out.match(/rule-\d/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(8);
  });

  it('skips rules with offered=0 (avoids divide-by-zero)', () => {
    const out = formatDigest({
      volumeByType: {},
      volumeByDivision: {},
      totalSubmissions: 0,
      abandonmentPct: 0,
      recommendationAcceptanceByRule: [
        { name: 'never-offered', accepted: 0, offered: 0 },
        { name: 'real', accepted: 1, offered: 2 },
      ],
      topRequesters: [],
      openLoadByDivision: {},
      turnaroundDaysByType: {},
    });
    expect(out).not.toContain('never-offered');
    expect(out).toContain('real:');
  });
});
