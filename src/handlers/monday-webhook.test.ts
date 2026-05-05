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

import { normalizeMondayEvent } from './monday-webhook';

describe('normalizeMondayEvent', () => {
  it('returns null when no event field', () => {
    expect(normalizeMondayEvent({})).toBeNull();
  });

  it('normalizes a status column change', () => {
    const event = normalizeMondayEvent({
      event: {
        type: 'change_column_value',
        columnId: 'status',
        columnTitle: 'Status',
        value: { label: { text: 'Working on it' } },
        previousValue: { label: { text: 'New' } },
      },
    });
    expect(event).toEqual({
      kind: 'status_change',
      oldStatus: 'New',
      newStatus: 'Working on it',
    });
  });

  it('normalizes a status change using textValue fallback', () => {
    const event = normalizeMondayEvent({
      event: {
        columnId: 'status',
        columnTitle: 'Status',
        textValue: 'Stuck',
        previousTextValue: 'New',
      },
    });
    expect(event?.kind).toBe('status_change');
    if (event?.kind === 'status_change') {
      expect(event.newStatus).toBe('Stuck');
      expect(event.oldStatus).toBe('New');
    }
  });

  it('returns null when status change has no new value', () => {
    expect(
      normalizeMondayEvent({
        event: { columnId: 'status', columnTitle: 'Status' },
      }),
    ).toBeNull();
  });

  it('normalizes a due_date column change', () => {
    const event = normalizeMondayEvent({
      event: {
        columnId: 'date',
        columnTitle: 'Due Date',
        value: { date: '2026-05-12' },
      },
    });
    expect(event).toEqual({ kind: 'due_date_changed', newDate: '2026-05-12' });
  });

  it('normalizes an owner change', () => {
    const event = normalizeMondayEvent({
      event: {
        columnTitle: 'Owner',
        columnId: 'person',
        value: { personsAndTeams: [{ id: 1, name: 'April' }] },
      },
    });
    expect(event).toEqual({ kind: 'owner_changed', ownerName: 'April' });
  });

  it('normalizes additional_divisions changes from chosenValues', () => {
    const event = normalizeMondayEvent({
      event: {
        columnId: 'dropdown_mm32cr4w',
        columnTitle: 'Additional Divisions Impacted',
        value: {
          chosenValues: [{ name: 'BD' }, { name: 'P2' }],
        },
      },
    });
    expect(event).toEqual({
      kind: 'additional_divisions_changed',
      divisions: ['BD', 'P2'],
    });
  });

  it('falls back to comma-split textValue for divisions', () => {
    const event = normalizeMondayEvent({
      event: {
        columnId: 'dropdown_mm32cr4w',
        columnTitle: 'Additional Divisions Impacted',
        textValue: 'BD, Product, Marketing',
      },
    });
    if (event?.kind === 'additional_divisions_changed') {
      expect(event.divisions).toEqual(['BD', 'Product', 'Marketing']);
    } else {
      throw new Error('expected additional_divisions_changed');
    }
  });

  it('returns null for unrecognized columns', () => {
    expect(
      normalizeMondayEvent({
        event: {
          columnId: 'random_col',
          columnTitle: 'Random',
          textValue: 'whatever',
        },
      }),
    ).toBeNull();
  });
});
