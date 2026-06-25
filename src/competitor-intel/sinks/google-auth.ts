/**
 * Google auth for the spoke — same service account as Sage, but with the
 * broader scopes the spoke needs (Sheets + Slides + Drive). Sage's own
 * google-drive.ts requests drive-only scope, so we keep a separate client here.
 */

import { google } from 'googleapis';
import { ciConfig } from '../config';

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
];

export function getGoogleAuth() {
  const credentials = JSON.parse(ciConfig.googleServiceAccountJson);
  if (!credentials.client_email) {
    throw new Error('[competitor-intel] service account JSON missing client_email');
  }
  return google.auth.fromJSON({ ...credentials, scopes: SCOPES }) as any;
}

export function serviceAccountEmail(): string {
  return JSON.parse(ciConfig.googleServiceAccountJson).client_email;
}
