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
    mondayBoardId: '1',
  },
}));

vi.mock('@anthropic-ai/sdk', () => {
  const mockMessages = vi.fn();
  function MockAnthropic() {
    return { messages: { create: mockMessages } } as any;
  }
  return {
    default: MockAnthropic,
    __mockMessages: mockMessages,
  };
});

import { parseIntakeText, postOpenModalButton } from './intake-modal';
import * as anthropicModule from '@anthropic-ai/sdk';

const mockMessages = (anthropicModule as any).__mockMessages as ReturnType<typeof vi.fn>;

function mockParseResponse(json: object): void {
  mockMessages.mockResolvedValueOnce({
    content: [{ type: 'text', text: JSON.stringify(json) }],
  });
}

describe('parseIntakeText', () => {
  beforeEach(() => {
    mockMessages.mockReset();
  });

  it('extracts requestType, deliverable, audience, and deadline', async () => {
    mockParseResponse({
      requestType: 'webinar',
      deliverable: 'Registration email for the May 12 webinar',
      audience: 'real estate agents',
      deadline: '2026-05-08',
      eventOrProject: null,
      additionalDivisionsImpacted: null,
    });

    const result = await parseIntakeText(
      '<@U123ABC> I need a registration email for the May 12 webinar — agents',
    );

    expect(result.requestType).toBe('webinar');
    expect(result.deliverable).toContain('webinar');
    expect(result.audience).toBe('real estate agents');
    expect(result.deadline).toBe('2026-05-08');
  });

  it('strips the leading bot mention before parsing', async () => {
    mockParseResponse({
      requestType: 'email',
      deliverable: 'Quick edit on welcome email',
      audience: null,
      deadline: null,
      eventOrProject: null,
      additionalDivisionsImpacted: null,
    });

    await parseIntakeText('<@U123ABC> quick edit on welcome email');

    const callArgs = mockMessages.mock.calls[0]?.[0];
    expect(callArgs.messages[0].content).toBe('quick edit on welcome email');
  });

  it('falls back to the original text when parsing fails', async () => {
    mockMessages.mockRejectedValueOnce(new Error('timeout'));

    const result = await parseIntakeText('something marketing-y');
    expect(result.deliverable).toBe('something marketing-y');
  });

  it('handles malformed JSON in the response gracefully', async () => {
    mockMessages.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not json' }],
    });

    const result = await parseIntakeText('do a thing');
    expect(result.deliverable).toBe('do a thing');
  });

  it('strips ```json fences from the model output', async () => {
    mockMessages.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: '```json\n{"requestType":"email","deliverable":"x","audience":null,"deadline":null,"eventOrProject":null,"additionalDivisionsImpacted":null}\n```',
        },
      ],
    });

    const result = await parseIntakeText('email please');
    expect(result.requestType).toBe('email');
  });

  it('drops invalid additionalDivisionsImpacted values', async () => {
    mockParseResponse({
      requestType: null,
      deliverable: 'x',
      audience: null,
      deadline: null,
      eventOrProject: null,
      additionalDivisionsImpacted: ['BD', 'Engineering', 'Product'],
    });

    const result = await parseIntakeText('test');
    expect(result.additionalDivisionsImpacted).toEqual(['BD', 'Product']);
  });

  it('returns empty deliverable for empty input', async () => {
    const result = await parseIntakeText('');
    expect(result.deliverable).toBeNull();
  });
});

describe('postOpenModalButton', () => {
  it('posts a thread reply with an Open request form button', async () => {
    const say = vi.fn().mockResolvedValue(undefined);
    await postOpenModalButton({
      channelId: 'C0B1P92785C',
      threadTs: '1234.5678',
      text: '<@U1> I need a webinar email',
      say,
    });

    expect(say).toHaveBeenCalledTimes(1);
    const args = say.mock.calls[0]?.[0];
    expect(args.thread_ts).toBe('1234.5678');
    expect(args.blocks).toBeDefined();

    const actionsBlock = args.blocks.find((b: any) => b.type === 'actions');
    expect(actionsBlock).toBeDefined();
    const button = actionsBlock.elements[0];
    expect(button.text.text).toBe('Open request form');

    const value = JSON.parse(button.value);
    expect(value.channelId).toBe('C0B1P92785C');
    expect(value.threadTs).toBe('1234.5678');
    expect(value.text).toContain('webinar');
  });

  it('truncates the button value to fit within Slack 2000-char limit', async () => {
    const longText = 'x'.repeat(3000);
    const say = vi.fn().mockResolvedValue(undefined);

    await postOpenModalButton({
      channelId: 'C0B1P92785C',
      threadTs: '1234.5678',
      text: longText,
      say,
    });

    const args = say.mock.calls[0]?.[0];
    const actionsBlock = args.blocks.find((b: any) => b.type === 'actions');
    const button = actionsBlock.elements[0];
    expect(button.value.length).toBeLessThanOrEqual(2000);
  });
});
