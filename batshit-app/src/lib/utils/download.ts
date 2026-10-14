import { browser } from '$app/environment'
import type { BackupPartialRequest } from '$lib/utils/backupPartialSummary'

type ZeroNativeSaveFileOptions = {
  title?: string
  defaultPath?: string
  defaultName?: string
}

type ZeroNativeApi = {
  dialogs?: {
    saveFile?: (options?: ZeroNativeSaveFileOptions) => Promise<string | null>
  }
  downloads?: {
    exportBackup?: (options: { includeSecrets: boolean; partial?: BackupPartialRequest }) => Promise<DownloadResult>
  }
}

type DownloadOptions = {
  title?: string
  mimeType?: string
}

export type DownloadResult = {
  completed: boolean
  native: boolean
  canceled: boolean
  path?: string
  /** Backup export only: the route's `X-Batshit-Backup-Not-Carried` value (BL-373/BL-369). */
  notCarried?: string
  /**
   * Partial backup export only (BL-378 Phase 1b): the route's `X-Batshit-Backup-Missing-Uploads`
   * value, as text. The panel reads it with the shared strict parser, never on trust.
   */
  missingUploads?: string
}

function sanitizeFilename(filename: string): string {
  const trimmed = filename.trim()
  if (!trimmed) return 'download'
  return trimmed.replace(/[/:\\\0]/g, '-')
}

function browserDownloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = sanitizeFilename(filename)
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    URL.revokeObjectURL(url)
  }
}

function encodePathForHeader(path: string): string {
  const bytes = new TextEncoder().encode(path)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function resolveZeroNative(): ZeroNativeApi | null {
  if (!browser) return null
  const maybeZero = (window as typeof window & { zero?: ZeroNativeApi }).zero
  return maybeZero && typeof maybeZero === 'object' ? maybeZero : null
}

export async function exportBackupNatively(
  includeSecrets: boolean,
  partial?: BackupPartialRequest
): Promise<DownloadResult | null> {
  const zero = resolveZeroNative()
  if (typeof zero?.downloads?.exportBackup !== 'function') return null
  const result = await zero.downloads.exportBackup(partial ? { includeSecrets, partial } : { includeSecrets })
  if (
    !result ||
    typeof result.completed !== 'boolean' ||
    result.native !== true ||
    typeof result.canceled !== 'boolean' ||
    (result.path !== undefined && typeof result.path !== 'string') ||
    (result.notCarried !== undefined && typeof result.notCarried !== 'string')
  ) {
    throw new Error('The Mac backup export returned an invalid result.')
  }
  // A finished download stays finished: a summary that is not text is only "unavailable" (the
  // panel's parser says so), never a reason to call the written backup a failure.
  if (result.missingUploads !== undefined && typeof result.missingUploads !== 'string') {
    return { ...result, missingUploads: undefined }
  }
  return result
}

async function tryNativeDownload(
  blob: Blob,
  filename: string,
  options: DownloadOptions = {}
): Promise<DownloadResult | null> {
  const zero = resolveZeroNative()
  if (!zero?.dialogs?.saveFile) return null

  const targetPath = await zero.dialogs.saveFile({
    title: options.title || 'Save File',
    defaultName: sanitizeFilename(filename)
  })
  if (!targetPath) {
    return { completed: false, native: true, canceled: true }
  }

  const response = await fetch('/api/native-downloads/save', {
    method: 'POST',
    headers: {
      'Content-Type': options.mimeType || blob.type || 'application/octet-stream',
      'X-Batshit-Download-Path': encodePathForHeader(targetPath)
    },
    body: blob
  })

  if (!response.ok) {
    let message = 'Failed to save file'
    try {
      const data = await response.json()
      message = data?.error || data?.message || message
    } catch {
      message = (await response.text().catch(() => '')) || message
    }
    throw new Error(message)
  }

  return { completed: true, native: true, canceled: false, path: targetPath }
}

export async function downloadBlob(
  blob: Blob,
  filename: string,
  options: DownloadOptions = {}
): Promise<DownloadResult> {
  if (!browser) {
    throw new Error('Downloads are only available in the browser.')
  }

  const nativeResult = await tryNativeDownload(blob, filename, options)
  if (nativeResult) return nativeResult

  browserDownloadBlob(blob, filename)
  return { completed: true, native: false, canceled: false }
}

export async function downloadText(
  content: string,
  filename: string,
  options: DownloadOptions = {}
): Promise<DownloadResult> {
  return downloadBlob(
    new Blob([content], { type: options.mimeType || 'text/plain' }),
    filename,
    options
  )
}
