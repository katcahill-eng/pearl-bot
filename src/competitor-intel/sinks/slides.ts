/**
 * Google Slides — the board-facing weekly deck, generated from the synthesis.
 *
 * Creates a fresh dated deck in the folder each week (an archive; the Sheet
 * holds the running history). Phase-1 template: title + take + movements +
 * threats/opportunities + AI-visibility + suggested additions. Built with
 * plain text boxes on blank slides so it renders without placeholder lookups.
 * Refine layout/branding in a later pass (Pearl colors: #0c3860, #04b290).
 */

import { google, slides_v1 } from 'googleapis';
import { getGoogleAuth } from './google-auth';
import { ciConfig } from '../config';
import type { AiVisibilityResult, WeeklySynthesis } from '../types';

function slidesClient() {
  return google.slides({ version: 'v1', auth: getGoogleAuth() });
}
function driveClient() {
  return google.drive({ version: 'v3', auth: getGoogleAuth() });
}

let seq = 0;
const id = (p: string) => `ci_${p}_${Date.now()}_${seq++}`;

/** Append requests that render one slide with a title and body text. */
function slide(
  requests: slides_v1.Schema$Request[],
  title: string,
  body: string,
): void {
  const pageId = id('slide');
  const titleId = id('title');
  const bodyId = id('body');
  requests.push({ createSlide: { objectId: pageId, slideLayoutReference: { predefinedLayout: 'BLANK' } } });
  // Title box
  requests.push({
    createShape: {
      objectId: titleId,
      shapeType: 'TEXT_BOX',
      elementProperties: {
        pageObjectId: pageId,
        size: { width: { magnitude: 8400000, unit: 'EMU' }, height: { magnitude: 700000, unit: 'EMU' } },
        transform: { scaleX: 1, scaleY: 1, translateX: 400000, translateY: 300000, unit: 'EMU' },
      },
    },
  });
  requests.push({ insertText: { objectId: titleId, text: title } });
  requests.push({
    updateTextStyle: {
      objectId: titleId,
      style: { bold: true, fontSize: { magnitude: 22, unit: 'PT' } },
      fields: 'bold,fontSize',
      textRange: { type: 'ALL' },
    },
  });
  // Body box
  requests.push({
    createShape: {
      objectId: bodyId,
      shapeType: 'TEXT_BOX',
      elementProperties: {
        pageObjectId: pageId,
        size: { width: { magnitude: 8400000, unit: 'EMU' }, height: { magnitude: 3800000, unit: 'EMU' } },
        transform: { scaleX: 1, scaleY: 1, translateX: 400000, translateY: 1200000, unit: 'EMU' },
      },
    },
  });
  requests.push({ insertText: { objectId: bodyId, text: body || '—' } });
  requests.push({
    updateTextStyle: {
      objectId: bodyId,
      style: { fontSize: { magnitude: 13, unit: 'PT' } },
      fields: 'fontSize',
      textRange: { type: 'ALL' },
    },
  });
}

const bullets = (arr: string[]) => (arr.length ? arr.map((x) => `•  ${x}`).join('\n\n') : 'None this week.');

export async function buildDeck(
  synthesis: WeeklySynthesis,
  aiVisibility: AiVisibilityResult[],
  runDate: string,
): Promise<{ deckId: string; deckUrl: string }> {
  const drive = driveClient();
  const created = await drive.files.create({
    requestBody: {
      name: `Pearl Competitor Intel — ${runDate}`,
      mimeType: 'application/vnd.google-apps.presentation',
      parents: [ciConfig.folderId],
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });
  const deckId = created.data.id!;
  const deckUrl = created.data.webViewLink ?? `https://docs.google.com/presentation/d/${deckId}`;

  const requests: slides_v1.Schema$Request[] = [];
  slide(requests, `Competitor Intelligence — week of ${runDate}`, synthesis.analystTake);
  slide(requests, 'What moved this week', bullets(synthesis.movements));
  slide(requests, 'Where Pearl can take ground', bullets(synthesis.opportunities));
  slide(requests, 'Threats to watch', bullets(synthesis.threats));
  slide(requests, '5-pillar read', synthesis.pillarNotes);
  slide(
    requests,
    'AI-answer visibility',
    aiVisibility
      .map((a) => `${a.pearlMentioned ? '✅' : '⬜'}  "${a.prompt}"\n     cited: ${a.mentionedBrands.join(' > ') || 'none'}`)
      .join('\n\n'),
  );
  if (synthesis.suggestedAdditions.length) {
    slide(
      requests,
      'Suggested watchlist additions',
      synthesis.suggestedAdditions.map((p) => `•  ${p.name} (${p.category}) — ${p.reason}`).join('\n\n'),
    );
  }

  await slidesClient().presentations.batchUpdate({
    presentationId: deckId,
    requestBody: { requests },
  });

  return { deckId, deckUrl };
}
