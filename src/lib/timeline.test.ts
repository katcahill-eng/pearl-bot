import { describe, it, expect } from 'vitest';
import { generateProductionTimeline } from './timeline';
import type { CollectedData } from './conversation';

function makeData(overrides: Partial<CollectedData> = {}): Partial<CollectedData> {
  return {
    due_date: 'August 1',
    due_date_parsed: '2026-08-01',
    context_background: '',
    deliverables: [],
    ...overrides,
  };
}

describe('generateProductionTimeline', () => {
  it('returns null when no due_date_parsed', () => {
    expect(generateProductionTimeline({})).toBeNull();
    expect(generateProductionTimeline({ due_date_parsed: null })).toBeNull();
  });

  it('returns null for invalid date', () => {
    expect(generateProductionTimeline({ due_date_parsed: 'not-a-date' })).toBeNull();
  });

  it('generates a timeline with phase headers for webinar', () => {
    const result = generateProductionTimeline(makeData({
      context_background: 'We are hosting a webinar on cybersecurity',
    }));
    expect(result).not.toBeNull();
    expect(result).toContain('Project kick-off');
    expect(result).toContain('Marketing creates');
    expect(result).toContain('Your review & approval');
    expect(result).toContain('Target date');
    expect(result).toContain('August 1');
  });

  it('generates webinar+ads timeline when ads mentioned', () => {
    const result = generateProductionTimeline(makeData({
      context_background: 'webinar with digital ads campaign',
    }));
    expect(result).toContain('Ad creative');
    expect(result).toContain('Go live');
  });

  it('generates conference timeline', () => {
    const result = generateProductionTimeline(makeData({
      context_background: 'We are attending AHR Expo conference',
    }));
    expect(result).toContain('Booth collateral');
    expect(result).toContain('Conference presentation slides');
  });

  it('generates dinner timeline', () => {
    const result = generateProductionTimeline(makeData({
      context_background: 'Customer insider dinner event',
    }));
    expect(result).toContain('Invitation design');
    expect(result).toContain('Invitations sent');
  });

  it('generates quick timeline for simple deliverables', () => {
    const result = generateProductionTimeline(makeData({
      deliverables: ['email template', 'social post'],
    }));
    expect(result).toContain('Asset creation');
    expect(result).toContain('Review & approve');
    // Quick timelines should NOT have "Go live" phase
    expect(result).not.toContain('Go live');
  });

  it('generates default timeline when no type detected', () => {
    const result = generateProductionTimeline(makeData({
      context_background: 'General marketing support needed',
    }));
    expect(result).toContain('Content creation & asset development');
    expect(result).toContain('Final approval');
  });

  it('warns about past dates', () => {
    const result = generateProductionTimeline(makeData({
      due_date_parsed: '2024-01-01', // in the past
      due_date: 'January 1, 2024',
    }));
    expect(result).toContain(':warning:');
    expect(result).toContain('tight');
  });

  it('uses user date label in header', () => {
    const result = generateProductionTimeline(makeData({
      due_date: 'end of Q3',
      due_date_parsed: '2026-09-30',
    }));
    expect(result).toContain('end of Q3');
  });
});
