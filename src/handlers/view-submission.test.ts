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

import {
  parseModalState,
  deriveItemName,
  requestTypeToDeliverableLabel,
} from './view-submission';

describe('parseModalState', () => {
  it('extracts a fully-populated modal state', () => {
    const values = {
      deliverable_types_a: {
        sage_v2_deliverables_change: { selected_options: [{ value: 'email' }] },
      },
      deliverable_types_more: {
        sage_v2_deliverables_change: { selected_options: [{ value: 'webinar' }] },
      },
      deliverable: { value: { value: 'Registration email for May 12 webinar' } },
      audience: { value: { value: 'real estate agents' } },
      event_or_project: { value: { value: 'Realtor Association webinar' } },
      deadline: { value: { selected_date: '2026-05-08' } },
      approvals: { value: { selected_users: ['U1', 'U2'] } },
      additional_divisions: {
        value: { selected_options: [{ value: 'BD' }, { value: 'P2' }] },
      },
      requesting_for: { value: { selected_user: 'U3' } },
      recommendations: {
        value: {
          selected_options: [
            { value: 'registration-email' },
            { value: 'social-promo' },
          ],
        },
      },
    };

    const state = parseModalState(values);

    expect(state.deliverables).toEqual(['email', 'webinar']); // group A then group B
    expect(state.requestType).toBe('email'); // first selected = implicit primary
    expect(state.deliverable).toContain('Registration email');
    expect(state.audience).toBe('real estate agents');
    expect(state.eventOrProject).toBe('Realtor Association webinar');
    expect(state.deadline).toBe('2026-05-08');
    expect(state.approverSlackIds).toEqual(['U1', 'U2']);
    expect(state.additionalDivisions).toEqual(['BD', 'P2']);
    expect(state.requestingForSlackId).toBe('U3');
    expect(state.recommendationNames).toEqual(['registration-email', 'social-promo']);
  });

  it('handles a minimal modal state with only deliverable', () => {
    const values = {
      deliverable: { value: { value: 'Quick logo question' } },
    };
    const state = parseModalState(values);
    expect(state.deliverable).toBe('Quick logo question');
    expect(state.audience).toBeNull();
    expect(state.deadline).toBeNull();
    expect(state.approverSlackIds).toEqual([]);
    expect(state.additionalDivisions).toEqual([]);
    expect(state.recommendationNames).toEqual([]);
    expect(state.deliverables).toEqual([]);
  });

  it('handles entirely empty values gracefully', () => {
    const state = parseModalState({});
    expect(state.deliverable).toBe('');
    expect(state.requestType).toBeNull();
    expect(state.approverSlackIds).toEqual([]);
  });
});

describe('deriveItemName', () => {
  it('uses the first sentence of the deliverable', () => {
    expect(deriveItemName('Registration email. With sub-line.')).toBe(
      'Registration email',
    );
  });

  it('caps at 80 characters', () => {
    const long = 'a'.repeat(200);
    expect(deriveItemName(long).length).toBeLessThanOrEqual(80);
  });

  it('falls back to a default for empty input', () => {
    expect(deriveItemName('')).toBe('New marketing request');
    expect(deriveItemName('   ')).toBe('New marketing request');
  });
});

describe('requestTypeToDeliverableLabel', () => {
  it('maps modal request types to existing Type-of-Deliverable labels', () => {
    expect(requestTypeToDeliverableLabel('webinar')).toBe('Webinar');
    expect(requestTypeToDeliverableLabel('email')).toBe('Email');
    expect(requestTypeToDeliverableLabel('blog')).toBe('B2B Blog Post');
    expect(requestTypeToDeliverableLabel('press_release')).toBe('Press Release');
    expect(requestTypeToDeliverableLabel('event')).toBe('Event');
    expect(requestTypeToDeliverableLabel('landing_page')).toBe('New Webpage');
    expect(requestTypeToDeliverableLabel('website_update')).toBe('Website Update');
    expect(requestTypeToDeliverableLabel('graphic')).toBe('Graphic Design Support');
    expect(requestTypeToDeliverableLabel('ebook')).toBe('Ebook/White Paper');
  });

  it('returns null for null or unknown input', () => {
    expect(requestTypeToDeliverableLabel(null)).toBeNull();
    expect(requestTypeToDeliverableLabel('something_weird')).toBeNull();
  });
});
