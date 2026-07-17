import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl,
  normalizeUploadUrlForStorage,
  resolveUploadUrlsForBrowserInPayload,
  rewriteInternalBatshitServerUrlsInPayload
} from '$lib/server/services/batshitServerUrls'
import type { GoonAnimationLibrary, GoonFileRef, GoonMotionMetadata } from '$lib/types/goons'
import { resolveGoonAnimationName } from '$lib/goons/animationLoadPlan'
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
// .glb/.gltf entries serve the GLB-lane (first-party base / expert-custom-glb)
// goons; they must carry tracks targeting the goon skeleton's node names.
const GLB_EXTENSION = '.glb'
const GLTF_EXTENSION = '.gltf'
const SUPPORTED_EXTENSIONS = new Set([
  VRMA_EXTENSION,
  FBX_EXTENSION,
  GLB_EXTENSION,
  GLTF_EXTENSION
])

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
    url: normalizeUploadUrlForStorage(url),
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
    url: typeof raw.url === 'string' ? normalizeUploadUrlForStorage(raw.url) : '',
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
    metaUpdatedAt: typeof raw.metaUpdatedAt === 'string' ? raw.metaUpdatedAt : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((entry): entry is string => typeof entry === 'string') : undefined,
    motionMeta: normalizeMotionMeta(raw.motionMeta),
    previewVideo: normalizeNestedFileRef(raw.previewVideo)
  }
}

// Unified motion library pairing: same-base-name files (one motion, VRMA +
// GLB versions) share their user-facing metadata. The pair key is the same
// sanitized name cues and engine clip registration resolve.
function resolveMotionPairKey(file: GoonFileRef) {
  return resolveGoonAnimationName(file, file.filename || file.url || '')
}

function isSameMotionPair(left: GoonFileRef, right: GoonFileRef) {
  const key = resolveMotionPairKey(left)
  return Boolean(key) && key === resolveMotionPairKey(right)
}

function isGlbLaneFileRef(file: GoonFileRef) {
  const label = (file.originalName || file.filename || file.url || '').toLowerCase()
  return label.endsWith('.glb') || label.endsWith('.gltf')
}

// Same motion, same lane: an upload of a name+format the library already has
// is a REPLACEMENT of that version, never a duplicate card entry.
function isSameMotionSameLane(left: GoonFileRef, right: GoonFileRef) {
  return isSameMotionPair(left, right) && isGlbLaneFileRef(left) === isGlbLaneFileRef(right)
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

    return json({ library: resolveUploadUrlsForBrowserInPayload(library) })
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
    const replaceValue = form.get('replaceExisting')
    const replaceExisting = replaceValue === '1' || replaceValue === 'true'

    if (!file) {
      return json({ error: 'No file uploaded.' }, { status: 400 })
    }

    const extension = getExtension(file.name)
    if (!isSupportedExtension(file.name)) {
      return json(
        { error: 'Goon animation library accepts .vrma, .glb, or .fbx files.' },
        { status: 400 }
      )
    }

    // Same-name-same-format uploads REPLACE that version, but only with the
    // caller's explicit consent — the UI prompts first so a coincidental name
    // match (e.g. two different files both called "Dance") can't silently
    // overwrite a motion. Checked before conversion/upload so a refused
    // upload leaves no orphaned asset behind.
    const uploadLaneIsGlb = extension === GLB_EXTENSION || extension === GLTF_EXTENSION
    const uploadPairKey = resolveGoonAnimationName(
      { url: '', filename: file.name, originalName: file.name },
      file.name
    )
    if (!replaceExisting) {
      const conflictEntry = await redis.execute(async (client) => {
        const existing = (await client.json.get(
          `user:${locals.user!.id}:goons_animation_library`
        )) as GoonAnimationLibrary | null
        const library = normalizeLibrary(existing)
        return (
          library.vrma.find(
            (entry) =>
              resolveMotionPairKey(entry) === uploadPairKey &&
              isGlbLaneFileRef(entry) === uploadLaneIsGlb
          ) ?? null
        )
      })
      if (conflictEntry) {
        const laneLabel = uploadLaneIsGlb ? 'GLB' : 'VRMA'
        return json(
          {
            error: `A motion named "${uploadPairKey}" already has a ${laneLabel} version. Confirm the replacement, or rename the file to keep both.`,
            code: 'motion_version_exists',
            conflict: {
              motionName: uploadPairKey,
              lane: uploadLaneIsGlb ? 'glb' : 'vrm',
              existingFilename: conflictEntry.filename,
              displayName: conflictEntry.displayName ?? null
            }
          },
          { status: 409 }
        )
      }
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

    const { library: updated, replacedEntry } = await redis.execute(async (client) => {
      const key = `user:${locals.user!.id}:goons_animation_library`
      const existing = (await client.json.get(key)) as GoonAnimationLibrary | null
      const library = normalizeLibrary(existing)
      const current = Array.isArray(library.vrma) ? library.vrma : []

      let replaced: GoonFileRef | null = null
      let next: GoonFileRef[]

      if (current.some((entry) => entry.filename === animationFile.filename)) {
        next = current.map((entry) =>
          entry.filename !== animationFile.filename ? entry : mergeFileRefUpdate(entry, animationFile)
        )
      } else {
        // Uploading a name+format the library already has REPLACES that
        // version in place (keeps its card position and settings, drops its
        // stale preview video) — never a duplicate card entry. An other-lane
        // pair mate only donates metadata (lockstep inheritance).
        const sameLaneMatch =
          current.find((entry) => isSameMotionSameLane(entry, animationFile)) ?? null
        const metadataSource =
          sameLaneMatch ?? current.find((entry) => isSameMotionPair(entry, animationFile)) ?? null
        if (metadataSource) {
          if (metadataSource.displayName) animationFile.displayName = metadataSource.displayName
          if (Array.isArray(metadataSource.tags) && metadataSource.tags.length > 0) {
            animationFile.tags = [...metadataSource.tags]
          }
          if (metadataSource.motionMeta) animationFile.motionMeta = { ...metadataSource.motionMeta }
          if (metadataSource.metaUpdatedAt) animationFile.metaUpdatedAt = metadataSource.metaUpdatedAt
        }
        if (sameLaneMatch) {
          replaced = sameLaneMatch
          next = current.map((entry) => (entry === sameLaneMatch ? animationFile : entry))
        } else {
          next = [...current, animationFile]
        }
      }

      const nextLibrary: GoonAnimationLibrary = {
        ...library,
        vrma: next,
        created_at: library.created_at ?? now,
        updated_at: now
      }

      await client.json.set(key, '$', nextLibrary as any)
      return { library: nextLibrary, replacedEntry: replaced }
    })

    // The replaced version's stored file and stale preview video are no
    // longer referenced by the library — clean them up like a delete would.
    if (replacedEntry) {
      const references = await redis.execute((client) =>
        collectGoonUploadReferencesForClient(client as any, locals.user!.id)
      )
      if (
        replacedEntry.filename &&
        replacedEntry.filename !== animationFile.filename &&
        !hasGoonUploadReference(references, 'goon_animations', replacedEntry.filename)
      ) {
        await deleteGoonUploadAsset('goon_animations', replacedEntry.filename)
      }
      if (
        replacedEntry.previewVideo?.filename &&
        !hasGoonUploadReference(references, 'goon_animation_previews', replacedEntry.previewVideo.filename)
      ) {
        await deleteGoonUploadAsset('goon_animation_previews', replacedEntry.previewVideo.filename)
      }
    }

    return json({
      library: resolveUploadUrlsForBrowserInPayload(updated),
      animation: resolveUploadUrlsForBrowserInPayload(animationFile)
    })
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
      const target = current.find((entry) => entry.filename === filename)
      if (!target) {
        return null
      }

      // Metadata lockstep: edits apply to the whole motion (the target file
      // plus every paired same-base-name version), stamped so divergence
      // resolution can pick the most recently edited side.
      const editedAt = new Date().toISOString()
      const next = current.map((entry) => {
        if (entry.filename !== filename && !isSameMotionPair(entry, target)) return entry
        const nextEntry: GoonFileRef = {
          ...entry,
          tags,
          metaUpdatedAt: editedAt
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

    return json({ library: resolveUploadUrlsForBrowserInPayload(updated) })
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
    const filenames = Array.isArray(payload?.filenames)
      ? (payload.filenames as unknown[]).filter(
          (entry): entry is string => typeof entry === 'string' && entry.length > 0
        )
      : []
    // Whole-motion delete sends every version's filename; per-version remove
    // sends a single filename.
    const targetFilenames = Array.from(new Set(filename ? [filename, ...filenames] : filenames))
    if (targetFilenames.length === 0) {
      return json({ error: 'Missing filename.' }, { status: 400 })
    }

	    const result = await redis.execute(async (client) => {
	      const key = `user:${locals.user!.id}:goons_animation_library`
	      const existing = (await client.json.get(key)) as GoonAnimationLibrary | null
	      const library = normalizeLibrary(existing)
	      const current = Array.isArray(library.vrma) ? library.vrma : []
	      const targetSet = new Set(targetFilenames)
	      const removedEntries = current.filter((entry) => targetSet.has(entry.filename))
	      const next = current.filter((entry) => !targetSet.has(entry.filename))

	      const nextLibrary: GoonAnimationLibrary = {
	        ...library,
	        vrma: next,
	        updated_at: new Date().toISOString()
	      }

	      await client.json.set(key, '$', nextLibrary as any)
	      return { library: nextLibrary, removedEntries }
	    })

	    const references = await redis.execute((client) =>
	      collectGoonUploadReferencesForClient(client as any, locals.user!.id)
	    )
	    for (const targetFilename of targetFilenames) {
	      if (!hasGoonUploadReference(references, 'goon_animations', targetFilename)) {
	        await deleteGoonUploadAsset('goon_animations', targetFilename)
	      }
	    }
	    for (const removedEntry of result.removedEntries) {
	      if (
	        removedEntry?.previewVideo?.filename &&
	        !hasGoonUploadReference(references, 'goon_animation_previews', removedEntry.previewVideo.filename)
	      ) {
	        await deleteGoonUploadAsset('goon_animation_previews', removedEntry.previewVideo.filename)
	      }
	    }

	    return json({ library: resolveUploadUrlsForBrowserInPayload(result.library) })
  } catch (error) {
    console.error('Error deleting goon animation library file:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to delete animation' },
      { status: 500 }
    )
  }
}
