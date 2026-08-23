import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BACKUP_CONTENT_TYPE = 'application/zip';

export function createBackupExportFilename(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('Backup export filename requires a valid date.');
  }
  return `batshit-backup-${now
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

export async function writeBackupResponseToFile(response, targetPath) {
  if (!response?.ok) {
    throw new Error(await describeBackupExportFailure(response));
  }
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

  const parent = dirname(targetPath);
  const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
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
  const origin = new URL(exportUrl).origin;
  const response = await electronSession.fetch(exportUrl, {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'application/zip',
      'Content-Type': 'application/json',
      Origin: origin
    },
    body: JSON.stringify({
      includeSecrets,
      confirmIncludeSecrets: includeSecrets
    })
  });
  await writeBackupResponseToFile(response, targetPath);
}
