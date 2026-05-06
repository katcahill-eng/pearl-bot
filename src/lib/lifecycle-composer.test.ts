import { describe, it, expect } from 'vitest';
import { formatThreadReply, formatAlertMirror } from './lifecycle-composer';

describe('formatThreadReply (status_change)', () => {
  it('returns the acceptance message on New → Working on it', () => {
    const out = formatThreadReply(
      {
        kind: 'status_change',
        oldStatus: 'New',
        newStatus: 'Working on it',
      },
      'U123',
    );
    expect(out).toBeTruthy();
    expect(out).toContain('<@U123>');
    expect(out).toContain('marketing has accepted');
    expect(out).toContain('started work');
  });

  it('is silent on Working on it from any other state (e.g. after request_changes)', () => {
    expect(
      formatThreadReply({
        kind: 'status_change',
        oldStatus: 'Pending review',
        newStatus: 'Working on it',
      }),
    ).toBeNull();
  });

  it('fires the More information needed message', () => {
    const out = formatThreadReply(
      {
        kind: 'status_change',
        oldStatus: 'Working on it',
        newStatus: 'More information needed',
      },
      'U123',
    );
    expect(out).toContain('<@U123>');
    expect(out).toContain('marketing has a few questions');
  });

  it('returns null on Pending review (caller composes the multi-block message)', () => {
    expect(
      formatThreadReply({
        kind: 'status_change',
        oldStatus: 'Working on it',
        newStatus: 'Pending review',
      }),
    ).toBeNull();
  });

  it('returns the completed message on Pending review → Completed/Live', () => {
    const out = formatThreadReply({
      kind: 'status_change',
      oldStatus: 'Pending review',
      newStatus: 'Completed/Live',
    });
    expect(out).toContain('approved and complete');
  });

  it('is silent on Stuck (internal-only state)', () => {
    expect(
      formatThreadReply({
        kind: 'status_change',
        oldStatus: 'Working on it',
        newStatus: 'Stuck',
      }),
    ).toBeNull();
  });

  it('is silent on Declined (handled in conversation, never via Sage announcement)', () => {
    expect(
      formatThreadReply({
        kind: 'status_change',
        oldStatus: 'New',
        newStatus: 'Declined',
      }),
    ).toBeNull();
  });
});

describe('formatThreadReply (other event kinds — all silent on requester thread)', () => {
  it('is silent on deliverable_attached (WIP files are organization, not signal)', () => {
    expect(
      formatThreadReply({
        kind: 'deliverable_attached',
        fileUrl: 'https://x',
        fileName: 'wip.pdf',
      }),
    ).toBeNull();
  });

  it('is silent on due_date_changed', () => {
    expect(
      formatThreadReply({ kind: 'due_date_changed', newDate: '2026-05-12' }),
    ).toBeNull();
  });

  it('is silent on owner_changed', () => {
    expect(
      formatThreadReply({ kind: 'owner_changed', ownerName: 'April' }),
    ).toBeNull();
  });

  it('is silent on additional_divisions_changed', () => {
    expect(
      formatThreadReply({
        kind: 'additional_divisions_changed',
        divisions: ['BD', 'P2'],
      }),
    ).toBeNull();
  });
});

describe('formatAlertMirror (marketing-internal coordination thread)', () => {
  it('mirrors a status change tersely', () => {
    expect(
      formatAlertMirror({
        kind: 'status_change',
        oldStatus: 'New',
        newStatus: 'Working on it',
        ownerName: 'April',
      }),
    ).toBe('Status → Working on it (April assigned)');
  });

  it('mirrors silent statuses too — marketing wants visibility on Stuck/Declined', () => {
    expect(
      formatAlertMirror({
        kind: 'status_change',
        oldStatus: 'New',
        newStatus: 'Stuck',
      }),
    ).toBe('Status → Stuck');
    expect(
      formatAlertMirror({
        kind: 'status_change',
        oldStatus: 'New',
        newStatus: 'Declined',
      }),
    ).toBe('Status → Declined');
  });

  it('mirrors due-date, owner, and divisions tersely', () => {
    expect(
      formatAlertMirror({ kind: 'due_date_changed', newDate: '2026-05-12' }),
    ).toBe('Due → 2026-05-12');
    expect(
      formatAlertMirror({ kind: 'owner_changed', ownerName: 'April' }),
    ).toBe('Owner → April');
    expect(
      formatAlertMirror({
        kind: 'additional_divisions_changed',
        divisions: ['BD', 'P2'],
      }),
    ).toContain('BD, P2');
  });

  it('is silent on deliverable_attached (marketing attached the file themselves)', () => {
    expect(
      formatAlertMirror({
        kind: 'deliverable_attached',
        fileUrl: 'https://x',
        fileName: 'wip.pdf',
      }),
    ).toBeNull();
  });
});
