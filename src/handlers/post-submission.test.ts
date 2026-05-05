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

import { normalizeDate, classifyFollowUp } from './post-submission';

vi.mock('@anthropic-ai/sdk', () => {
  const mockMessages = vi.fn();
  function MockAnthropic() {
    return { messages: { create: mockMessages } } as any;
  }
  return { default: MockAnthropic, __mockMessages: mockMessages };
});

import * as anthropicModule from '@anthropic-ai/sdk';
const mockMessages = (anthropicModule as any).__mockMessages as ReturnType<typeof vi.fn>;

describe('normalizeDate', () => {
  it('passes through ISO format', () => {
    expect(normalizeDate('2026-05-12')).toBe('2026-05-12');
  });

  it('converts M/D/YYYY', () => {
    expect(normalizeDate('5/12/2026')).toBe('2026-05-12');
  });

  it('converts M/D (assumes current year)', () => {
    const out = normalizeDate('5/12');
    const currentYear = new Date().getFullYear();
    expect(out).toBe(`${currentYear}-05-12`);
  });

  it('converts M/D/YY (2000s)', () => {
    expect(normalizeDate('5/12/26')).toBe('2026-05-12');
  });

  it('parses named months', () => {
    expect(normalizeDate('May 12 2026')).toBe('2026-05-12');
  });

  it('returns null for nonsense', () => {
    expect(normalizeDate('not a date')).toBeNull();
  });
});

describe('classifyFollowUp fast-paths', () => {
  it('catches status questions without an LLM call', async () => {
    expect(await classifyFollowUp('where is my request?')).toBe('status_question');
    expect(await classifyFollowUp("what's the status")).toBe('status_question');
    expect(await classifyFollowUp('any update on this')).toBe('status_question');
    expect(mockMessages).not.toHaveBeenCalled();
  });

  it('catches schedule-call asks without an LLM call', async () => {
    mockMessages.mockReset();
    expect(await classifyFollowUp('schedule a call')).toBe('schedule_call');
    expect(await classifyFollowUp('can we have a meeting about this?')).toBe('schedule_call');
    expect(mockMessages).not.toHaveBeenCalled();
  });

  it('falls through to LLM for ambiguous text', async () => {
    mockMessages.mockReset();
    mockMessages.mockResolvedValue({
      content: [{ type: 'text', text: 'add_info' }],
    });
    expect(await classifyFollowUp('here is the brief')).toBe('add_info');
    expect(mockMessages).toHaveBeenCalled();
  });

  it('treats withdraw/cancel as change_scope (no self-service withdraw)', async () => {
    mockMessages.mockReset();
    mockMessages.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'withdraw' }],
    });
    expect(await classifyFollowUp('please withdraw this request')).toBe('change_scope');
  });

  it('defaults to add_info on classifier failure', async () => {
    mockMessages.mockReset();
    mockMessages.mockRejectedValueOnce(new Error('timeout'));
    expect(await classifyFollowUp('vague text')).toBe('add_info');
  });
});
