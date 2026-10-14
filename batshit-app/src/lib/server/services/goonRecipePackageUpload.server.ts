import {
  RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
  createRecipeArchiveContainmentReceipt,
  verifyRecipeArchiveContainmentReceipt,
  type RecipeArchiveContainmentReceipt,
  type RecipeAssetSet,
  type RecipeStoredAssetRef
} from '$lib/goons/recipe'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl
} from './batshitServerUrls'

const UPLOAD_ATTEMPT_TIMEOUT_MS = 120_000
const UPLOAD_ATTEMPTS = 2

type UploadFile = { url: string; filename: string; size?: number }
type UploadFiles = { package: UploadFile; model: UploadFile; manifest: UploadFile }

class PermanentUploadError extends Error {}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} is missing or malformed.`)
  }
  return value as Record<string, unknown>
}

function uploadFiles(value: unknown): UploadFiles {
  const files = record(value, 'Recipe upload files')
  const result = {} as UploadFiles
  for (const role of ['package', 'model', 'manifest'] as const) {
    const file = record(files[role], `Recipe upload ${role} file`)
    if (typeof file.url !== 'string' || !file.url ||
        typeof file.filename !== 'string' || !file.filename) {
      throw new Error(`Recipe upload ${role} file is incomplete.`)
    }
    if (file.size !== undefined &&
        (typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 1)) {
      throw new Error(`Recipe upload ${role} file size is invalid.`)
    }
    result[role] = file as UploadFile
  }
  return result
}

/** Trust only batshit-server's extraction contract and its matching stored refs. */
export async function createTrustedRecipeArchiveReceipt(
  extraction: unknown,
  fileValue: unknown
): Promise<RecipeArchiveContainmentReceipt> {
  const files = uploadFiles(fileValue)
  const extracted = record(extraction, 'Recipe archive extraction')
  const extractor = record(extracted.extractor, 'Recipe archive extractor')
  if (
    extracted.contract !== 'recipe-archive-extraction/v1' ||
    extractor.id !== 'batshit-server-recipe-archive' ||
    extractor.version !== 1
  ) {
    throw new Error('batshit-server did not return a trusted Recipe archive extraction result')
  }
  const receipt = await createRecipeArchiveContainmentReceipt({
    contract: RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
    archiveFormat: 'zip',
    extractor: extracted.extractor,
    archive: extracted.archive,
    entryCount: extracted.entryCount,
    totalUncompressedBytes: extracted.totalUncompressedBytes,
    members: extracted.members
  } as Parameters<typeof createRecipeArchiveContainmentReceipt>[0])
  const expectedRefs = [
    `/uploads/goon_custom_packages/${files.package.filename}`,
    `/uploads/goon_custom_models/${files.model.filename}`,
    `/uploads/goon_custom_manifests/${files.manifest.filename}`
  ]
  const actualRefs = [
    receipt.archive.ref,
    receipt.members.find((member) => member.role === 'model')?.extracted.ref,
    receipt.members.find((member) => member.role === 'manifest')?.extracted.ref
  ]
  if (expectedRefs.some((ref) => !actualRefs.includes(ref))) {
    throw new Error('Recipe archive extraction refs do not match the stored upload assets')
  }
  return verifyRecipeArchiveContainmentReceipt(receipt)
}

function uploadPath(value: string): string | null {
  if (value.startsWith('/uploads/')) return value
  try {
    const parsed = new URL(value)
    return parsed.pathname.startsWith('/uploads/') ? parsed.pathname : null
  } catch {
    return null
  }
}

function assertUploadFile(file: UploadFile, asset: RecipeStoredAssetRef, role: keyof RecipeAssetSet) {
  if (uploadPath(file.url) !== asset.ref || file.filename !== asset.ref.split('/').pop()) {
    throw new Error(`Uploaded Live ${role} file does not match its verified archive receipt.`)
  }
  if (file.size !== undefined && file.size !== asset.bytes) {
    throw new Error(`Uploaded Live ${role} byte count does not match its verified archive receipt.`)
  }
}

function liveFromReceipt(receipt: RecipeArchiveContainmentReceipt, files: UploadFiles): RecipeAssetSet {
  const model = receipt.members.find((member) => member.role === 'model')
  const manifest = receipt.members.find((member) => member.role === 'manifest')
  if (!model || !manifest) throw new Error('Verified Live archive receipt is incomplete.')
  const live: RecipeAssetSet = {
    package: receipt.archive,
    model: model.extracted,
    manifest: manifest.extracted
  }
  for (const role of ['package', 'model', 'manifest'] as const) {
    assertUploadFile(files[role], live[role], role)
  }
  return live
}

async function boundedUploadAttempt(
  file: File,
  url: string,
  headers: Record<string, string>
): Promise<{ archiveReceipt: RecipeArchiveContainmentReceipt; live: RecipeAssetSet }> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('Recipe package upload did not settle within 120 seconds.'))
    }, UPLOAD_ATTEMPT_TIMEOUT_MS)
  })
  const operation = (async () => {
    const form = new FormData()
    form.append('file', file, file.name)
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: form,
      signal: controller.signal
    })
    if (response.status >= 400 && response.status < 500) {
      throw new PermanentUploadError(`Recipe package upload was rejected (${response.status}).`)
    }
    if (!response.ok) throw new Error(`Recipe package upload failed (${response.status}).`)
    const payload = record(await response.json(), 'Recipe package upload response')
    const files = uploadFiles(payload.files)
    const archiveReceipt = await createTrustedRecipeArchiveReceipt(payload.archiveExtraction, files)
    return { archiveReceipt, live: liveFromReceipt(archiveReceipt, files) }
  })()
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Upload the exact constructed ZIP, with one bounded identical-byte recovery attempt. */
export async function uploadConstructedRecipePackage(
  packageBytes: Uint8Array,
  filename: string
): Promise<{ archiveReceipt: RecipeArchiveContainmentReceipt; live: RecipeAssetSet }> {
  if (!(packageBytes instanceof Uint8Array) || packageBytes.byteLength === 0) {
    throw new Error('Constructed Recipe package bytes are required.')
  }
  if (filename.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:bgoon|zip)$/i.test(filename)) {
    throw new Error('Constructed Recipe package filename is invalid.')
  }
  const url = `${getInternalBatshitServerUrl()}/api/upload/goon-custom-package`
  const headers = getInternalBatshitServerAuthHeaders()
  // File snapshots these bytes once. Both attempts send the same content even
  // if the caller's Uint8Array changes while an uncertain upload settles.
  const file = new File([packageBytes as unknown as BlobPart], filename, { type: 'application/zip' })
  let lastError: unknown
  for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      return await boundedUploadAttempt(file, url, headers)
    } catch (error) {
      if (error instanceof PermanentUploadError) throw error
      lastError = error
    }
  }
  throw lastError
}
