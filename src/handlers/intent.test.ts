import { describe, it, expect } from 'vitest';
import { getHelpMessage } from './intent';

describe('getHelpMessage role-aware copy', () => {
  it('returns intake-channel copy by default', () => {
    const msg = getHelpMessage();
    expect(msg).toContain("marketing team's helper");
    expect(msg).toContain('@Sage');
    expect(msg).toContain('request form');
  });

  it('returns intake copy explicitly for "intake" role', () => {
    const msg = getHelpMessage('intake');
    expect(msg).toContain("marketing team's helper");
  });

  it('returns alerts-specific copy for "alerts" role', () => {
    const msg = getHelpMessage('alerts');
    expect(msg).toContain('marketing alerts channel');
    expect(msg).toContain('cross-division status reports');
    expect(msg).toContain('alerts-only');
    expect(msg).not.toContain("marketing team's helper");
  });

  it('returns test-mode copy for "test" role', () => {
    const msg = getHelpMessage('test');
    expect(msg).toContain('TEST mode');
    expect(msg).toContain('try things out');
  });

  it('uses everyday "request form" instead of "modal"', () => {
    expect(getHelpMessage('intake')).not.toContain('modal');
    expect(getHelpMessage('test')).not.toContain('modal');
  });

  it('does not promise pre-fill (delight, not expectation)', () => {
    expect(getHelpMessage('intake')).not.toContain('pre-fill');
    expect(getHelpMessage('test')).not.toContain('pre-fill');
  });
});
