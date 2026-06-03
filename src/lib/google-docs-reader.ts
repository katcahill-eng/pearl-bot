import { google, docs_v1 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { config } from './config';

function getAuth(): JWT | null {
  try {
    const raw = config.googleServiceAccountJson;
    if (!raw || raw === 'undefined') {
      console.error('[google-docs-reader] GOOGLE_SERVICE_ACCOUNT_JSON is empty or undefined');
      return null;
    }
    const credentials = JSON.parse(raw);
    if (!credentials.client_email || !credentials.private_key) {
      console.error('[google-docs-reader] Service account JSON missing client_email or private_key');
      return null;
    }
    // Railway env vars can turn \n into literal \\n in the PEM key — fix it.
    const privateKey = credentials.private_key.replace(/\\n/g, '\n');
    console.log(`[google-docs-reader] Authenticating as ${credentials.client_email}`);
    return new JWT({
      email: credentials.client_email,
      key: privateKey,
      scopes: [
        'https://www.googleapis.com/auth/documents.readonly',
        'https://www.googleapis.com/auth/drive.readonly',
      ],
    });
  } catch (err) {
    console.error('[google-docs-reader] Failed to create auth client:', err);
    return null;
  }
}

function getDocs(): docs_v1.Docs | null {
  const auth = getAuth();
  if (!auth) return null;
  return google.docs({ version: 'v1', auth });
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

function buildAccessError(): string {
  const serviceEmail = getServiceAccountEmail();
  if (serviceEmail) {
    return `This document isn't accessible to Sage. In Google Docs, open Share and add ${serviceEmail} as a Viewer — or set General Access to "Anyone with the link" (Viewer).`;
  }
  return `This document isn't accessible to Sage. In Google Docs, open Share and set General Access to "Anyone with the link" (Viewer).`;
}

/**
 * Fallback reader for docs shared as "Anyone with the link".
 * The Google Docs API (service account) can't access link-shared docs,
 * but the public export URL can.
 */
async function readPublicDoc(
  docId: string,
): Promise<{ title: string; content: string } | null> {
  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  try {
    const res = await fetch(exportUrl, { redirect: 'manual' });
    // Google redirects to login page when not accessible — treat as private.
    if (res.status === 302 || res.status === 301 || !res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/plain') && !contentType.includes('text/')) return null;

    const text = await res.text();
    if (!text || text.length < 10) return null;

    // Try to extract title from Content-Disposition header.
    let title = 'Untitled Document';
    const cd = res.headers.get('content-disposition') ?? '';
    const fnMatch = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
    if (fnMatch) {
      title = decodeURIComponent(fnMatch[1].replace(/\.txt$/i, '').trim());
    }

    return { title, content: text.trim() };
  } catch {
    return null;
  }
}

/**
 * Verify that Sage can access a Google Doc without reading its full content.
 * First tries the service account (for explicitly shared docs), then falls
 * back to the public export URL (for "Anyone with the link" docs).
 */
export async function checkDocAccess(urlOrId: string): Promise<{ title: string }> {
  const docId = extractDocId(urlOrId);
  if (!docId) {
    throw new Error(`Could not extract document ID from: ${urlOrId}`);
  }

  const docs = getDocs();
  if (docs) {
    try {
      const response = await docs.documents.get({ documentId: docId, fields: 'title' });
      return { title: response.data.title ?? 'Untitled Document' };
    } catch (err: any) {
      const isAccessError =
        err?.code === 401 || err?.code === 403 || err?.code === 404 ||
        err?.response?.status === 401 || err?.response?.status === 403 || err?.response?.status === 404;
      if (!isAccessError) throw err;
      // Fall through to public export fallback below.
      console.log(`[google-docs-reader] Service account denied (${err?.code ?? err?.response?.status}), trying public export fallback`);
    }
  }

  // Public export fallback — works for "Anyone with the link" docs.
  const pub = await readPublicDoc(docId);
  if (pub) return { title: pub.title };

  throw new Error(buildAccessError());
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

  console.log(`[google-docs-reader] Reading document: ${docId}`);

  const docs = getDocs();
  if (docs) {
    try {
      const response = await docs.documents.get({ documentId: docId });
      const doc = response.data;
      const title = doc.title ?? 'Untitled Document';
      const content = extractDocumentText(doc);
      console.log(`[google-docs-reader] Read via service account: "${title}" (${content.length} chars)`);
      return { title, content };
    } catch (err: any) {
      const isAccessError =
        err?.code === 401 || err?.code === 403 || err?.code === 404 ||
        err?.response?.status === 401 || err?.response?.status === 403 || err?.response?.status === 404;
      if (!isAccessError) throw err;
      console.log(`[google-docs-reader] Service account denied, trying public export fallback`);
    }
  }

  // Public export fallback — works for "Anyone with the link" docs.
  const pub = await readPublicDoc(docId);
  if (pub) {
    console.log(`[google-docs-reader] Read via public export: "${pub.title}" (${pub.content.length} chars)`);
    return pub;
  }

  throw new Error(buildAccessError());
}
