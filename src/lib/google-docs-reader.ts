import { google, docs_v1 } from 'googleapis';
import { config } from './config';

// --- Auth (same pattern as google-drive.ts) ---

function getAuth(): ReturnType<typeof google.auth.fromJSON> | null {
  try {
    const raw = config.googleServiceAccountJson;
    if (!raw || raw === 'undefined') {
      console.error('[google-docs-reader] GOOGLE_SERVICE_ACCOUNT_JSON is empty or undefined');
      return null;
    }
    const credentials = JSON.parse(raw);
    if (!credentials.client_email) {
      console.error('[google-docs-reader] Service account JSON missing client_email');
      return null;
    }
    console.log(`[google-docs-reader] Authenticating as ${credentials.client_email}`);
    return google.auth.fromJSON({
      ...credentials,
      scopes: [
        'https://www.googleapis.com/auth/documents.readonly',
        'https://www.googleapis.com/auth/drive.readonly',
      ],
    }) as ReturnType<typeof google.auth.fromJSON>;
  } catch (err) {
    console.error('[google-docs-reader] Failed to parse service account JSON:', err);
    return null;
  }
}

function getDocs(): docs_v1.Docs | null {
  const auth = getAuth();
  if (!auth) return null;
  return google.docs({ version: 'v1', auth: auth as any });
}

// --- Extract document ID from URL ---

/**
 * Extract Google Doc ID from various URL formats:
 * - https://docs.google.com/document/d/DOCUMENT_ID/edit
 * - https://docs.google.com/document/d/DOCUMENT_ID
 * - https://docs.google.com/document/d/DOCUMENT_ID/edit?...
 * - Just the ID itself
 */
export function extractDocId(urlOrId: string): string | null {
  const trimmed = urlOrId.trim();

  // Match Google Docs URL pattern
  const urlMatch = trimmed.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (urlMatch) {
    return urlMatch[1];
  }

  // If it looks like a bare document ID (alphanumeric, hyphens, underscores, reasonable length)
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

// --- Extract text from document body ---

function extractTextFromElement(element: docs_v1.Schema$StructuralElement): string {
  const parts: string[] = [];

  if (element.paragraph) {
    const para = element.paragraph;
    for (const elem of para.elements ?? []) {
      if (elem.textRun?.content) {
        parts.push(elem.textRun.content);
      }
    }
  }

  if (element.table) {
    for (const row of element.table.tableRows ?? []) {
      const cellTexts: string[] = [];
      for (const cell of row.tableCells ?? []) {
        const cellContent: string[] = [];
        for (const cellElement of cell.content ?? []) {
          cellContent.push(extractTextFromElement(cellElement));
        }
        cellTexts.push(cellContent.join('').trim());
      }
      parts.push(cellTexts.join(' | '));
    }
    parts.push('\n');
  }

  if (element.sectionBreak) {
    parts.push('\n');
  }

  return parts.join('');
}

function extractDocumentText(doc: docs_v1.Schema$Document): string {
  const body = doc.body;
  if (!body?.content) return '';

  const parts: string[] = [];
  for (const element of body.content) {
    parts.push(extractTextFromElement(element));
  }

  return parts.join('').trim();
}

// --- Public API ---

/**
 * Get the service account email for sharing instructions.
 */
export function getServiceAccountEmail(): string | null {
  try {
    const raw = config.googleServiceAccountJson;
    if (!raw || raw === 'undefined') return null;
    const credentials = JSON.parse(raw);
    return credentials.client_email ?? null;
  } catch {
    return null;
  }
}

/**
 * Read a Google Doc and return its title and plain text content.
 *
 * @param urlOrId - Google Docs URL or document ID
 * @returns Document title and concatenated text content
 * @throws Error if document cannot be accessed or read
 */
export async function readGoogleDoc(urlOrId: string): Promise<{ title: string; content: string }> {
  const docId = extractDocId(urlOrId);
  if (!docId) {
    throw new Error(`Could not extract document ID from: ${urlOrId}`);
  }

  const docs = getDocs();
  if (!docs) {
    throw new Error('Google Docs API not configured — missing GOOGLE_SERVICE_ACCOUNT_JSON');
  }

  console.log(`[google-docs-reader] Reading document: ${docId}`);

  try {
    const response = await docs.documents.get({ documentId: docId });
    const doc = response.data;

    const title = doc.title ?? 'Untitled Document';
    const content = extractDocumentText(doc);

    console.log(`[google-docs-reader] Read "${title}" (${content.length} chars)`);

    return { title, content };
  } catch (err: any) {
    if (err?.code === 403 || err?.code === 404) {
      const serviceEmail = getServiceAccountEmail();
      const shareHint = serviceEmail
        ? ` Please share the document with: ${serviceEmail}`
        : ' Please share the document with the service account.';
      throw new Error(
        `Cannot access document (${err.code}).${shareHint}`,
      );
    }
    throw err;
  }
}
