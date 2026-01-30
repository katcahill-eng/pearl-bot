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
    const credentials = JSON.parse(config.googleServiceAccountJson);
    return google.auth.fromJSON({
      ...credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    }) as ReturnType<typeof google.auth.fromJSON>;
  } catch {
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
 * Create Drive artifacts for a full project.
 * Creates folder in the configured projects folder with MKT-XXXXXX auto-increment naming.
 * Subfolders: Admin, Background, Brief, Deliverables, Production
 * Saves the Operational Brief doc in the Brief subfolder.
 */
export async function createFullProjectDrive(
  projectName: string,
  briefMarkdown: string,
): Promise<DriveResult> {
  try {
    const drive = getDrive();
    if (!drive) {
      return { success: false, error: 'Google Drive not configured — missing GOOGLE_SERVICE_ACCOUNT_JSON' };
    }

    const projectsFolderId = config.googleProjectsFolderId;

    // Determine the next MKT number by listing existing folders
    const nextNumber = await getNextMktNumber(drive, projectsFolderId);
    const mktCode = `MKT-${nextNumber.toString().padStart(6, '0')}`;
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

    // Create brief doc in Brief subfolder
    const doc = await createDoc(drive, `Operational Brief — ${projectName}`, briefFolderId, briefMarkdown);

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
