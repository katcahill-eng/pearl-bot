import { describe, it, expect, vi } from 'vitest';

vi.mock('./config', () => ({
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

import { diffSnapshots } from './monday-poller';

describe('diffSnapshots', () => {
  it('emits no events when nothing changed', () => {
    const snap = { status: 'New', due_date: '2026-05-12', owner: 'April' };
    expect(diffSnapshots(snap, snap)).toEqual([]);
  });

  it('emits status_change when status differs', () => {
    const events = diffSnapshots(
      { status: 'New', due_date: '2026-05-12' },
      { status: 'Working on it', due_date: '2026-05-12' },
    );
    expect(events).toContainEqual({
      kind: 'status_change',
      oldStatus: 'New',
      newStatus: 'Working on it',
    });
  });

  it('emits status_change with null oldStatus when prev is missing', () => {
    const events = diffSnapshots(undefined, { status: 'Stuck' });
    expect(events).toContainEqual({
      kind: 'status_change',
      oldStatus: null,
      newStatus: 'Stuck',
    });
  });

  it('emits due_date_changed when due_date differs', () => {
    const events = diffSnapshots(
      { due_date: '2026-05-12' },
      { due_date: '2026-05-20' },
    );
    expect(events).toContainEqual({
      kind: 'due_date_changed',
      newDate: '2026-05-20',
    });
  });

  it('emits owner_changed when owner differs', () => {
    const events = diffSnapshots(
      { owner: 'April' },
      { owner: 'Sean' },
    );
    expect(events).toContainEqual({
      kind: 'owner_changed',
      ownerName: 'Sean',
    });
  });

  it('emits additional_divisions_changed when set differs', () => {
    const events = diffSnapshots(
      { additional_divisions: ['BD'] },
      { additional_divisions: ['BD', 'P2'] },
    );
    expect(events).toContainEqual({
      kind: 'additional_divisions_changed',
      divisions: ['BD', 'P2'],
    });
  });

  it('emits multiple events in one tick when many fields change', () => {
    const events = diffSnapshots(
      { status: 'New', owner: 'April' },
      { status: 'Working on it', owner: 'Sean' },
    );
    expect(events.length).toBe(2);
  });
});
