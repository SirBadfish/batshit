import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const MAX_STORED_JSON_BYTES = 16 * 1024 * 1024

export type StoredUploadJsonReader = {
  json: {
    get(key: string): Promise<unknown>
  }
}

export class StoredUploadJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoredUploadJsonError'
  }
}

function fail(message: string): never {
  throw new StoredUploadJsonError(message)
}

function resolveUploadsDir(): string {
  const explicit = process.env.UPLOADS_DIR?.trim()
  if (explicit) return path.resolve(explicit)
  return path.resolve(process.cwd(), '../batshit-server/server/uploads')
}

function assertSafeFilename(filename: string): void {
  if (!filename || path.posix.basename(filename) !== filename || path.basename(filename) !== filename) {
    fail('has an invalid filename')
  }
}

/**
 * Read JSON text from either the legacy inline upload shape or the current
 * filesystem-backed upload record. Filesystem paths are reconstructed from
 * the trusted upload root and exact key identity; Redis-owned absolute paths
 * are never followed directly.
 */
export async function readStoredUploadJsonText(
  upload: Record<string, unknown>,
  uploadType: string,
  filename: string
): Promise<string | null> {
  const inline = upload.textContent
  if (typeof inline === 'string' && inline.trim()) return inline

  if (upload.storage !== 'filesystem') return null
  assertSafeFilename(filename)
  if (upload.uploadType !== uploadType) fail('has a mismatched upload type')

  const expectedRelativePath = `${uploadType}/${filename}`
  const relativePath =
    typeof upload.relativePath === 'string' ? upload.relativePath.trim().replace(/\\/g, '/') : ''
  if (relativePath !== expectedRelativePath) fail('has an invalid filesystem path')

  const uploadRoot = resolveUploadsDir()
  const absolutePath = path.resolve(uploadRoot, ...relativePath.split('/'))
  const rootPrefix = uploadRoot.endsWith(path.sep) ? uploadRoot : `${uploadRoot}${path.sep}`
  if (!absolutePath.startsWith(rootPrefix)) fail('escapes the upload directory')

  let info
  try {
    info = await stat(absolutePath)
  } catch {
    fail('filesystem content is missing')
  }
  if (!info.isFile()) fail('filesystem content is not a file')
  if (info.size <= 0) return null
  if (info.size > MAX_STORED_JSON_BYTES) fail('filesystem content is too large')
  if (typeof upload.size === 'number' && upload.size !== info.size) {
    fail('filesystem content size does not match its upload record')
  }

  try {
    return await readFile(absolutePath, 'utf8')
  } catch {
    fail('filesystem content could not be read')
  }
}

/**
 * Resolve and parse the manifest upload owned by one Custom Goon record.
 * Callers add their contract-specific error prefix so the API can return a
 * precise 400 response without duplicating the filesystem trust checks.
 */
export async function readStoredGoonManifest(
  client: StoredUploadJsonReader,
  filename: string
): Promise<Record<string, unknown>> {
  const upload = await client.json.get(`upload:goon_custom_manifests:${filename}`)
  if (!upload || typeof upload !== 'object' || Array.isArray(upload)) {
    fail('current Custom Goon manifest upload is missing')
  }

  const textContent = await readStoredUploadJsonText(
    upload as Record<string, unknown>,
    'goon_custom_manifests',
    filename
  )
  if (!textContent?.trim()) {
    fail('current Custom Goon manifest upload has no JSON content')
  }

  let manifest: unknown
  try {
    manifest = JSON.parse(textContent)
  } catch {
    fail('current Custom Goon manifest upload is invalid JSON')
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('current Custom Goon manifest must be a JSON object')
  }
  return manifest as Record<string, unknown>
}
