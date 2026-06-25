import { error, json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import type { ClipRow, UserSettingsRow } from '$lib/types/database'
import {
  requireArtifactRuntimeClaims,
  type ArtifactRuntimeClaims
} from '$lib/server/services/artifactRuntimeAuth'
import {
  buildTunnelPathFromLocalUrl,
  resolveClipTunnelUrl
} from '$lib/server/services/clipUrlResolver'
import { resolveClipDataUrlFromStoredUpload } from '$lib/server/services/clipUploadPayload'

const MAX_CLIP_SOURCE_DATA_URI_CHARS = 10_000_000

type ClipRecord = ClipRow & {
  systemClip?: boolean
  fullResolutionUrl?: string | null
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isImageClip(clip: ClipRecord) {
  const mimeType = trimString(clip.mimeType).toLowerCase()
  const fileType = trimString(clip.fileType).toLowerCase()
  return mimeType.startsWith('image/') || fileType === 'image'
}

function isModelReachableUrl(value: unknown) {
  const raw = trimString(value)
  if (!raw) return false

  try {
    const parsed = new URL(raw)
    const hostname = parsed.hostname.toLowerCase()
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname.endsWith('.local')
    ) {
      return false
    }
    if (/^10\./.test(hostname) || /^192\.168\./.test(hostname)) return false
    const private172 = /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    return !private172
  } catch {
    return false
  }
}

function pickPreviewUrl(clip: ClipRecord) {
  return (
    trimString(clip.thumbnailUrl) ||
    trimString(clip.displayUrl) ||
    trimString(clip.localUrl) ||
    trimString(clip.externalUrl) ||
    trimString(clip.fullResolutionUrl) ||
    null
  )
}

function clipListItem(clip: ClipRecord) {
  const fullResolutionUrl = trimString(clip.fullResolutionUrl)
  const tunnelPath =
    trimString(clip.tunnelPath) ||
    buildTunnelPathFromLocalUrl(fullResolutionUrl) ||
    buildTunnelPathFromLocalUrl(clip.localUrl) ||
    buildTunnelPathFromLocalUrl(clip.displayUrl) ||
    null

  return {
    id: clip.id,
    filename: clip.filename,
    mimeType: clip.mimeType || null,
    fileSize: clip.fileSize || null,
    createdAt: clip.created_at || null,
    updatedAt: clip.updated_at || null,
    thumbnailUrl: clip.thumbnailUrl || null,
    previewUrl: pickPreviewUrl(clip),
    hasTunnelPath: Boolean(tunnelPath),
    hasFullResolutionSource: Boolean(fullResolutionUrl),
    systemClip: clip.systemClip === true
  }
}

async function loadArtifactForClaims(claims: ArtifactRuntimeClaims, artifactId: string) {
  const artifact = await redis.json.get(`artifact:${artifactId}`)
  if (!artifact || typeof artifact !== 'object') {
    throw error(404, 'Artifact not found')
  }

  const record = artifact as Record<string, unknown>
  if (record.user_id !== claims.userId && record.mode !== 'published') {
    throw error(403, 'Artifact access denied')
  }

  return record
}

async function getRuntimeClaims(request: Request, artifactIdHint?: string | null) {
  const claims = await requireArtifactRuntimeClaims(request, artifactIdHint || undefined)
  const artifactId = artifactIdHint || claims.artifactId
  if (!artifactId) {
    throw error(400, 'Artifact ID is required')
  }
  await loadArtifactForClaims(claims, artifactId)
  return { claims, artifactId }
}

async function loadUserSettings(userId: string): Promise<UserSettingsRow | null> {
  const fromHelper = await redis.getUserSettings(userId).catch(() => null)
  if (fromHelper) return fromHelper as UserSettingsRow

  const raw = await redis.json.get(`user:${userId}:settings`, '$').catch(() => null)
  return (Array.isArray(raw) ? raw[0] ?? null : raw) as UserSettingsRow | null
}

async function listImageClips(userId: string) {
  const userClipIds = await redis.sMembers(`user:${userId}:clips`)
  const clips: ClipRecord[] = []

  for (const clipId of userClipIds) {
    const clip = (await redis.get(`clip:${userId}:${clipId}`)) as ClipRecord | null
    if (clip && isImageClip(clip)) {
      clips.push({ ...clip, systemClip: false })
    }
  }

  clips.sort((a, b) => {
    const left = new Date(a.created_at || 0).getTime()
    const right = new Date(b.created_at || 0).getTime()
    return right - left
  })

  return clips
}

async function loadImageClip(userId: string, clipId: string): Promise<ClipRecord> {
  const clip = (await redis.get(`clip:${userId}:${clipId}`)) as ClipRecord | null
  if (!clip) {
    throw error(404, 'Clip not found')
  }
  if (!isImageClip(clip)) {
    throw error(400, 'Clip is not an image')
  }
  return clip
}

async function resolveTunnelSourceUrl(clip: ClipRecord, settings: UserSettingsRow | null) {
  const fullResolutionUrl = trimString(clip.fullResolutionUrl)
  if (isModelReachableUrl(fullResolutionUrl)) return fullResolutionUrl

  const fullResolutionTunnelPath = buildTunnelPathFromLocalUrl(fullResolutionUrl)
  const tunnelUrl = await resolveClipTunnelUrl(
    {
      tunnelPath: trimString(clip.tunnelPath) || fullResolutionTunnelPath || undefined,
      localUrl: fullResolutionUrl || clip.localUrl,
      displayUrl: clip.displayUrl
    },
    settings,
    { allowAutoStart: false }
  )
  if (isModelReachableUrl(tunnelUrl)) return tunnelUrl

  const externalUrl = trimString(clip.externalUrl)
  if (isModelReachableUrl(externalUrl)) return externalUrl

  const localUrl = trimString(clip.localUrl)
  if (isModelReachableUrl(localUrl)) return localUrl

  const displayUrl = trimString(clip.displayUrl)
  if (isModelReachableUrl(displayUrl)) return displayUrl

  return null
}

async function resolveDataSource(clip: ClipRecord) {
  const dataUrl = await resolveClipDataUrlFromStoredUpload({
    ...clip,
    localUrl: trimString(clip.fullResolutionUrl) || clip.localUrl
  })
  if (!dataUrl) return null

  if (!dataUrl.toLowerCase().startsWith('data:image/')) {
    throw error(400, 'Clip source data is not an image')
  }

  if (dataUrl.length > MAX_CLIP_SOURCE_DATA_URI_CHARS) {
    throw error(
      413,
      'Clip image is too large to pass as data without a public or tunnel URL'
    )
  }

  return dataUrl
}

export const GET: RequestHandler = async ({ request, url }) => {
  const artifactId = trimString(url.searchParams.get('artifactId'))
  const { claims } = await getRuntimeClaims(request, artifactId)
  const clips = await listImageClips(claims.userId)

  return json({
    success: true,
    sources: clips.map(clipListItem)
  })
}

export const POST: RequestHandler = async ({ request, url }) => {
  const body = (await request.json().catch(() => ({}))) as {
    artifactId?: unknown
    clipId?: unknown
    prefer?: unknown
  }
  const artifactId = trimString(body.artifactId) || trimString(url.searchParams.get('artifactId'))
  const clipId = trimString(body.clipId)
  if (!clipId) {
    throw error(400, 'Clip ID is required')
  }

  const { claims } = await getRuntimeClaims(request, artifactId)
  const clip = await loadImageClip(claims.userId, clipId)
  const settings = await loadUserSettings(claims.userId)
  const prefer = trimString(body.prefer) || 'auto'

  if (prefer !== 'data') {
    const sourceUrl = await resolveTunnelSourceUrl(clip, settings)
    if (sourceUrl) {
      return json({
        success: true,
        source: {
          type: 'url',
          clipId: clip.id,
          filename: clip.filename,
          mimeType: clip.mimeType || null,
          url: sourceUrl,
          previewUrl: pickPreviewUrl(clip)
        }
      })
    }
  }

  const dataUrl = await resolveDataSource(clip)
  if (!dataUrl) {
    throw error(
      400,
      'Clip source image is not reachable; enable a clip tunnel or choose an image with stored upload data'
    )
  }

  return json({
    success: true,
    source: {
      type: 'data',
      clipId: clip.id,
      filename: clip.filename,
      mimeType: clip.mimeType || null,
      data: dataUrl,
      previewUrl: pickPreviewUrl(clip)
    }
  })
}
