import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('./db', () => ({
  insertRequestEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./error-tracker', () => ({
  trackError: vi.fn().mockResolvedValue(undefined),
}));

import { logRequestEvent } from './event-log';
import { insertRequestEvent } from './db';
import { trackError } from './error-tracker';

describe('logRequestEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts a fully-populated event row', async () => {
    await logRequestEvent({
      userId: 'U123',
      channelId: 'C0B1P92785C',
      channelRole: 'intake',
      eventType: 'modal_submitted',
      intent: 'work_request',
      parsedFields: { requestType: 'webinar' },
      recommendationsOffered: [{ name: 'reg-email' }],
      recommendationsAccepted: [{ name: 'reg-email' }],
      mondayItemId: '12345',
    });

    expect(insertRequestEvent as Mock).toHaveBeenCalledTimes(1);
    expect(insertRequestEvent as Mock).toHaveBeenCalledWith({
      user_id: 'U123',
      channel_id: 'C0B1P92785C',
      channel_role: 'intake',
      event_type: 'modal_submitted',
      intent: 'work_request',
      parsed_fields_json: { requestType: 'webinar' },
      recommendations_offered_json: [{ name: 'reg-email' }],
      recommendations_accepted_json: [{ name: 'reg-email' }],
      monday_item_id: '12345',
    });
  });

  it('passes null for missing optional fields', async () => {
    await logRequestEvent({
      eventType: 'poller_tick',
    });

    expect(insertRequestEvent as Mock).toHaveBeenCalledWith({
      user_id: null,
      channel_id: null,
      channel_role: null,
      event_type: 'poller_tick',
      intent: null,
      parsed_fields_json: null,
      recommendations_offered_json: null,
      recommendations_accepted_json: null,
      monday_item_id: null,
    });
  });

  it('does NOT throw when the DB insert fails', async () => {
    (insertRequestEvent as Mock).mockRejectedValueOnce(new Error('connection refused'));

    await expect(
      logRequestEvent({ eventType: 'modal_opened', userId: 'U123' })
    ).resolves.toBeUndefined();
  });

  it('reports DB-insert failures via trackError', async () => {
    const dbErr = new Error('connection refused');
    (insertRequestEvent as Mock).mockRejectedValueOnce(dbErr);

    await logRequestEvent({ eventType: 'modal_opened', userId: 'U123' });

    expect(trackError as Mock).toHaveBeenCalledTimes(1);
    expect(trackError as Mock).toHaveBeenCalledWith(
      dbErr,
      undefined,
      { source: 'event-log', eventType: 'modal_opened' }
    );
  });

  it('does NOT throw even when error-tracking itself fails', async () => {
    (insertRequestEvent as Mock).mockRejectedValueOnce(new Error('db failure'));
    (trackError as Mock).mockRejectedValueOnce(new Error('tracker failure'));

    await expect(
      logRequestEvent({ eventType: 'modal_opened' })
    ).resolves.toBeUndefined();
  });
});
