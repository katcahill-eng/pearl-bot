import { describe, it, expect } from 'vitest';
import { formatItemAttribution } from './format-monday-item';

describe('formatItemAttribution', () => {
  it('formats a normal request with name and date', () => {
    const result = formatItemAttribution({
      requesterName: 'Casey',
      requestedDate: new Date('2026-04-19T15:00:00Z'),
    });
    expect(result).toBe('Requested by Casey on Apr 19');
  });

  it('appends "requesting for" suffix when proxy field is set', () => {
    const result = formatItemAttribution({
      requesterName: 'Casey',
      requestedDate: new Date('2026-04-19T15:00:00Z'),
      requestingForName: 'Sean',
    });
    expect(result).toBe('Requested by Casey on Apr 19 · requesting for Sean');
  });

  it('renders graceful fallback when requester is null', () => {
    const result = formatItemAttribution({
      requesterName: null,
      requestedDate: new Date('2026-04-19T15:00:00Z'),
    });
    expect(result).toBe('Requested Apr 19 · requester not on file');
  });

  it('ignores "requesting for" when requester is null', () => {
    const result = formatItemAttribution({
      requesterName: null,
      requestedDate: new Date('2026-04-19T15:00:00Z'),
      requestingForName: 'Sean',
    });
    expect(result).toBe('Requested Apr 19 · requester not on file');
  });

  it('accepts an ISO date string for requestedDate', () => {
    const result = formatItemAttribution({
      requesterName: 'Casey',
      requestedDate: '2026-04-19T15:00:00Z',
    });
    expect(result).toBe('Requested by Casey on Apr 19');
  });

  it('handles invalid date input gracefully', () => {
    const result = formatItemAttribution({
      requesterName: 'Casey',
      requestedDate: 'not a real date',
    });
    expect(result).toBe('Requested by Casey on unknown date');
  });

  it('treats empty requestingForName as absent', () => {
    const result = formatItemAttribution({
      requesterName: 'Casey',
      requestedDate: new Date('2026-04-19T15:00:00Z'),
      requestingForName: '',
    });
    expect(result).toBe('Requested by Casey on Apr 19');
  });
});
