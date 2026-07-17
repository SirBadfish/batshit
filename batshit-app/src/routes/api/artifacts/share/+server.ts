import { json, error, type RequestHandler } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'
import { redis } from '$lib/server/redis'
import { v4 as uuidv4 } from 'uuid'
import { publishSessionEvent } from '$lib/server/ssePublisher'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import { internalServiceHeaders } from '$lib/server/services/internalRequestAuth'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl,
  normalizeUploadUrlForStorage,
  normalizeUploadUrlsForStorageInPayload,
  resolveUploadUrlForBrowser
} from '$lib/server/services/batshitServerUrls'
import {
  isOpaqueArtifactRuntimeRequest,
  requireArtifactRuntimeClaims,
  resolveArtifactRuntimeClaims
} from '$lib/server/services/artifactRuntimeAuth'
import { bytesToBlob } from '$lib/utils/binary'
import { estimateTokens } from '$lib/utils/tokens'

const RATE_LIMIT_WINDOW_SECONDS = 60
const RATE_LIMIT_MAX_REQUESTS = 20
const DATA_IMAGE_URL_REGEX = /data:(image\/[a-z0-9.+-]+);base64,[a-z0-9+/=\r\n]+/gi
const MAX_SHARE_TEXT_CHARS = 16000
const ARTIFACT_SHARE_ROUTING_HISTORY_LIMIT = 80

type ShareFormat = 'text' | 'json' | 'markdown' | 'image'
type ShareType = 'screenshot' | 'data' | 'selection' | 'export' | 'status'
type ShareInitiator = 'user' | 'agent'

interface UploadSettings {
  strategy: 'local'
  storage_mode: 'local'
  tunnel_url: string
  use_https: boolean
  tunnel_provider: 'none' | 'manual' | 'cloudflared_managed'
  cloudflared_auto_start: boolean
  cloudflared_target_url: string
}

interface CompressionSettings {
  compress_images: boolean
  compression_quality: number
  max_image_size: string
  force_jpeg: boolean
}

interface ShareRequestBody {
  userId?: string
  artifactId: string
  artifactName?: string
  type?: ShareType
  content: unknown
  format?: ShareFormat
  timestamp?: string
  sessionId?: string
  includeInChat?: boolean
  initiator?: ShareInitiator
}

async function enforceRateLimit(userId: string, artifactId: string) {
  const key = `ratelimit:artifact-share:${userId}:${artifactId}`
  const count = await redis.incr(key)

  if (count === 1) {
    await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS)
  }

  if (count > RATE_LIMIT_MAX_REQUESTS) {
    const ttl = await redis.ttl(key)
    const err = new Error('Share rate limit exceeded')
    ;(err as any).retryAfter = ttl > 0 ? ttl : RATE_LIMIT_WINDOW_SECONDS
    ;(err as any).limit = RATE_LIMIT_MAX_REQUESTS
    throw error(429, err)
  }
}

async function ensureSessionOwnership(sessionId: string, userId: string) {
  const session = await redis.json.get(`session:${sessionId}`)
  if (!session) {
    throw error(404, 'Session not found')
  }

  if ((session as any).user_id !== userId) {
    throw error(403, 'Access denied for session')
  }

  return session as Record<string, any>
}

function normalizeRecord(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, any>) }
  }
  return {}
}

function redactImageDataUrls(input: string): string {
  if (!input || !input.toLowerCase().includes('data:image/')) {
    return input
  }

  return input.replace(
    DATA_IMAGE_URL_REGEX,
    (_fullMatch, mediaType: string) => `[redacted ${mediaType} data URL]`
  )
}

function formatTextContent(content: unknown, format?: ShareFormat): string {
  if (format === 'json' && typeof content === 'object') {
    return redactImageDataUrls(JSON.stringify(content, null, 2))
  }

  if (format === 'markdown') {
    if (content && typeof content === 'object' && !Array.isArray(content)) {
      const record = content as Record<string, unknown>
      const markdownLike =
        (typeof record.data === 'string' && record.data) ||
        (typeof record.content === 'string' && record.content) ||
        (typeof record.text === 'string' && record.text)
      if (markdownLike) {
        return redactImageDataUrls(markdownLike)
      }
    }
    return redactImageDataUrls(String(content ?? ''))
  }

  if (typeof content === 'string') {
    return redactImageDataUrls(content)
  }

  return redactImageDataUrls(JSON.stringify(content))
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://')
}

function sanitizeFileName(value: string): string {
  const safe = value.replace(/[^a-z0-9._-]+/gi, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  return safe || 'artifact-share'
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes('png')) return 'png'
  if (normalized.includes('webp')) return 'webp'
  if (normalized.includes('gif')) return 'gif'
  if (normalized.includes('bmp')) return 'bmp'
  if (normalized.includes('svg')) return 'svg'
  return 'jpg'
}

function parseImageDataUrl(input: string): { mimeType: string; bytes: Buffer } {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(input.trim())
  if (!match) {
    throw error(400, 'Invalid image data URL payload')
  }
  const mimeType = match[1].toLowerCase()
  const base64Data = match[2]
  const bytes = Buffer.from(base64Data, 'base64')
  return { mimeType, bytes }
}

function resolveImageSource(content: unknown): string | null {
  const candidates: string[] = []
  if (typeof content === 'string') {
    candidates.push(content.trim())
  } else if (content && typeof content === 'object' && !Array.isArray(content)) {
    const record = content as Record<string, unknown>
    for (const key of ['image', 'url', 'data']) {
      if (typeof record[key] === 'string') {
        candidates.push(record[key].trim())
      }
    }
  }

  const imageCandidate = candidates.find(
    (candidate) =>
      candidate.toLowerCase().startsWith('data:image/') || isHttpUrl(candidate)
  )
  return imageCandidate || null
}

function resolveUploadSettings(userSettings: unknown): UploadSettings {
  const settings = normalizeRecord(userSettings)
  const uiSettings = normalizeRecord(settings.ui_settings)
  const nestedUpload = normalizeRecord(uiSettings.upload_settings)
  const legacyUpload = normalizeRecord(settings.upload_settings)
  const uploadSettings = Object.keys(nestedUpload).length > 0 ? nestedUpload : legacyUpload
  const tunnelUrl = typeof uploadSettings.tunnel_url === 'string' ? uploadSettings.tunnel_url.trim() : ''
  const tunnelProvider =
    uploadSettings.tunnel_provider === 'cloudflared_managed'
      ? 'cloudflared_managed'
      : uploadSettings.tunnel_provider === 'manual'
        ? 'manual'
        : uploadSettings.tunnel_provider === 'none'
          ? 'none'
          : tunnelUrl
            ? 'manual'
            : 'none'

  return {
    strategy: 'local',
    storage_mode: 'local',
    tunnel_url: tunnelUrl,
    use_https: uploadSettings.use_https === true,
    tunnel_provider: tunnelProvider,
    cloudflared_auto_start: uploadSettings.cloudflared_auto_start === true,
    cloudflared_target_url:
      typeof uploadSettings.cloudflared_target_url === 'string'
        ? uploadSettings.cloudflared_target_url.trim()
        : ''
  }
}

function resolveCompressionSettings(userSettings: unknown): CompressionSettings {
  const settings = normalizeRecord(userSettings)
  const uiSettings = normalizeRecord(settings.ui_settings)
  return {
    compress_images: uiSettings.compress_images !== false,
    compression_quality:
      typeof uiSettings.compression_quality === 'number' ? uiSettings.compression_quality : 40,
    max_image_size:
      typeof uiSettings.max_image_size === 'string' ? uiSettings.max_image_size : '1024',
    force_jpeg: uiSettings.force_jpeg !== false
  }
}

async function uploadImageViaStrategy(options: {
  imageDataUrl: string
  userId: string
  sessionId?: string
  artifactName: string
  uploadSettings: UploadSettings
  compressionSettings: CompressionSettings
  sourceFullResolutionUrl?: string | null
}) {
  const { mimeType, bytes } = parseImageDataUrl(options.imageDataUrl)
  const extension = extensionForMimeType(mimeType)
  const fileName = `${sanitizeFileName(options.artifactName)}-share-${Date.now()}.${extension}`
  const fullResolutionUrl =
    options.sourceFullResolutionUrl ||
    (options.compressionSettings.compress_images !== false
      ? await storeFullResolutionImageUpload({
          bytes,
          mimeType,
          fileName,
          userId: options.userId,
          uploadSettings: options.uploadSettings
        })
      : null)

  const formData = new FormData()
  formData.append('file', bytesToBlob(bytes, { type: mimeType }), fileName)
  formData.append('userId', options.userId)
  if (options.sessionId) {
    formData.append('sessionId', options.sessionId)
  }
  formData.append('compressionSettings', JSON.stringify(options.compressionSettings))
  formData.append(
    'uploadSettings',
    JSON.stringify({
      strategy: options.uploadSettings.strategy,
      storage_mode: options.uploadSettings.storage_mode,
      tunnel_url: options.uploadSettings.tunnel_url,
      use_https: options.uploadSettings.use_https,
      tunnel_provider: options.uploadSettings.tunnel_provider,
      cloudflared_auto_start: options.uploadSettings.cloudflared_auto_start,
      cloudflared_target_url: options.uploadSettings.cloudflared_target_url
    })
  )

  const uploadResponse = await fetch(`${getInternalBatshitServerUrl()}/api/upload/single`, {
    method: 'POST',
    headers: getInternalBatshitServerAuthHeaders(),
    body: formData
  })

  const uploadPayload = await uploadResponse.json().catch(() => null)
  if (!uploadResponse.ok) {
    throw error(
      502,
      `Failed to upload artifact image share (${uploadResponse.status}): ${uploadPayload?.error || uploadPayload?.details || 'unknown'}`
    )
  }

  const uploadedFile = uploadPayload?.file
  if (!uploadedFile?.clipId) {
    throw error(502, 'Upload succeeded but clip metadata was not returned')
  }

  const resolvedFullResolutionUrl =
    fullResolutionUrl ||
    (typeof uploadedFile.displayUrl === 'string' && uploadedFile.displayUrl) ||
    (typeof uploadedFile.localUrl === 'string' && uploadedFile.localUrl) ||
    (typeof uploadedFile.url === 'string' && uploadedFile.url) ||
    null

  await annotateClipFullResolutionUrl({
    userId: options.userId,
    clipId: String(uploadedFile.clipId),
    fullResolutionUrl: resolvedFullResolutionUrl
  })

  return {
    clipId: String(uploadedFile.clipId),
    filename: typeof uploadedFile.originalName === 'string' ? uploadedFile.originalName : fileName,
    fullResolutionUrl: resolvedFullResolutionUrl
      ? resolveUploadUrlForBrowser(resolvedFullResolutionUrl)
      : null
  }
}

async function storeFullResolutionImageUpload(options: {
  bytes: Buffer
  mimeType: string
  fileName: string
  userId: string
  uploadSettings: UploadSettings
}) {
  const formData = new FormData()
  formData.append('file', bytesToBlob(options.bytes, { type: options.mimeType }), options.fileName)
  formData.append('userId', options.userId)
  formData.append(
    'compressionSettings',
    JSON.stringify({
      compress_images: false,
      max_image_size: 'none',
      force_jpeg: false
    })
  )
  formData.append(
    'uploadSettings',
    JSON.stringify({
      strategy: options.uploadSettings.strategy,
      storage_mode: options.uploadSettings.storage_mode,
      tunnel_url: options.uploadSettings.tunnel_url,
      use_https: options.uploadSettings.use_https,
      tunnel_provider: options.uploadSettings.tunnel_provider,
      cloudflared_auto_start: options.uploadSettings.cloudflared_auto_start,
      cloudflared_target_url: options.uploadSettings.cloudflared_target_url,
      skip_clip_persistence: true,
      artifact_source: 'artifact_share_original'
    })
  )

  const uploadResponse = await fetch(`${getInternalBatshitServerUrl()}/api/upload/single`, {
    method: 'POST',
    headers: getInternalBatshitServerAuthHeaders(),
    body: formData
  })

  const uploadPayload = await uploadResponse.json().catch(() => null)
  if (!uploadResponse.ok) {
    throw error(
      502,
      `Failed to preserve full-resolution artifact image (${uploadResponse.status}): ${uploadPayload?.error || uploadPayload?.details || 'unknown'}`
    )
  }

  const file = uploadPayload?.file
  const url =
    (typeof file?.displayUrl === 'string' && file.displayUrl) ||
    (typeof file?.localUrl === 'string' && file.localUrl) ||
    (typeof file?.url === 'string' && file.url) ||
    (typeof file?.externalUrl === 'string' && file.externalUrl) ||
    null

  if (!url) {
    throw error(502, 'Full-resolution artifact image upload did not return a URL')
  }

  return url
}

async function annotateClipFullResolutionUrl(options: {
  userId: string
  clipId: string
  fullResolutionUrl?: string | null
}) {
  if (!options.fullResolutionUrl) return

  const clipKey = `clip:${options.userId}:${options.clipId}`
  const clip = await redis.get(clipKey)
  if (!clip || typeof clip !== 'object' || Array.isArray(clip)) return

  await redis.set(
    clipKey,
    normalizeUploadUrlsForStorageInPayload({
      ...(clip as Record<string, any>),
      fullResolutionUrl: normalizeUploadUrlForStorage(options.fullResolutionUrl),
      updated_at: new Date().toISOString()
    }) as any
  )
}

async function uploadImageUrlViaStrategy(options: {
  userId: string
  imageUrl: string
  sessionId?: string
  artifactName: string
  uploadSettings: UploadSettings
  compressionSettings: CompressionSettings
}) {
  const response = await fetch(options.imageUrl)
  if (!response.ok) {
    throw error(502, `Failed to fetch image URL: ${response.status} ${response.statusText}`)
  }

  const contentType = response.headers.get('content-type') || 'image/png'
  if (!contentType.toLowerCase().startsWith('image/')) {
    throw error(400, 'Shared URL did not return an image')
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  const imageDataUrl = `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`

  return uploadImageViaStrategy({
    imageDataUrl,
    userId: options.userId,
    sessionId: options.sessionId,
    artifactName: options.artifactName,
    uploadSettings: options.uploadSettings,
    compressionSettings: options.compressionSettings,
    sourceFullResolutionUrl: options.imageUrl
  })
}

async function createTextClip(options: {
  userId: string
  artifactName: string
  content: string
  format?: ShareFormat
}) {
  const clipId = `clip_${uuidv4()}`
  const fileExtension =
    options.format === 'json' ? 'json' : options.format === 'markdown' ? 'md' : 'txt'
  const filename = `${sanitizeFileName(options.artifactName)}-share-${Date.now()}.${fileExtension}`
  const mimeType =
    options.format === 'json'
      ? 'application/json'
      : options.format === 'markdown'
        ? 'text/markdown'
        : 'text/plain'

  const tokenEstimate = estimateTokens(options.content)
  const clipRecord = {
    id: clipId,
    user_id: options.userId,
    filename,
    fileType: 'text',
    mimeType,
    externalUrl: null,
    displayUrl: null,
    localUrl: null,
    externalTokens: null,
    localTokens: tokenEstimate,
    storageMode: 'local',
    localBase64: null,
    content: options.content,
    fileSize: options.content.length,
    uploadSettings: {
      destination: 'artifact_share',
      source: 'artifact_share'
    },
    thumbnailUrl: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }

  await redis.set(`clip:${options.userId}:${clipId}`, clipRecord as any)
  await redis.sAdd(`user:${options.userId}:clips`, clipId)

  return { clipId, filename }
}

function getShareAction(shareType: string): string {
  const actions: Record<string, string> = {
    screenshot: 'shared a screenshot',
    data: 'shared data',
    selection: 'shared a selection',
    export: 'exported data',
    status: 'reported status'
  }
  return actions[shareType] || 'shared content'
}

function formatClipReference(clipId: string, filename: string): string {
  if (!filename) return `{{batshit-clip:${clipId}}}`
  return `{{batshit-clip:${clipId}:::${filename}}}`
}

function getTextPreview(content: string): string {
  if (!content) return ''
  if (content.length <= 200) return content
  return `${content.slice(0, 200)}...`
}

function normalizeAgentId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function resolveSessionAgentId(
  sessionRecord: Record<string, any> | null,
  messages: Array<Record<string, any>>
): string | null {
  const fromSession = normalizeAgentId(sessionRecord?.agent_id)
  if (fromSession) return fromSession

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const fromMessage = normalizeAgentId(messages[index]?.agent_id)
    if (fromMessage) {
      return fromMessage
    }
  }

  return null
}

function buildAutoFollowupMessage(initiator: ShareInitiator, artifactName: string): string {
  if (initiator === 'agent') {
    return `This mirrors what you just shared from artifact "${artifactName}" so you can follow up for the user now.`
  }

  return `The user shared output from artifact "${artifactName}". Please review the latest shared content and respond with the next helpful follow-up.`
}

async function loadSessionMessagesForRouting(
  sessionId: string,
  limit = 300
): Promise<Array<Record<string, any>>> {
  const loaded = await redis.getMessages(sessionId, limit)
  return Array.isArray(loaded) ? loaded as Array<Record<string, any>> : []
}

function formatShareMessage(options: {
  artifactName: string
  shareType: string
  clipId: string
  filename: string
  preview?: string
}) {
  const action = getShareAction(options.shareType)
  const clipReference = formatClipReference(options.clipId, options.filename)

  if (!options.preview) {
    return `**${options.artifactName}** ${action}\n\n${clipReference}`
  }

  return `**${options.artifactName}** ${action}:\n\n${clipReference}\n\n${options.preview}`
}

async function attachClipToSessionState(options: {
  sessionId: string
  clipId: string
  messageId: string
}) {
  const stateKey = `session:${options.sessionId}:clip_state`
  const existingData = await redis.get(stateKey)
  const state =
    existingData && typeof existingData === 'object'
      ? (existingData as any)
      : { sessionId: options.sessionId, clips: [] as Array<Record<string, any>> }

  if (!Array.isArray(state.clips)) {
    state.clips = []
  }

  const alreadyAttached = state.clips.some((entry: any) => entry?.clipId === options.clipId)
  if (!alreadyAttached) {
    state.clips.push({
      clipId: options.clipId,
      attachedAt: new Date().toISOString(),
      attachedToMessageId: options.messageId,
      firstAppearanceMessageId: options.messageId
    })
  }

  await redis.set(stateKey, state as any)
  await redis.sAdd(`session:${options.sessionId}:active_clips`, options.clipId)
  await redis.sAdd(`session:${options.sessionId}:clips`, options.clipId)
}

export const POST: RequestHandler = async ({ request, locals, fetch: eventFetch }) => {
  const data = (await request.json()) as ShareRequestBody
  const {
    artifactId,
    artifactName,
    type = 'data',
    content,
    format = 'text',
    timestamp,
    sessionId: rawSessionId,
    includeInChat = true,
    initiator = 'user'
  } = data
  if (!artifactId || content === undefined || content === null) {
    throw error(400, 'Artifact ID and content are required')
  }

  const runtimeClaims = isOpaqueArtifactRuntimeRequest(request)
    ? await requireArtifactRuntimeClaims(request, artifactId)
    : await resolveArtifactRuntimeClaims(request, artifactId)
  const auth = runtimeClaims
    ? { userId: runtimeClaims.userId, auth: 'runtime' as const }
    : await resolveNativeToolUser({
        request,
        localsUserId: locals.user?.id ?? null,
        claimedUserId: typeof data.userId === 'string' ? data.userId : null
      })
  if (!auth) {
    return apiError('Unauthorized', 401)
  }
  const forwardedServiceToken =
    request.headers.get('x-batshit-service-token')?.trim() ||
    request.headers.get('x-batshit-token')?.trim() ||
    null

  await enforceRateLimit(auth.userId, artifactId)

  const artifact = await redis.json.get(`artifact:${artifactId}`)
  if (!artifact) {
    throw error(404, 'Artifact not found')
  }

  const userId = auth.userId
  const ownsArtifact = (artifact as any).user_id === userId
  const published = (artifact as any).mode === 'published'
  if (!ownsArtifact && !published) {
    throw error(403, 'Access denied')
  }

  const sessionId =
    typeof rawSessionId === 'string' && rawSessionId.trim().length > 0
      ? rawSessionId.trim()
      : null

  if (includeInChat && !sessionId) {
    throw error(400, 'Session ID is required to share to chat')
  }
  const sessionRecord = sessionId ? await ensureSessionOwnership(sessionId, userId) : null

  const resolvedArtifactName = artifactName || (artifact as any).name || 'Artifact'
  const userSettings = await redis.getUserSettings(userId)
  const uploadSettings = resolveUploadSettings(userSettings)
  const compressionSettings = resolveCompressionSettings(userSettings)
  const imageSource = resolveImageSource(content)
  const shouldTreatAsImage =
    Boolean(imageSource) || format === 'image' || type === 'screenshot'

  let clipId = ''
  let clipFilename = ''
  let previewText = ''
  let followupTriggered: boolean | undefined
  let followupStatus: string | undefined
  let followupError: string | undefined

  if (shouldTreatAsImage && imageSource) {
    if (imageSource.toLowerCase().startsWith('data:image/')) {
      const uploaded = await uploadImageViaStrategy({
        imageDataUrl: imageSource,
        userId,
        sessionId: sessionId ?? undefined,
        artifactName: resolvedArtifactName,
        uploadSettings,
        compressionSettings
      })
      clipId = uploaded.clipId
      clipFilename = uploaded.filename
    } else if (isHttpUrl(imageSource)) {
      const created = await uploadImageUrlViaStrategy({
        userId,
        sessionId: sessionId ?? undefined,
        imageUrl: imageSource,
        artifactName: resolvedArtifactName,
        uploadSettings,
        compressionSettings
      })
      clipId = created.clipId
      clipFilename = created.filename
    } else {
      throw error(400, 'Unsupported image share payload')
    }
    previewText = ''
  } else {
    const formattedContent = formatTextContent(content, format)
    if (formattedContent.length > MAX_SHARE_TEXT_CHARS) {
      throw error(413, 'Shared content too large')
    }
    const created = await createTextClip({
      userId,
      artifactName: resolvedArtifactName,
      content: formattedContent,
      format
    })
    clipId = created.clipId
    clipFilename = created.filename
    previewText = getTextPreview(formattedContent)
  }

  let messageId: string | null = null

  if (includeInChat && sessionId) {
    const sessionAgentId = normalizeAgentId(sessionRecord?.agent_id)
    messageId = `msg_${uuidv4()}`
    const message = {
      id: messageId,
      session_id: sessionId,
      user_id: userId,
      agent_id: sessionAgentId ?? undefined,
      role: 'user',
      content: formatShareMessage({
        artifactName: resolvedArtifactName,
        shareType: type,
        clipId,
        filename: clipFilename,
        preview: previewText
      }),
      created_at: new Date().toISOString(),
      metadata: {
        source: 'artifact_share',
        artifactId,
        artifactName: resolvedArtifactName,
        shareType: type,
        shareInitiator: initiator,
        clipId
      }
    }

    await redis.saveMessage(message as any)
    await attachClipToSessionState({
      sessionId,
      clipId,
      messageId
    })

    await publishSessionEvent(sessionId, {
      type: 'user_message',
      message
    })

    await publishSessionEvent(sessionId, {
      type: 'clip_state_changed',
      clipId,
      source: 'artifact-share'
    })

    if (initiator === 'agent') {
      followupTriggered = false
      followupStatus = 'skipped_agent_initiated'
    } else {
      const sessionMessages = await loadSessionMessagesForRouting(sessionId, ARTIFACT_SHARE_ROUTING_HISTORY_LIMIT)
      const routedMessages = sessionMessages.filter((entry) => entry?.id !== message.id)
      routedMessages.push(message as any)

      const routedAgentId = resolveSessionAgentId(sessionRecord, routedMessages as any[])
      if (!routedAgentId) {
        followupTriggered = false
        followupStatus = 'skipped_no_agent'
        followupError = 'No session agent found for auto-followup.'
        console.warn('[artifact-share] No session agent found, skipping auto-followup trigger', {
          sessionId,
          messageId,
          artifactId
        })
      } else {
        const autoContent = buildAutoFollowupMessage(initiator, resolvedArtifactName)
        const autoFollowupContent = `${autoContent}\n\nHere is the shared artifact output:\n${message.content}`
        const sendRoutedUrl = new URL('/api/messages/send-routed', request.url).toString()

        try {
          const followupHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            // Internal server-to-server forward: skip public API rate limiter.
            'x-internal-api-request': '1',
            ...internalServiceHeaders()
          }
          if (auth.auth === 'service' && forwardedServiceToken) {
            followupHeaders['x-batshit-service-token'] = forwardedServiceToken
            followupHeaders['x-batshit-user-id'] = userId
          }

          const followupResponse = await eventFetch(sendRoutedUrl, {
            method: 'POST',
            headers: followupHeaders,
            body: JSON.stringify({
              content: autoFollowupContent,
              sessionId,
              agentId: routedAgentId,
              userId,
              messages: routedMessages,
              metadata: {
                source: 'artifact_share_auto_followup',
                artifactId,
                artifactName: resolvedArtifactName,
                shareInitiator: initiator,
                sharedMessageId: message.id
              }
            })
          })

          if (!followupResponse.ok) {
            const details = await followupResponse.text().catch(() => '')
            followupTriggered = false
            followupStatus = 'failed'
            followupError =
              details ||
              `Auto-followup request failed with status ${followupResponse.status}`
            console.warn('[artifact-share] Auto-followup trigger failed', {
              sessionId,
              agentId: routedAgentId,
              status: followupResponse.status,
              details
            })
          } else {
            followupTriggered = true
            followupStatus = 'triggered'
          }
        } catch (followupException) {
          followupTriggered = false
          followupStatus = 'failed'
          const message =
            followupException instanceof Error ? followupException.message : String(followupException)
          followupError = message
          console.warn('[artifact-share] Auto-followup trigger threw', {
            sessionId,
            agentId: routedAgentId,
            error: message
          })
        }
      }
    }
  }

  return json({
    success: true,
    clipId,
    messageId: includeInChat ? messageId : undefined,
    message: includeInChat ? 'Content shared to chat' : 'Content saved to Clip Vault',
    followupTriggered,
    followupStatus,
    followupError
  })
}
