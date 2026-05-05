import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    mondayBoardId: '18385936612',
  },
}));

import {
  applyChannelDefaults,
  describeSpec,
  formatQueryResult,
  type QuerySpec,
} from './visibility-query';
import { _resetCacheForTesting } from '../lib/division-lookup';

const baseSpec: QuerySpec = {
  scope: 'division',
  division: null,
  statusFilter: null,
  searchTerm: null,
  limit: 10,
};

describe('applyChannelDefaults', () => {
  beforeEach(() => {
    _resetCacheForTesting();
  });

  it('fills division from channel for intake-channel division-scope queries', () => {
    const result = applyChannelDefaults(baseSpec, 'C0B1P92785C', 'intake');
    expect(result.division).toBe('BD');
  });

  it('respects an explicit division override', () => {
    const spec: QuerySpec = { ...baseSpec, division: 'P2' };
    const result = applyChannelDefaults(spec, 'C0B1P92785C', 'intake');
    expect(result.division).toBe('P2');
  });

  it('flips alerts-channel division-scope to pearl-wide when no division specified', () => {
    const result = applyChannelDefaults(baseSpec, 'C0ACWP7PGHE', 'alerts');
    expect(result.scope).toBe('pearl-wide');
  });

  it('does not change self-scope queries', () => {
    const spec: QuerySpec = { ...baseSpec, scope: 'self' };
    const result = applyChannelDefaults(spec, 'C0B1P92785C', 'intake');
    expect(result.scope).toBe('self');
  });
});

describe('describeSpec', () => {
  it('describes a self-scoped query', () => {
    expect(
      describeSpec(
        { scope: 'self', division: null, statusFilter: null, searchTerm: null, limit: 10 },
        'U123',
      ),
    ).toContain('Your requests');
  });

  it('describes a division-scoped query', () => {
    expect(
      describeSpec(
        { scope: 'division', division: 'BD', statusFilter: null, searchTerm: null, limit: 10 },
        'U123',
      ),
    ).toContain('BD requests');
  });

  it('appends status filter detail', () => {
    const desc = describeSpec(
      {
        scope: 'division',
        division: 'BD',
        statusFilter: ['Stuck'],
        searchTerm: null,
        limit: 10,
      },
      'U123',
    );
    expect(desc).toContain('Stuck');
  });
});

describe('formatQueryResult', () => {
  it('renders empty results gracefully', () => {
    const out = formatQueryResult(
      { scope: 'division', division: 'BD', statusFilter: null, searchTerm: null, limit: 10 },
      [],
      0,
      new Date('2026-04-23'),
    );
    expect(out).toContain('Open BD requests');
    expect(out).toContain('No matching items');
  });

  it('renders item list with attribution and status', () => {
    const items = [
      {
        id: '1',
        name: 'Webinar registration email',
        url: 'https://example.com/1',
        requesterName: 'Casey',
        requestingForName: null,
        requestedDate: new Date('2026-04-19'),
        status: 'In Progress',
        division: 'BD',
        owner: 'April',
      },
    ];
    const out = formatQueryResult(
      { scope: 'division', division: 'BD', statusFilter: null, searchTerm: null, limit: 10 },
      items,
      1,
      new Date('2026-04-23'),
    );
    expect(out).toContain('Webinar registration email');
    expect(out).toContain('*In Progress*');
    expect(out).toContain('April assigned');
    expect(out).toContain('Casey');
  });

  it('caps inline display at the requested limit', () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      id: String(i),
      name: `Item ${i}`,
      url: 'https://example.com',
      requesterName: 'X',
      requestingForName: null,
      requestedDate: new Date('2026-04-01'),
      status: 'New',
      division: 'BD',
      owner: null,
    }));
    const out = formatQueryResult(
      { scope: 'division', division: 'BD', statusFilter: null, searchTerm: null, limit: 5 },
      items,
      15,
      new Date('2026-04-23'),
    );
    expect(out).toContain('Item 0');
    expect(out).toContain('Item 4');
    expect(out).not.toContain('Item 5');
    expect(out).toContain('15 open');
    expect(out).toContain('showing 5');
  });

  it('always includes the Monday board link as a footer', () => {
    const out = formatQueryResult(
      { scope: 'self', division: null, statusFilter: null, searchTerm: null, limit: 10 },
      [],
      0,
      new Date('2026-04-23'),
    );
    expect(out).toContain('See full board');
    expect(out).toContain('monday.com');
  });
});
