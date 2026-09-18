import { describe, it, expect, beforeEach, vi } from 'vitest';

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

import { decideRoute, shouldHandleAmbientMessage } from './channel-router';
import { _resetCacheForTesting } from '../lib/division-lookup';

describe('channel-router decideRoute', () => {
  beforeEach(() => {
    _resetCacheForTesting();
  });

  describe('non-configured channels', () => {
    it('rejects an unconfigured channel', () => {
      const decision = decideRoute({
        channelId: 'CNOTACONFIGURED',
        threadTs: undefined,
        isExistingSageThread: false,
        intent: 'work_request',
      });
      expect(decision).toEqual({ kind: 'reject_unconfigured' });
    });
  });

  describe('intake channels (BD)', () => {
    const channelId = 'C0B1P92785C';

    it('routes work_request to the modal flow', () => {
      const decision = decideRoute({
        channelId,
        threadTs: undefined,
        isExistingSageThread: false,
        intent: 'work_request',
      });
      expect(decision).toEqual({ kind: 'route', intent: 'work_request', role: 'intake' });
    });

    it('routes light_qc', () => {
      const decision = decideRoute({
        channelId,
        threadTs: undefined,
        isExistingSageThread: false,
        intent: 'light_qc',
      });
      expect(decision).toEqual({ kind: 'route', intent: 'light_qc', role: 'intake' });
    });

    it('routes status_query', () => {
      const decision = decideRoute({
        channelId,
        threadTs: undefined,
        isExistingSageThread: false,
        intent: 'status_query',
      });
      expect(decision).toEqual({ kind: 'route', intent: 'status_query', role: 'intake' });
    });

    it('routes info_lookup', () => {
      const decision = decideRoute({
        channelId,
        threadTs: undefined,
        isExistingSageThread: false,
        intent: 'info_lookup',
      });
      expect(decision).toEqual({ kind: 'route', intent: 'info_lookup', role: 'intake' });
    });

    it('routes unclear', () => {
      const decision = decideRoute({
        channelId,
        threadTs: undefined,
        isExistingSageThread: false,
        intent: 'unclear',
      });
      expect(decision).toEqual({ kind: 'route', intent: 'unclear', role: 'intake' });
    });
  });

  describe('alerts channel', () => {
    const channelId = 'C0ACWP7PGHE';

    it('routes status_query', () => {
      const decision = decideRoute({
        channelId,
        threadTs: undefined,
        isExistingSageThread: false,
        intent: 'status_query',
      });
      expect(decision).toEqual({ kind: 'route', intent: 'status_query', role: 'alerts' });
    });

    it('routes info_lookup', () => {
      const decision = decideRoute({
        channelId,
        threadTs: undefined,
        isExistingSageThread: false,
        intent: 'info_lookup',
      });
      expect(decision).toEqual({ kind: 'route', intent: 'info_lookup', role: 'alerts' });
    });

    it('rejects work_request with redirect to division channel', () => {
      const decision = decideRoute({
        channelId,
        threadTs: undefined,
        isExistingSageThread: false,
        intent: 'work_request',
      });
      expect(decision).toEqual({
        kind: 'reject_invalid_intent',
        intent: 'work_request',
        role: 'alerts',
      });
    });

    it('rejects light_qc with redirect to division channel', () => {
      const decision = decideRoute({
        channelId,
        threadTs: undefined,
        isExistingSageThread: false,
        intent: 'light_qc',
      });
      expect(decision).toEqual({
        kind: 'reject_invalid_intent',
        intent: 'light_qc',
        role: 'alerts',
      });
    });
  });

  describe('test channel', () => {
    const channelId = 'C0ABY48HRDL';

    it('allows all intents in test mode', () => {
      const decision = decideRoute({
        channelId,
        threadTs: undefined,
        isExistingSageThread: false,
        intent: 'work_request',
      });
      expect(decision).toEqual({ kind: 'route', intent: 'work_request', role: 'test' });
    });
  });

  describe('existing-thread follow-ups', () => {
    it('routes to follow_up regardless of intent in an intake channel', () => {
      const decision = decideRoute({
        channelId: 'C0B1P92785C',
        threadTs: '1234567890.123456',
        isExistingSageThread: true,
        intent: 'work_request',
      });
      expect(decision).toEqual({ kind: 'follow_up' });
    });

    it('routes to follow_up regardless of intent in the alerts channel', () => {
      const decision = decideRoute({
        channelId: 'C0ACWP7PGHE',
        threadTs: '1234567890.123456',
        isExistingSageThread: true,
        intent: 'light_qc',
      });
      expect(decision).toEqual({ kind: 'follow_up' });
    });
  });
});


describe('shouldHandleAmbientMessage (un-mentioned posts)', () => {
  beforeEach(() => {
    _resetCacheForTesting();
  });

  const BD = 'C0B1P92785C';      // intake
  const TEST = 'C0ABY48HRDL';    // test
  const ALERTS = 'C0ACWP7PGHE';  // alerts
  const BOT = 'UBOT123';

  it('handles a plain message in an intake channel', () => {
    expect(shouldHandleAmbientMessage({ channel: BD, user: 'U1', text: 'we need a video made' }, BOT)).toBe(true);
  });

  it('handles a plain message in the test channel', () => {
    expect(shouldHandleAmbientMessage({ channel: TEST, user: 'U1', text: 'run an ad campaign' }, BOT)).toBe(true);
  });

  it('stays silent in the alerts channel — marketing coordinates there', () => {
    expect(shouldHandleAmbientMessage({ channel: ALERTS, user: 'U1', text: 'can you take this one?' }, BOT)).toBe(false);
  });

  it('ignores unconfigured channels', () => {
    expect(shouldHandleAmbientMessage({ channel: 'CNOPE', user: 'U1', text: 'hi' }, BOT)).toBe(false);
  });

  it('defers to app_mention when Sage is mentioned', () => {
    expect(shouldHandleAmbientMessage({ channel: BD, user: 'U1', text: `<@${BOT}> I need a one-pager` }, BOT)).toBe(false);
  });

  it('still handles a message mentioning someone else', () => {
    expect(shouldHandleAmbientMessage({ channel: BD, user: 'U1', text: '<@U999> and I need event support' }, BOT)).toBe(true);
  });

  it('ignores joins, edits and other subtypes', () => {
    expect(shouldHandleAmbientMessage({ channel: BD, user: 'U1', text: 'x', subtype: 'channel_join' }, BOT)).toBe(false);
  });

  it('ignores other bots', () => {
    expect(shouldHandleAmbientMessage({ channel: BD, user: 'U1', text: 'Offer Alert', bot_id: 'B123' }, BOT)).toBe(false);
  });

  it('ignores events with no user', () => {
    expect(shouldHandleAmbientMessage({ channel: BD, text: 'orphan' }, BOT)).toBe(false);
  });
});
