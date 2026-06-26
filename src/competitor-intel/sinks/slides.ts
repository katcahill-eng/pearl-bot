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
import type { SlideSpec } from '../types';

function slidesClient() {
  return google.slides({ version: 'v1', auth: getGoogleAuth() });
}
function driveClient() {
  return google.drive({ version: 'v3', auth: getGoogleAuth() });
}

let seq = 0;
const id = (p: string) => `ci_${p}_${Date.now()}_${seq++}`;

const TEAL = { red: 0.016, green: 0.698, blue: 0.565 }; // Pearl teal #04b290
const DARK = { red: 0.047, green: 0.22, blue: 0.376 }; // Pearl blue #0c3860

/** Render one low-text slide from a SlideSpec: title + sparse bullets + callout. */
function slide(requests: slides_v1.Schema$Request[], spec: SlideSpec): void {
  const pageId = id('slide');
  const titleId = id('title');
  requests.push({ createSlide: { objectId: pageId, slideLayoutReference: { predefinedLayout: 'BLANK' } } });

  // Title
  requests.push({
    createShape: {
      objectId: titleId,
      shapeType: 'TEXT_BOX',
      elementProperties: {
        pageObjectId: pageId,
        size: { width: { magnitude: 8400000, unit: 'EMU' }, height: { magnitude: 900000, unit: 'EMU' } },
        transform: { scaleX: 1, scaleY: 1, translateX: 400000, translateY: 350000, unit: 'EMU' },
      },
    },
  });
  requests.push({ insertText: { objectId: titleId, text: spec.title || ' ' } });
  requests.push({
    updateTextStyle: {
      objectId: titleId,
      style: { bold: true, fontSize: { magnitude: 24, unit: 'PT' }, foregroundColor: { opaqueColor: { rgbColor: DARK } } },
      fields: 'bold,fontSize,foregroundColor',
      textRange: { type: 'ALL' },
    },
  });

  // Bullets (sparse)
  if (spec.bullets.length) {
    const bodyId = id('body');
    requests.push({
      createShape: {
        objectId: bodyId,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: pageId,
          size: { width: { magnitude: 8200000, unit: 'EMU' }, height: { magnitude: 2500000, unit: 'EMU' } },
          transform: { scaleX: 1, scaleY: 1, translateX: 500000, translateY: 1500000, unit: 'EMU' },
        },
      },
    });
    requests.push({ insertText: { objectId: bodyId, text: spec.bullets.map((b) => `•  ${b}`).join('\n\n') } });
    requests.push({
      updateTextStyle: {
        objectId: bodyId,
        style: { fontSize: { magnitude: 16, unit: 'PT' } },
        fields: 'fontSize',
        textRange: { type: 'ALL' },
      },
    });
  }

  // Callout (one highlighted line)
  if (spec.callout) {
    const calloutId = id('callout');
    requests.push({
      createShape: {
        objectId: calloutId,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: pageId,
          size: { width: { magnitude: 8200000, unit: 'EMU' }, height: { magnitude: 800000, unit: 'EMU' } },
          transform: { scaleX: 1, scaleY: 1, translateX: 500000, translateY: 4150000, unit: 'EMU' },
        },
      },
    });
    requests.push({ insertText: { objectId: calloutId, text: spec.callout } });
    requests.push({
      updateTextStyle: {
        objectId: calloutId,
        style: { bold: true, fontSize: { magnitude: 17, unit: 'PT' }, foregroundColor: { opaqueColor: { rgbColor: TEAL } } },
        fields: 'bold,fontSize,foregroundColor',
        textRange: { type: 'ALL' },
      },
    });
  }
}

/** Build the board deck from a designed slide spec (see nodes/deck-design.ts). */
export async function buildDeck(
  specs: SlideSpec[],
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
  for (const spec of specs) slide(requests, spec);

  await slidesClient().presentations.batchUpdate({
    presentationId: deckId,
    requestBody: { requests },
  });

  return { deckId, deckUrl };
}
