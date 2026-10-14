import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BACKUP_CONTENT_TYPE = 'application/zip';

// BL-378 Phase 1b: the Save dialog opens before the export runs, so a partial request suggests the
// route's PARTIAL name. (If nothing is missing any more by then, the file is an ordinary backup
// under that suggested name; the backup itself and its Inspect say what it is.)
export function createBackupExportFilename(now = new Date(), { partial = false } = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('Backup export filename requires a valid date.');
  }
  return `batshit-backup-${partial ? 'PARTIAL-' : ''}${now
    .toISOString()
    .replace(/[:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')}.zip`;
}

export async function describeBackupExportFailure(response) {
  const fallback = `Backup export failed with HTTP ${response?.status || 'error'}.`;
  let text = '';
  try {
    text = await response.text();
  } catch {
    return fallback;
  }
  if (!text.trim()) return fallback;
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error || parsed?.message;
    return typeof message === 'string' && message.trim() ? message.trim() : fallback;
  } catch {
    return text.trim().slice(0, 4096) || fallback;
  }
}

// BL-1406: release a refused body without replacing or delaying the primary refusal. The Electron
// session wrapper also aborts its own request: cancelling Electron's Readable.toWeb body alone
// destroys the readable, but does not stop the underlying URLLoader/export hold (BL-1401).
function cancelUnusedBody(response) {
  try {
    const cancelled = response?.body?.cancel?.();
    if (typeof cancelled?.catch === 'function') cancelled.catch(() => {});
  } catch {
    // The refusal is the error that matters.
  }
}

export async function writeBackupResponseToFile(response, targetPath) {
  if (!response?.ok) {
    throw new Error(await describeBackupExportFailure(response));
  }
  let temporaryPath;
  try {
    const contentType = response.headers?.get?.('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== BACKUP_CONTENT_TYPE) {
      throw new Error('Backup export returned an unexpected file type.');
    }
    if (!response.body) {
      throw new Error('Backup export returned no file data.');
    }
    if (
      typeof targetPath !== 'string' ||
      !targetPath ||
      targetPath.includes('\0') ||
      targetPath.length > 4096 ||
      !isAbsolute(targetPath)
    ) {
      throw new Error('The selected backup destination is invalid.');
    }
    temporaryPath = `${targetPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  } catch (error) {
    cancelUnusedBody(response);
    throw error;
  }

  // From here the pipeline owns the body: a write that fails destroys the reader, which cancels it.
  const parent = dirname(targetPath);
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 })
    );
    const temporaryFile = await open(temporaryPath, 'r');
    try {
      await temporaryFile.sync();
    } finally {
      await temporaryFile.close();
    }
    await rename(temporaryPath, targetPath);
    const directory = await open(parent, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function streamBackupExportToFile({
  electronSession,
  exportUrl,
  includeSecrets,
  partial,
  targetPath
}) {
  if (!electronSession || typeof electronSession.fetch !== 'function') {
    throw new Error('The authenticated Mac app session is unavailable.');
  }
  if (typeof exportUrl !== 'string' || !exportUrl) {
    throw new Error('The backup export URL is unavailable.');
  }
  if (typeof includeSecrets !== 'boolean') {
    throw new Error('Backup export includeSecrets must be a boolean.');
  }
  if (partial !== undefined && (!partial || typeof partial !== 'object' || Array.isArray(partial))) {
    throw new Error('Backup export partial must be an object.');
  }
  const origin = new URL(exportUrl).origin;
  const requestAbort = new AbortController();
  let response;
  try {
    response = await electronSession.fetch(exportUrl, {
      method: 'POST',
      credentials: 'include',
      signal: requestAbort.signal,
      headers: {
        Accept: 'application/zip',
        'Content-Type': 'application/json',
        Origin: origin
      },
      body: JSON.stringify({
        includeSecrets,
        confirmIncludeSecrets: includeSecrets,
        ...(partial ? { partial } : {})
      })
    });
    await writeBackupResponseToFile(response, targetPath);
  } catch (error) {
    // Covers fetch rejection and failed response consumption/writes. Success is never aborted.
    try { requestAbort.abort(); } catch { /* Keep the primary error even if cancellation fails. */ }
    throw error;
  }
  // BL-373/BL-369: the skill and voice folders the backup could not carry whole. The app's
  // Admin panel names them in its export toast, as it does for a browser download.
  // BL-378 Phase 1b: for a partial request, the summary header exactly as sent; the app parses it.
  return {
    notCarried: response.headers?.get?.('x-batshit-backup-not-carried') || null,
    ...(partial ? { missingUploads: response.headers?.get?.('x-batshit-backup-missing-uploads') || null } : {})
  };
}
