import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl,
  rewriteInternalBatshitServerUrlsInPayload
} from '$lib/server/services/batshitServerUrls'
import type { GoonAnimationLibrary, GoonFileRef, GoonMotionMetadata } from '$lib/types/goons'
import {
  collectGoonUploadReferencesForClient,
  deleteGoonUploadAsset,
  hasGoonUploadReference
} from '$lib/server/services/goonAssetCleanupService'
import path from 'node:path'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { convertFbxToVrmaFile } from '$lib/server/converters/fbx2vrma'
import { resolveInstalledBinary } from '$lib/server/converters/fbx2vrmaInstaller'
import {
  convertFbxToVrmaWithDockerWorker,
  isBatshitContainerizedRuntime
} from '$lib/server/services/fbx2vrmaWorker'
import { bytesToFile } from '$lib/utils/binary'

const VRMA_EXTENSION = '.vrma'
const FBX_EXTENSION = '.fbx'
const SUPPORTED_EXTENSIONS = new Set([VRMA_EXTENSION, FBX_EXTENSION])

function getExtension(filename: string) {
  return path.extname(filename || '').toLowerCase()
}

function isSupportedExtension(filename: string) {
  return SUPPORTED_EXTENSIONS.has(getExtension(filename))
}

async function convertFbxToVrma(sourceFile: File) {
  if (isBatshitContainerizedRuntime()) {
    const converted = await convertFbxToVrmaWithDockerWorker(sourceFile)
    return { file: converted.file, size: converted.size }
  }

  const installed = await resolveInstalledBinary()
  if (!installed?.path) {
    throw new Error(
      'FBX converter not installed. Install it in Settings → Admin.'
    )
  }

  const tempRoot = await fs.mkdtemp(path.join(tmpdir(), 'batshit-fbx2vrma-'))
  const ext = getExtension(sourceFile.name) || FBX_EXTENSION
  const baseName = path.basename(sourceFile.name, ext)
  const inputPath = path.join(tempRoot, `${baseName || randomUUID()}${ext}`)
  const outputName = `${baseName || 'animation'}${VRMA_EXTENSION}`
  const outputPath = path.join(tempRoot, outputName)

  try {
    const buffer = Buffer.from(await sourceFile.arrayBuffer())
    await fs.writeFile(inputPath, buffer)

    await convertFbxToVrmaFile({
      inputPath,
      outputPath,
      fbx2gltfPath: installed.path
    })

    const vrmaBuffer = await fs.readFile(outputPath)
    const convertedFile = bytesToFile(vrmaBuffer, outputName, { type: 'model/vrm' })

    return { file: convertedFile, size: vrmaBuffer.length }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

function normalizeLibrary(value: unknown): GoonAnimationLibrary {
  if (!value || typeof value !== 'object') {
    return { vrma: [] }
  }
  const record = value as GoonAnimationLibrary
  return {
    ...record,
    vrma: Array.isArray(record.vrma) ? record.vrma.map((entry) => normalizeFileRef(entry)) : []
  }
}

function normalizeNestedFileRef(value: unknown): GoonFileRef | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const url = typeof raw.url === 'string' ? raw.url : ''
  const filename = typeof raw.filename === 'string' ? raw.filename : ''
  if (!url || !filename) return undefined
  return {
    url,
    filename,
    originalName: typeof raw.originalName === 'string' ? raw.originalName : undefined,
    size: typeof raw.size === 'number' ? raw.size : undefined,
    mimeType:
      typeof raw.mimeType === 'string'
        ? raw.mimeType
        : typeof raw.mimetype === 'string'
          ? raw.mimetype
          : undefined,
    uploadedAt:
      typeof raw.uploadedAt === 'string'
        ? raw.uploadedAt
        : typeof raw.uploaded_at === 'string'
          ? raw.uploaded_at
          : undefined
  }
}

function normalizeFileRef(value: unknown): GoonFileRef {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    url: typeof raw.url === 'string' ? raw.url : '',
    filename: typeof raw.filename === 'string' ? raw.filename : '',
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName.trim() : undefined,
    originalName:
      typeof raw.originalName === 'string'
        ? raw.originalName
        : typeof raw.originalname === 'string'
          ? raw.originalname
          : undefined,
    size: typeof raw.size === 'number' ? raw.size : undefined,
    mimeType:
      typeof raw.mimeType === 'string'
        ? raw.mimeType
        : typeof raw.mimetype === 'string'
          ? raw.mimetype
          : undefined,
    uploadedAt:
      typeof raw.uploadedAt === 'string'
        ? raw.uploadedAt
        : typeof raw.uploaded_at === 'string'
          ? raw.uploaded_at
          : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((entry): entry is string => typeof entry === 'string') : undefined,
    motionMeta: normalizeMotionMeta(raw.motionMeta),
    previewVideo: normalizeNestedFileRef(raw.previewVideo)
  }
}

function mergeFileRefUpdate(existing: GoonFileRef, incoming: GoonFileRef): GoonFileRef {
  const next: GoonFileRef = { ...existing }
  const writableNext = next as Record<string, unknown>
  for (const [key, value] of Object.entries(incoming) as Array<[keyof GoonFileRef, unknown]>) {
    if (value !== undefined) {
      writableNext[key] = value
    }
  }
  return next
}

function normalizeDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function normalizeTags(value: unknown): string[] {
  if (!value) return []
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const tags = raw
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean)
  return Array.from(new Set(tags))
}

function normalizeMotionMeta(value: unknown): GoonMotionMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const posture =
    typeof record.posture === 'string' && record.posture.trim()
      ? record.posture.trim()
      : undefined
  const playback =
    record.playback === 'loop' || record.playback === 'oneshot' ? record.playback : undefined
  const eyeContact = record.eyeContact === 'off' ? record.eyeContact : undefined

  if (!posture && !playback && !eyeContact) return undefined
  return {
    ...(posture ? { posture } : {}),
    ...(playback ? { playback } : {}),
    ...(eyeContact ? { eyeContact } : {})
  }
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const library = await redis.execute(async (client) => {
      const existing = (await client.json.get(
        `user:${locals.user!.id}:goons_animation_library`
      )) as GoonAnimationLibrary | null
      return normalizeLibrary(existing)
    })

    return json({ library })
  } catch (error) {
    console.error('Error loading goon animation library:', error)
    return json({ error: 'Failed to load animation library' }, { status: 500 })
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const form = await request.formData()
    const fileValue = form.get('file')
    const file = fileValue instanceof File ? fileValue : null

    if (!file) {
      return json({ error: 'No file uploaded.' }, { status: 400 })
    }

    const extension = getExtension(file.name)
    if (!isSupportedExtension(file.name)) {
      return json(
        { error: 'Goon animation library accepts .vrma or .fbx files.' },
        { status: 400 }
      )
    }

    let uploadFile = file
    let uploadSize = file.size
    let sourceName = file.name

    if (extension === FBX_EXTENSION) {
      const converted = await convertFbxToVrma(file)
      uploadFile = converted.file
      uploadSize = converted.size
    }

    const uploadForm = new FormData()
    uploadForm.append('file', uploadFile, uploadFile.name)

    const uploadResponse = await fetch(`${getInternalBatshitServerUrl()}/api/upload/goon-animation`, {
      method: 'POST',
      headers: getInternalBatshitServerAuthHeaders(),
      body: uploadForm
    })

    if (!uploadResponse.ok) {
      const text = await uploadResponse.text().catch(() => '')
      throw new Error(text || 'Goon animation upload failed')
    }

    const uploadPayload = rewriteInternalBatshitServerUrlsInPayload(
      await uploadResponse.json()
    )
    const fileInfo = uploadPayload?.file

    if (!fileInfo?.url || !fileInfo?.filename) {
      return json({ error: 'Goon animation upload failed to return a URL.' }, { status: 500 })
    }

    const animationFile = normalizeFileRef({
      url: fileInfo.url,
      filename: fileInfo.filename,
      originalName:
        extension === FBX_EXTENSION
          ? sourceName
          : fileInfo.originalName || uploadFile.name,
      size: fileInfo.size ?? uploadSize,
      mimeType: fileInfo.mimetype ?? uploadFile.type,
      uploadedAt: fileInfo.uploadedAt ?? new Date().toISOString()
    })

    const now = new Date().toISOString()

    const updated = await redis.execute(async (client) => {
      const key = `user:${locals.user!.id}:goons_animation_library`
      const existing = (await client.json.get(key)) as GoonAnimationLibrary | null
      const library = normalizeLibrary(existing)
      const current = Array.isArray(library.vrma) ? library.vrma : []
      const next = current.some((entry) => entry.filename === animationFile.filename)
        ? current.map((entry) =>
            entry.filename !== animationFile.filename ? entry : mergeFileRefUpdate(entry, animationFile)
          )
        : [...current, animationFile]

      const nextLibrary: GoonAnimationLibrary = {
        ...library,
        vrma: next,
        created_at: library.created_at ?? now,
        updated_at: now
      }

      await client.json.set(key, '$', nextLibrary as any)
      return nextLibrary
    })

    return json({ library: updated, animation: animationFile })
  } catch (error) {
    console.error('Error uploading goon animation library file:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to upload animation' },
      { status: 500 }
    )
  }
}

export const PATCH: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const payload = await request.json().catch(() => ({}))
    const filename = typeof payload?.filename === 'string' ? payload.filename : ''
    if (!filename) {
      return json({ error: 'Missing filename.' }, { status: 400 })
    }
    const hasDisplayName = Object.prototype.hasOwnProperty.call(payload ?? {}, 'displayName')
    const displayName = normalizeDisplayName(payload?.displayName)
    const tags = normalizeTags(payload?.tags)
    const motionMeta = normalizeMotionMeta(payload?.motionMeta)

    const updated = await redis.execute(async (client) => {
      const key = `user:${locals.user!.id}:goons_animation_library`
      const existing = (await client.json.get(key)) as GoonAnimationLibrary | null
      const library = normalizeLibrary(existing)
      const current = Array.isArray(library.vrma) ? library.vrma : []
      if (!current.some((entry) => entry.filename === filename)) {
        return null
      }

      const next = current.map((entry) => {
        if (entry.filename !== filename) return entry
        const nextEntry: GoonFileRef = {
          ...entry,
          tags
        }
        if (motionMeta) {
          nextEntry.motionMeta = motionMeta
        } else {
          delete nextEntry.motionMeta
        }
        if (hasDisplayName) {
          if (displayName) {
            nextEntry.displayName = displayName
          } else {
            delete nextEntry.displayName
          }
        }
        return nextEntry
      })

      const nextLibrary: GoonAnimationLibrary = {
        ...library,
        vrma: next,
        updated_at: new Date().toISOString()
      }

      await client.json.set(key, '$', nextLibrary as any)
      return nextLibrary
    })

    if (!updated) {
      return json({ error: 'Animation not found.' }, { status: 404 })
    }

    return json({ library: updated })
  } catch (error) {
    console.error('Error updating animation tags:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to update animation tags' },
      { status: 500 }
    )
  }
}

export const DELETE: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const payload = await request.json().catch(() => ({}))
    const filename = typeof payload?.filename === 'string' ? payload.filename : ''
    if (!filename) {
      return json({ error: 'Missing filename.' }, { status: 400 })
    }

	    const result = await redis.execute(async (client) => {
	      const key = `user:${locals.user!.id}:goons_animation_library`
	      const existing = (await client.json.get(key)) as GoonAnimationLibrary | null
	      const library = normalizeLibrary(existing)
	      const current = Array.isArray(library.vrma) ? library.vrma : []
	      const removedEntry = current.find((entry) => entry.filename === filename) ?? null
	      const next = current.filter((entry) => entry.filename !== filename)

	      const nextLibrary: GoonAnimationLibrary = {
	        ...library,
	        vrma: next,
	        updated_at: new Date().toISOString()
	      }

	      await client.json.set(key, '$', nextLibrary as any)
	      return { library: nextLibrary, removedEntry }
	    })

	    const references = await redis.execute((client) =>
	      collectGoonUploadReferencesForClient(client as any, locals.user!.id)
	    )
	    if (!hasGoonUploadReference(references, 'goon_animations', filename)) {
	      await deleteGoonUploadAsset('goon_animations', filename)
	    }
	    const removedEntry = result.removedEntry
	    if (
	      removedEntry?.previewVideo?.filename &&
	      !hasGoonUploadReference(references, 'goon_animation_previews', removedEntry.previewVideo.filename)
	    ) {
	      await deleteGoonUploadAsset('goon_animation_previews', removedEntry.previewVideo.filename)
	    }

	    return json({ library: result.library })
  } catch (error) {
    console.error('Error deleting goon animation library file:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to delete animation' },
      { status: 500 }
    )
  }
}
