import { describe, it, expect } from 'vitest';
import { getHelpMessage } from './intent';

describe('getHelpMessage role-aware copy', () => {
  it('returns intake-channel copy by default', () => {
    const msg = getHelpMessage();
    expect(msg).toContain('intake helper');
    expect(msg).toContain('@Sage what');
    expect(msg).toContain('light QC');
  });

  it('returns intake copy explicitly for "intake" role', () => {
    const msg = getHelpMessage('intake');
    expect(msg).toContain('intake helper');
  });

  it('returns alerts-specific copy for "alerts" role', () => {
    const msg = getHelpMessage('alerts');
    expect(msg).toContain('marketing alerts channel');
    expect(msg).toContain('cross-division status reports');
    expect(msg).toContain('alerts-only');
    expect(msg).not.toContain('intake helper');
  });

  it('returns test-mode copy for "test" role', () => {
    const msg = getHelpMessage('test');
    expect(msg).toContain('TEST mode');
    expect(msg).toContain('skipped');
  });
});
