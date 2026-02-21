import { google, drive_v3 } from 'googleapis';
import { config } from './config';

// --- Types ---

export interface DriveResult {
  success: boolean;
  folderUrl?: string;
  docUrl?: string;
  projectNumber?: string;
  error?: string;
}

// --- Auth ---

function getAuth(): ReturnType<typeof google.auth.fromJSON> | null {
  try {
    const raw = config.googleServiceAccountJson;
    if (!raw || raw === 'undefined') {
      console.error('[google-drive] GOOGLE_SERVICE_ACCOUNT_JSON is empty or undefined');
      return null;
    }
    const credentials = JSON.parse(raw);
    if (!credentials.client_email) {
      console.error('[google-drive] Service account JSON missing client_email');
      return null;
    }
    console.log(`[google-drive] Authenticating as ${credentials.client_email}`);
    return google.auth.fromJSON({
      ...credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    }) as ReturnType<typeof google.auth.fromJSON>;
  } catch (err) {
    console.error('[google-drive] Failed to parse service account JSON:', err);
    return null;
  }
}

function getDrive(): drive_v3.Drive | null {
  const auth = getAuth();
  if (!auth) return null;
  return google.drive({ version: 'v3', auth: auth as any });
}

// --- Helpers ---

async function createFolder(
  drive: drive_v3.Drive,
  name: string,
  parentId: string,
): Promise<{ id: string; url: string }> {
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id, webViewLink',
  });
  return {
    id: res.data.id ?? '',
    url: res.data.webViewLink ?? '',
  };
}

async function createDoc(
  drive: drive_v3.Drive,
  name: string,
  parentId: string,
  markdownContent: string,
): Promise<{ id: string; url: string }> {
  // Create a Google Doc with the brief content as plain text body
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.document',
      parents: [parentId],
    },
    media: {
      mimeType: 'text/plain',
      body: markdownContent,
    },
    fields: 'id, webViewLink',
  });
  return {
    id: res.data.id ?? '',
    url: res.data.webViewLink ?? '',
  };
}

// --- Public API ---

/**
 * Allocate the next MKT number by scanning existing project folders.
 * Returns the formatted string like "MKT-000042".
 * Call this before generating the brief so the MKT number can appear in the brief header.
 */
export async function allocateNextMktNumber(): Promise<string> {
  const drive = getDrive();
  if (!drive) {
    throw new Error('Google Drive not configured — missing GOOGLE_SERVICE_ACCOUNT_JSON');
  }
  const projectsFolderId = config.googleProjectsFolderId;
  const nextNumber = await getNextMktNumber(drive, projectsFolderId);
  return `MKT-${nextNumber.toString().padStart(6, '0')}`;
}

/**
 * Create Drive artifacts for a full project.
 * Creates folder in the configured projects folder using a pre-allocated MKT number.
 * Subfolders: Admin, Background, Brief, Deliverables, Production
 * Saves the brief doc in the Brief subfolder with YYMMDD-PERL naming convention.
 */
export async function createFullProjectDrive(
  projectName: string,
  briefMarkdown: string,
  projectNumber: string,
): Promise<DriveResult> {
  try {
    const drive = getDrive();
    if (!drive) {
      return { success: false, error: 'Google Drive not configured — missing GOOGLE_SERVICE_ACCOUNT_JSON' };
    }

    const projectsFolderId = config.googleProjectsFolderId;

    // Use the pre-allocated project number
    const mktCode = projectNumber;
    const folderName = `${mktCode}-${projectName}`;

    // Create project folder directly in the projects folder (no year subfolder)
    const projectFolder = await createFolder(drive, folderName, projectsFolderId);

    // Create subfolders
    const subfolders = ['Admin', 'Background', 'Brief', 'Deliverables', 'Production'];

    let briefFolderId = '';
    for (const name of subfolders) {
      const sub = await createFolder(drive, name, projectFolder.id);
      if (name === 'Brief') {
        briefFolderId = sub.id;
      }
    }

    // Create brief doc in Brief subfolder with YYMMDD-PERL naming convention
    const now = new Date();
    const yy = String(now.getFullYear()).slice(2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const datePrefix = `${yy}${mm}${dd}`;
    const docName = `${datePrefix}-PERL-${projectName} Brief 1.0`;
    const doc = await createDoc(drive, docName, briefFolderId, briefMarkdown);

    return {
      success: true,
      folderUrl: projectFolder.url,
      docUrl: doc.url,
      projectNumber: mktCode,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Google Drive error';
    console.error('[google-drive] createFullProjectDrive failed:', message);
    return { success: false, error: `Google Drive error: ${message}` };
  }
}

/**
 * Scan the projects folder for existing MKT-XXXXXX folders and return the next number.
 */
async function getNextMktNumber(
  drive: drive_v3.Drive,
  parentFolderId: string,
): Promise<number> {
  try {
    const query = `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const list = await drive.files.list({
      q: query,
      fields: 'files(name)',
      pageSize: 1000,
      orderBy: 'name desc',
    });

    let maxNumber = 0;
    const mktPattern = /^MKT-(\d{6})/;

    for (const file of list.data.files ?? []) {
      const match = file.name?.match(mktPattern);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNumber) {
          maxNumber = num;
        }
      }
    }

    return maxNumber + 1;
  } catch (err) {
    console.error('[google-drive] Failed to scan for MKT numbers:', err);
    // Fall back to timestamp-based number to avoid collisions
    return Math.floor(Date.now() / 1000) % 999999;
  }
}

// --- Internal Helpers ---

async function findOrCreateFolder(
  drive: drive_v3.Drive,
  name: string,
  parentId: string,
): Promise<{ id: string; url: string }> {
  // Search for existing folder with this name under the parent
  const query = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const list = await drive.files.list({
    q: query,
    fields: 'files(id, webViewLink)',
    pageSize: 1,
  });

  if (list.data.files && list.data.files.length > 0) {
    const existing = list.data.files[0];
    return {
      id: existing.id ?? '',
      url: existing.webViewLink ?? '',
    };
  }

  // Not found — create it
  return createFolder(drive, name, parentId);
}
