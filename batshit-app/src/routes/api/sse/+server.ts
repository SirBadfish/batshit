import { error } from '@sveltejs/kit'
import { logger } from '$lib/utils/logger'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { resolveRedisConnectionUrl } from '$lib/server/redisConnection'
import { redisStreamService } from '$lib/server/redisStreamService'
import type { TempZipMetadata } from '$lib/server/redisStreamService'
import { finalizeAllZipBlocks } from '$lib/server/zipService'
import type { ZipReference } from '$lib/server/zipService'
import {
  StreamEventAdapter,
  type CanonicalStreamEvent
} from '$lib/server/services/streamEventAdapter'
import {
  initializeKeyspaceNotifications,
  setupSessionMonitoring,
  type VisualIndicatorEvent
} from '$lib/server/visualIndicatorService'
import { randomUUID } from 'crypto'
import { adaptCoolToolsToZipSystem } from '$lib/server/coolToolZipAdapter'
import { ZipDetectionService } from '$lib/server/services/zipDetection'
import { createClient } from 'redis'
import { env } from '$env/dynamic/private'
import { buildEndStreamingContent } from '$lib/server/services/sseEndContentBuilder'
import { stripLeadingSubagentEchoText } from '$lib/server/services/finalAssistantTextSanitizer'
import {
  canonicalizePrimaryAgentRecord,
  isManagedPrimaryAgentType,
  isN8nPrimaryAgentType,
  normalizePrimaryAgentType,
} from '$lib/utils/primaryAgentType'
import {
  isSubagentCompatibleWithPrimaryAgent,
  normalizeSubagentType,
} from '$lib/utils/subagentType'
import { resolveUploadUrlForBrowser } from '$lib/server/services/batshitServerUrls'
import { requireOwnedSession } from '$lib/server/services/routeSecurity'
import { isTrustedInternalRequest } from '$lib/server/services/internalRequestAuth'
import { isTrustedN8nSseCallbackRequest } from '$lib/server/services/n8nCallbackTokens'
import { normalizeAssignedSubagent } from '$lib/server/services/assignedSubagentNormalization'
import { parseJsonLike, normalizeToolArgs } from '$lib/server/services/sseToolNormalization'
import {
  neutralizeAllClipReferenceSyntax,
  neutralizeUntrustedZipReferenceSyntax
} from '$lib/utils/zipReferenceSafety'
import { registerRuntimeShutdownTask } from '$lib/server/services/runtimeShutdown'

type SSEController = ReadableStreamDefaultController & {
  _id?: string;
  _heartbeat?: ReturnType<typeof setInterval>;
  _visualCleanup?: () => void | Promise<void>;
  _closed?: boolean;
}

type StreamEventPayload = {
  type: string;
  messageId?: string;
  sseEventId?: string;
  [key: string]: any;
}

type ActiveStreamState = {
  events: StreamEventPayload[];
  messageIds: Set<string>;
  nextEventIndex: number;
}

// Active SSE connections (can have multiple listeners per session)
const connections = new Map<string, Set<SSEController>>()
const activeStreams = new Map<string, ActiveStreamState>()
const activeStreamCleanupTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>()
const sessionAdapters = new Map<string, StreamEventAdapter>()
const sessionSubagentCache = new Map<string, any[]>()
const EXTERNAL_CHANNEL_PREFIX = 'batshit:sse:'
let externalSubscriber: ReturnType<typeof createClient> | null = null
let externalSubscriberReady: Promise<void> | null = null
let sseRuntimeShutdownPromise: Promise<void> | null = null

function hasToolMetadataSignature(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasToolMetadataSignature(item))
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const knownKeys = [
      'toolName',
      'toolCallId',
      'tool_call_id',
      'toolResult',
      'tool_input',
      'toolInput',
      'observation',
      'error',
      'executionTime'
    ]

    if (knownKeys.some((key) => key in obj)) {
      return true
    }

    return Object.values(obj).some((nested) => hasToolMetadataSignature(nested))
  }

  return false
}

function sanitizeAssistantContent(raw: string, hasToolArtifacts: boolean): string {
  if (!raw) {
    return raw
  }

  let content = raw

  if (hasToolArtifacts) {
    content = content.replace(/\nAI:\s*[^\n]*/g, '')
    content = content.replace(/\{\{TOOL_LOADING_PLACEHOLDER:[^}]+\}\}/g, '')

    const toolMarkerIndex = content.indexOf('\nTool:')
    if (toolMarkerIndex !== -1) {
      content = content.slice(0, toolMarkerIndex)
    }

    const intermediateIndex = content.toLowerCase().indexOf('\nintermediate steps:')
    if (intermediateIndex !== -1) {
      content = content.slice(0, intermediateIndex)
    }

    const jsonTailMatch = content.match(/(\r?\n)\s*[\[{][\s\S]*$/)
    if (jsonTailMatch) {
      const tail = content.slice(jsonTailMatch.index).trim()
      if (tail) {
        try {
          const parsed = JSON.parse(tail)
          if (hasToolMetadataSignature(parsed)) {
            content = content.slice(0, jsonTailMatch.index).trimEnd()
          }
        } catch {
          // Tail was not valid JSON, leave content unchanged
        }
      }
    }
  }

  content = content.replace(/\n{3,}/g, '\n\n')

  return content.trim()
}

function dedupeZipReferences(refs: ZipReference[]): ZipReference[] {
  if (!refs || refs.length === 0) {
    return []
  }

  const unique: ZipReference[] = []
  const seen = new Set<string>()

  for (const ref of refs) {
    if (!ref?.reference) continue
    if (!seen.has(ref.reference)) {
      const zipId = ref.zipId || extractZipIdFromReference(ref.reference) || undefined
      unique.push(zipId ? { ...ref, zipId } : ref)
      seen.add(ref.reference)
    }
  }

  return unique
}

function extractZipIdFromReference(reference: string): string | null {
  if (!reference) return null
  const match = reference.match(/\{\{batshit-zip:([^:}]+)(?::::[^}]*)?\}\}/)
  return match ? match[1] : null
}

async function ensureExternalSubscriber() {
  if (externalSubscriberReady) return externalSubscriberReady

  externalSubscriberReady = (async () => {
    let subscriber: ReturnType<typeof createClient> | null = null
    try {
      subscriber = createClient({ url: resolveRedisConnectionUrl(env) })
      subscriber.on('error', (err) => {
        console.error('[SSE] External subscriber error', err)
      })

      await subscriber.connect()
      await subscriber.pSubscribe(`${EXTERNAL_CHANNEL_PREFIX}*`, (message, channel) => {
        const sessionId = channel.replace(EXTERNAL_CHANNEL_PREFIX, '')
        if (!sessionId) return

        let payload: any = { type: 'external_event', raw: message }
        try {
          payload = JSON.parse(message)
        } catch {
          // keep fallback payload
        }

        forwardExternalEvent(sessionId, payload)
      })

      externalSubscriber = subscriber
      logger.debug('[SSE] External event subscriber ready')
    } catch (err) {
      console.error('[SSE] Failed to start external subscriber', err)
      if (subscriber?.isOpen) {
        await subscriber.disconnect().catch((disconnectError) => {
          console.error('[SSE] Failed to close partial external subscriber', disconnectError)
        })
      }
      externalSubscriberReady = null
    }
  })()

  return externalSubscriberReady
}

export function _closeSseRuntimeResources(reason = 'shutdown'): Promise<void> {
  sseRuntimeShutdownPromise ??= (async () => {
    const visualCleanups: Promise<void>[] = []
    for (const [sessionId, sessionControllers] of connections) {
      for (const controller of sessionControllers) {
        controller._closed = true
        if (controller._heartbeat) {
          clearInterval(controller._heartbeat)
          controller._heartbeat = undefined
        }
        if (controller._visualCleanup) {
          visualCleanups.push(Promise.resolve(controller._visualCleanup()))
          controller._visualCleanup = undefined
        }
        try {
          controller.close()
        } catch {
          // The client may already have closed the stream.
        }
      }
      zipDetection.deleteSessionBuffers(sessionId)
    }
    connections.clear()

    for (const timers of activeStreamCleanupTimers.values()) {
      for (const timer of timers.values()) clearTimeout(timer)
    }
    activeStreamCleanupTimers.clear()
    activeStreams.clear()
    sessionAdapters.clear()
    sessionSubagentCache.clear()
    sessionZipSettings.clear()
    agentSettingsCache.clear()

    const ready = externalSubscriberReady
    if (ready) await ready.catch(() => undefined)
    const subscriber = externalSubscriber
    externalSubscriber = null
    externalSubscriberReady = null
    if (subscriber?.isOpen) {
      try {
        await subscriber.disconnect()
      } catch (error) {
        console.error('[SSE] External subscriber disconnect failed; forcing socket destruction', error)
        subscriber.destroy()
        if (subscriber.isOpen) throw error
      }
    }
    await Promise.all(visualCleanups)
    logger.debug(`[SSE] Runtime resources closed for ${reason}`)
  })()
  return sseRuntimeShutdownPromise
}

registerRuntimeShutdownTask('sse', _closeSseRuntimeResources)

function forwardExternalEvent(sessionId: string, payload: any) {
  const listeners = connections.get(sessionId)
  if (!listeners || listeners.size === 0) return

  for (const controller of listeners) {
    enqueueWithTelemetry(sessionId, controller, payload)
  }
}

function resolveAssignedSubagentIds(agent: any): string[] {
  if (Array.isArray(agent?.assignedSubagents) && agent.assignedSubagents.length > 0) {
    return agent.assignedSubagents as string[]
  }
  if (
    Array.isArray(agent?.assigned_subagent_ids) &&
    agent.assigned_subagent_ids.length > 0
  ) {
    return agent.assigned_subagent_ids as string[]
  }
  return []
}

async function loadAssignedSubagents(sessionId: string): Promise<any[]> {
  if (sessionSubagentCache.has(sessionId)) {
    return sessionSubagentCache.get(sessionId) ?? []
  }

  const agentSettings = await loadAgentSettings(sessionId)
  const subagentIds = resolveAssignedSubagentIds(agentSettings)
  const primaryAgentType = normalizePrimaryAgentType(agentSettings)

  if (!subagentIds.length) {
    sessionSubagentCache.set(sessionId, [])
    return []
  }

  const subagents: any[] = []
  try {
    await redis.execute(async (client) => {
      for (const id of subagentIds) {
        try {
          const raw = await client.json.get(`subagent:${id}`)
          if (raw) {
            subagents.push(normalizeAssignedSubagent(raw as Record<string, any>))
          }
        } catch (error) {
          console.error('[SSE] Failed to load subagent', id, error)
        }
      }
    })
  } catch (error) {
    console.error('[SSE] Error loading subagents for session:', sessionId, error)
  }

  const compatibleSubagents = subagents.filter((subagent) =>
    isSubagentCompatibleWithPrimaryAgent(primaryAgentType, subagent)
  )

  sessionSubagentCache.set(sessionId, compatibleSubagents)
  return compatibleSubagents
}

function sanitizeName(value: string | undefined): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]/g, '')
    : ''
}

interface ToolMetadata {
  [key: string]: any
}

async function enrichToolMetadata(
  sessionId: string,
  toolName: string | undefined,
  metadata: ToolMetadata | undefined,
  args: Record<string, any> | undefined
): Promise<ToolMetadata | undefined> {
  const baseMetadata: ToolMetadata = metadata ? { ...metadata } : {}
  const hadMetadata = metadata && Object.keys(metadata).length > 0
  const hasExplicitSubagentIdentity =
    typeof baseMetadata.subagentId === 'string' ||
    typeof baseMetadata.subagentName === 'string'
  const subagents = await loadAssignedSubagents(sessionId)

  if (!subagents.length) {
    return baseMetadata
  }

  const candidateIds = new Set<string>()
  const candidateNames = new Set<string>()

  const collectId = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      candidateIds.add(value.trim())
    }
  }

  const collectName = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      candidateNames.add(value.trim())
    }
  }

  collectName(toolName)
  collectName(baseMetadata.subagentName)
  collectId(baseMetadata.subagentId)

  if (args && typeof args === 'object') {
    collectName(args.subagentName || args.subagent_name)
    collectId(args.subagentId || args.subagent_id)

    if (args.subagent && typeof args.subagent === 'object') {
      const subagent = args.subagent as Record<string, any>
      collectId(subagent.id)
      collectName(subagent.displayName || subagent.display_name || subagent.name)
    }
  }

  let matched = subagents.find((subagent) => candidateIds.has(subagent.id))

  if (!matched && candidateNames.size > 0) {
    const sanitizedCandidates = Array.from(candidateNames).map(sanitizeName).filter(Boolean)
    matched = subagents.find((subagent) => {
      const namesToCompare = [
        subagent.displayName,
        subagent.name,
        subagent.slug,
        subagent.id
      ].filter(Boolean)
      return namesToCompare
        .map((value: string) => sanitizeName(value))
        .some((value) => sanitizedCandidates.includes(value))
    })
  }

  if (!matched && !hasExplicitSubagentIdentity && toolName === 'call_subagent' && subagents.length === 1) {
    matched = subagents[0]
  }

  if (!matched && !hasExplicitSubagentIdentity && subagents.length === 1) {
    matched = subagents[0]
  }

  if (!matched) {
    const toolNameNormalized = typeof toolName === 'string' ? sanitizeName(toolName) : ''
    if (toolNameNormalized) {
      matched = subagents.find((subagent) => {
        const candidates = [
          subagent.displayName,
          subagent.name,
          subagent.slug,
          subagent.id
        ]
          .filter(Boolean)
          .map((value: string) => sanitizeName(value))

        return candidates.includes(toolNameNormalized)
      })
    }
  }

  if (!matched) {
    return hadMetadata ? baseMetadata : undefined
  }

  const avatar =
    matched.avatar ||
    matched.avatar_url ||
    baseMetadata.subagentAvatar ||
    baseMetadata.avatarUrl

  return {
    ...baseMetadata,
    toolProvider: baseMetadata.toolProvider || 'subagent',
    toolSource: baseMetadata.toolSource || 'workflow',
    isSubagent: true,
    subagentId: matched.id,
    subagentName: matched.displayName || matched.name,
    subagentType: normalizeSubagentType(matched, matched.subagentType),
    subagentAvatar: typeof avatar === 'string' ? resolveUploadUrlForBrowser(avatar) : avatar,
    subagentAvatarIconRef:
      matched.avatar_icon_ref ||
      matched.avatarIconRef ||
      baseMetadata.subagentAvatarIconRef ||
      baseMetadata.subagent_avatar_icon_ref ||
      baseMetadata.avatarIconRef,
    subagentAvatarIconFit:
      matched.avatar_icon_fit ||
      matched.avatarIconFit ||
      baseMetadata.subagentAvatarIconFit ||
      baseMetadata.subagent_avatar_icon_fit ||
      baseMetadata.avatarIconFit
  }
}

// Temporary buffer for accumulating partial zips
const zipDetection = new ZipDetectionService()
const agentSettingsCache = new Map<string, any>()
const sessionZipSettings = new Map<string, Record<string, any> | undefined>()

function getStreamAdapter(sessionId: string) {
  let adapter = sessionAdapters.get(sessionId)
  if (!adapter) {
    adapter = new StreamEventAdapter({ sessionId })
    sessionAdapters.set(sessionId, adapter)
  }
  return adapter
}

function resetStreamAdapter(sessionId: string) {
  sessionAdapters.delete(sessionId)
}

async function loadAgentSettings(sessionId: string) {
  if (agentSettingsCache.has(sessionId)) {
    return agentSettingsCache.get(sessionId)
  }

  let agentSettings: any = {}
  let resolvedAgentId: string | undefined
  try {
    const session = await redis.execute(async (client) => {
      return await client.json.get(`session:${sessionId}`)
    }) as any

    resolvedAgentId = session?.agent_id

    if (!resolvedAgentId) {
      // Sessions are not strictly agent-bound (agents can switch mid-session).
      // Resolve the current agent from the most recent persisted message.
      const lastMessageIds = await redis.execute((client) =>
        client.lRange(`messages:${sessionId}`, -1, -1)
      )
      const lastMessageId = Array.isArray(lastMessageIds) ? lastMessageIds[0] : undefined

      if (lastMessageId) {
        const lastMessage = await redis.execute((client) =>
          client.json.get(`message:${sessionId}:${lastMessageId}`)
        ) as any
        resolvedAgentId = lastMessage?.agent_id
      }
    }

    if (resolvedAgentId) {
      const agent = await redis.execute(async (client) => {
        return await client.json.get(`agent:${resolvedAgentId}`)
      })

      if (agent) {
        agentSettings = canonicalizePrimaryAgentRecord(agent as Record<string, any>)
      }
    }
  } catch (error) {
    console.error('[SSE] Failed to load agent settings for session:', sessionId, error)
  }

  agentSettingsCache.set(sessionId, agentSettings)
  return agentSettings
}

/**
 * SSE endpoint for canonical chat streaming events.
 * Native n8n sends forward webhook NDJSON here client-side; legacy/custom
 * callback workflows can still POST callback events directly.
 * Simplified version without "Respond to Webhook" complexity
 */
export const GET: RequestHandler = async ({ url, locals }) => {
  const sessionId = url.searchParams.get('sessionId')

  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw error(400, 'Session ID is required')
  }

  // Check authentication via locals (set by hooks.server.ts)
  if (!locals.user) {
    throw error(401, 'Unauthorized')
  }

  const sessionCheck = await requireOwnedSession(sessionId, locals.user.id)
  if (!sessionCheck.ok) return sessionCheck.response

  await ensureExternalSubscriber()

  let globalZipSettings: Record<string, any> | undefined = undefined
  try {
    const userSettings = await redis.getUserSettings(locals.user.id)
    globalZipSettings = userSettings?.global_zip_settings || undefined
  } catch (err) {
    console.error('[SSE] Failed to load user zip settings:', err)
  }

  sessionZipSettings.set(sessionId, globalZipSettings)

  logger.debug('[SSE] New connection for session:', sessionId)

  // Create SSE stream
  let activeController: SSEController | null = null

  const stream = new ReadableStream({
    async start(controller) {
      const controllerRef = controller as SSEController
      if (!controllerRef._id) {
        controllerRef._id = `sse-${randomUUID()}`
      }
      activeController = controllerRef

      // Store connection (support multiple concurrent listeners)
      let sessionControllers = connections.get(sessionId)
      if (!sessionControllers) {
        sessionControllers = new Set<SSEController>()
        connections.set(sessionId, sessionControllers)
      }
      sessionControllers.add(controllerRef)

      const controllerIds = Array.from(sessionControllers).map((entry) => entry._id)
      logger.debug('[SSE] Active listeners for session', {
        sessionId,
        listenerCount: sessionControllers.size,
        controllers: controllerIds
      })

      // Send initial connection message
      try {
        controllerRef.enqueue(`data: ${JSON.stringify({
          type: 'connected',
          sessionId
        })}\n\n`)
      } catch (err) {
        console.error('[SSE] Failed to enqueue connected event', {
          sessionId,
          controllerId: controllerRef._id,
          error: err
        })
      }

      // If an active stream is in progress, replay it for this listener
      replayActiveStreamForListener(sessionId, controllerRef)

      logger.debug('[SSE] Connection registered', {
        sessionId,
        listenerCount: sessionControllers.size,
        controllers: controllerIds
      })

      // Set up Redis keyspace monitoring for zip activity
      try {
        await setupRedisMonitoring(sessionId, controllerRef)
      } catch (err) {
        console.error('[SSE] Error setting up Redis monitoring:', err)
        // Continue anyway - monitoring is optional
      }

      // Shutdown can begin while the async Redis subscription is still being
      // established. If it did, tear down the late resource immediately and
      // do not create a new heartbeat after the runtime cleanup has finished.
      if (controllerRef._closed) {
        const lateVisualCleanup = controllerRef._visualCleanup
        controllerRef._visualCleanup = undefined
        await lateVisualCleanup?.()
        return
      }

      // Keep alive with heartbeat
      const heartbeat = setInterval(() => {
        try {
          controllerRef.enqueue(':heartbeat\n\n')
        } catch (e) {
          // Connection closed
          clearInterval(heartbeat)
        }
      }, 30000)

      // Store heartbeat for cleanup
      controllerRef._heartbeat = heartbeat
  },

  async cancel() {
    // Cleanup on disconnect
    logger.debug('[SSE] Connection closed for session:', sessionId)

    const cancelController = activeController
    activeController = null

    if (cancelController) {
      const sessionControllers = connections.get(sessionId)
      if (sessionControllers && sessionControllers.size > 0) {
        for (const entry of sessionControllers) {
          if (entry === cancelController) {
            entry._closed = true
            if (entry._heartbeat) {
              clearInterval(entry._heartbeat)
            }
            await entry._visualCleanup?.()
            sessionControllers.delete(entry)
            break
          }
        }

        if (sessionControllers.size === 0) {
          connections.delete(sessionId)
          zipDetection.deleteSessionBuffers(sessionId)
          agentSettingsCache.delete(sessionId)
          sessionZipSettings.delete(sessionId)
          sessionSubagentCache.delete(sessionId)
          resetStreamAdapter(sessionId)

          try {
            await redisStreamService.cleanupSessionTempStorage(sessionId)
            logger.debug(`[SSE] Cleaned up Redis temp storage for session ${sessionId}`)
          } catch (error) {
            console.error('[SSE] Error cleaning up Redis temp storage:', error)
          }
        } else {
          logger.debug('[SSE] Connection closed', {
            sessionId,
            listenerCount: sessionControllers.size,
            controllers: Array.from(sessionControllers).map((entry) => entry._id)
          })
        }
      }
    }

  }
})

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': url.origin
    }
  })
}

/**
 * Process a single NDJSON line from native n8n forwarding or legacy callbacks.
 * Enhanced with Stream-to-Zip support
 */
async function processNDJSONLine(
  sessionId: string,
  data: any,
  controller: ReadableStreamDefaultController,
  options: { globalZipSettings?: Record<string, any> } = {}
) {
  // Native n8n forwarding and legacy callbacks send data with a `type` field.
  const eventType = data.type || data.event
  const eventData = data.metadata || data.data || data
  const messageId = data.messageId || eventData.messageId
  const adapter = getStreamAdapter(sessionId)
  if (messageId) {
    adapter.setMessageId(messageId)
  }

  // Handle different event types
  switch (eventType) {
    case 'begin':
    case 'start': {
      // New stream → reset per-session caches so agent/subagent resolution stays correct
      agentSettingsCache.delete(sessionId)
      sessionSubagentCache.delete(sessionId)

      // Clear any previous zip references for this message
      const messageKey = `${sessionId}:${messageId}`
      zipDetection.clearMessageReferences(messageKey)

      const startEvent = await adapter.emitStart({
        messageId,
        metadata: eventData.metadata || data.metadata || {}
      })

      enqueueWithTelemetry(sessionId, controller as SSEController, startEvent)
      initializeActiveStream(sessionId, startEvent)
      logger.debug('[SSE] Recorded start event for session', {
        sessionId,
        messageId
      })
      break
    }

    case 'item':
    case 'chunk': {
      // Process chunks with Stream-to-Zip support
      let content = data.content || eventData.content || ''

      const agentSettingsForChunk = await loadAgentSettings(sessionId)
      zipDetection.setContext(sessionId, messageId, {
        agent: agentSettingsForChunk,
        globalSettings: options.globalZipSettings,
        messagesFromEnd: 0
      })

      // Check for zip patterns and handle streaming to temporary storage
      const processed = await zipDetection.processChunk(sessionId, messageId, content)

      if (processed.shouldStream) {
        const knownStreamingZipIds = zipDetection
          .getMessageReferences(sessionId, messageId)
          .map((ref) => extractZipIdFromReference(ref.reference))
          .filter((id): id is string => Boolean(id))
        const safeProcessedContent = neutralizeAllClipReferenceSyntax(
          neutralizeUntrustedZipReferenceSyntax(
            processed.content,
            {
              trustedZipIds: knownStreamingZipIds,
            }
          )
        )
        const chunkEvent = await adapter.emitChunk({
          content: safeProcessedContent
        })
        enqueueWithTelemetry(sessionId, controller as SSEController, chunkEvent)
        appendActiveStreamEvent(sessionId, {
          ...chunkEvent
        })
      }
      break
    }

    case 'tool_start': {
      const toolCallId =
        data.toolCallId ||
        eventData.toolCallId ||
        eventData.toolId
      const placeholderId =
        data.placeholderId ||
        eventData.placeholderId
      const order =
        typeof data.order === 'number'
          ? data.order
          : typeof eventData.order === 'number'
          ? eventData.order
          : 0
      const toolName = data.toolName || eventData.toolName

      const toolStartEvent = await adapter.emitToolStart({
        toolCallId,
        placeholderId,
        order,
        toolName,
        metadata: data.metadata || eventData.metadata
      })

      enqueueWithTelemetry(sessionId, controller as SSEController, toolStartEvent)
      appendActiveStreamEvent(sessionId, toolStartEvent)
      break
    }

    case 'tool-call': {
      const toolCallId =
        data.toolCallId ||
        eventData.toolCallId
      const placeholderId =
        data.placeholderId ||
        eventData.placeholderId
      const order =
        typeof data.order === 'number'
          ? data.order
          : typeof eventData.order === 'number'
            ? eventData.order
            : 0
      const args =
        data.args ||
        eventData.args ||
        data.input ||
        eventData.input
      const toolName = data.toolName || eventData.toolName
      const normalizedArgs = normalizeToolArgs(args)
      const metadataPayload = data.metadata || eventData.metadata
      const enrichedMetadata = await enrichToolMetadata(
        sessionId,
        toolName,
        metadataPayload,
        normalizedArgs
      )

      const toolCallEvent = await adapter.emitToolCall({
        toolCallId,
        placeholderId,
        order,
        toolName,
        args: normalizedArgs,
        metadata: enrichedMetadata
      })

      enqueueWithTelemetry(sessionId, controller as SSEController, toolCallEvent)
      appendActiveStreamEvent(sessionId, toolCallEvent)
      break
    }

    case 'tool_approval_request':
    case 'tool-approval-request': {
      const approvalId =
        (typeof data.approvalId === 'string' && data.approvalId.trim().length > 0
          ? data.approvalId.trim()
          : typeof data.approval_id === 'string' && data.approval_id.trim().length > 0
            ? data.approval_id.trim()
            : typeof eventData.approvalId === 'string' && eventData.approvalId.trim().length > 0
              ? eventData.approvalId.trim()
              : typeof eventData.approval_id === 'string' && eventData.approval_id.trim().length > 0
                ? eventData.approval_id.trim()
                : '')

      if (!approvalId) {
        logger.warn('[SSE] tool_approval_request missing approvalId, skipping', {
          sessionId,
          messageId
        })
        break
      }

      const explicitToolCall =
        (data.toolCall && typeof data.toolCall === 'object'
          ? data.toolCall
          : data.tool_call && typeof data.tool_call === 'object'
            ? data.tool_call
            : eventData.toolCall && typeof eventData.toolCall === 'object'
              ? eventData.toolCall
              : eventData.tool_call && typeof eventData.tool_call === 'object'
                ? eventData.tool_call
                : undefined) as Record<string, any> | undefined

      const toolCallId =
        data.toolCallId ||
        data.tool_call_id ||
        eventData.toolCallId ||
        eventData.tool_call_id ||
        (typeof explicitToolCall?.toolCallId === 'string' ? explicitToolCall.toolCallId : undefined) ||
        (typeof explicitToolCall?.tool_call_id === 'string' ? explicitToolCall.tool_call_id : undefined)
      const toolName =
        data.toolName ||
        data.tool_name ||
        eventData.toolName ||
        eventData.tool_name ||
        (typeof explicitToolCall?.toolName === 'string' ? explicitToolCall.toolName : undefined) ||
        (typeof explicitToolCall?.tool_name === 'string' ? explicitToolCall.tool_name : undefined)
      const input =
        data.input ??
        data.args ??
        data.parameters ??
        eventData.input ??
        eventData.args ??
        eventData.parameters ??
        explicitToolCall?.input ??
        explicitToolCall?.args ??
        explicitToolCall?.parameters
      const requestedAt =
        typeof data.requestedAt === 'string' && data.requestedAt.trim().length > 0
          ? data.requestedAt.trim()
          : typeof eventData.requestedAt === 'string' && eventData.requestedAt.trim().length > 0
            ? eventData.requestedAt.trim()
            : undefined
      const expiresAt =
        typeof data.expiresAt === 'string' && data.expiresAt.trim().length > 0
          ? data.expiresAt.trim()
          : typeof eventData.expiresAt === 'string' && eventData.expiresAt.trim().length > 0
            ? eventData.expiresAt.trim()
            : undefined

      const approvalEvent = await adapter.emitToolApprovalRequest({
        approvalId,
        toolCallId: typeof toolCallId === 'string' && toolCallId.length > 0 ? toolCallId : undefined,
        toolName,
        input,
        toolCall: explicitToolCall,
        requestedAt,
        expiresAt,
        source:
          (typeof data.source === 'string' && data.source.length > 0
            ? data.source
            : typeof eventData.source === 'string' && eventData.source.length > 0
              ? eventData.source
              : undefined),
        metadata: data.metadata || eventData.metadata
      })

      enqueueWithTelemetry(sessionId, controller as SSEController, approvalEvent)
      appendActiveStreamEvent(sessionId, approvalEvent)
      break
    }

    case 'tool-result': {
      const toolCallId =
        data.toolCallId ||
        eventData.toolCallId ||
        `tool_${Date.now()}`
      const placeholderId =
        data.placeholderId ||
        eventData.placeholderId ||
        `tool_placeholder_${toolCallId}`
      const order =
        typeof data.order === 'number'
          ? data.order
          : typeof eventData.order === 'number'
            ? eventData.order
            : 0
      const toolName = data.toolName || eventData.toolName
      const args =
        data.args ||
        eventData.args ||
        data.input ||
        eventData.input
      const resultPayload =
        data.result ||
        eventData.result ||
        data.output ||
        eventData.output ||
        data.data
      const metadataPayload = data.metadata || eventData.metadata
      const zipReferences = data.zipReferences || eventData.zipReferences
      const normalizedArgs = normalizeToolArgs(args)
      const enrichedMetadata = await enrichToolMetadata(
        sessionId,
        toolName,
        metadataPayload,
        normalizedArgs
      )

      const toolResultEvent = await adapter.emitToolResult({
        toolCallId,
        placeholderId,
        order,
        toolName,
        args: normalizedArgs,
        result: resultPayload,
        metadata: enrichedMetadata,
        zipReferences
      })

      enqueueWithTelemetry(sessionId, controller as SSEController, toolResultEvent)
      appendActiveStreamEvent(sessionId, toolResultEvent)
      break
    }

    case 'thinking': {
      const content = data.content || eventData.content || ''
      const metadata = data.metadata || eventData.metadata
      if (content || metadata?.kind === 'reasoning_indicator') {
        const thinkingEvent = await adapter.emitThinking({
          content,
          metadata
        })
        enqueueWithTelemetry(sessionId, controller as SSEController, thinkingEvent)
        appendActiveStreamEvent(sessionId, thinkingEvent)
      }
      break
    }

    case 'plan_update': {
      const content = data.content || eventData.content || ''
      if (content) {
        const planEvent = await adapter.emitPlanUpdate({
          content,
          items: data.items || eventData.items,
          metadata: data.metadata || eventData.metadata
        })
        enqueueWithTelemetry(sessionId, controller as SSEController, planEvent)
        appendActiveStreamEvent(sessionId, planEvent)
      }
      break
    }

    case 'tool_end': {
      const toolCallId =
        data.toolCallId ||
        eventData.toolCallId
      const placeholderId =
        data.placeholderId ||
        eventData.placeholderId
      const order =
        typeof data.order === 'number'
          ? data.order
          : typeof eventData.order === 'number'
            ? eventData.order
            : 0

      const toolEndEvent = await adapter.emitToolEnd({
        toolCallId,
        placeholderId,
        order,
        metadata: data.metadata || eventData.metadata
      })

      enqueueWithTelemetry(sessionId, controller as SSEController, toolEndEvent)
      appendActiveStreamEvent(sessionId, toolEndEvent)
      break
    }

    case 'object_partial':
    case 'object_final': {
      const objectEvent = {
        type: eventType,
        ...data,
        ...eventData
      }
      enqueueWithTelemetry(sessionId, controller as SSEController, {
        ...objectEvent
      })
      appendActiveStreamEvent(sessionId, objectEvent)
      break
    }

    case 'finish': {
      const usage = data.usage || eventData.usage
      const finishEvent = await adapter.emitFinish({
        usage
      })
      enqueueWithTelemetry(sessionId, controller as SSEController, finishEvent)
      appendActiveStreamEvent(sessionId, finishEvent)
      break
    }

    case 'end': {
      // Finalize any open zip blocks before sending end event
      const zipRefs = await finalizeAllZipBlocks(sessionId, messageId)
      const streamingRefs = await zipDetection.finalizeOpenBlocks(sessionId, messageId)
      const agentSettings = await loadAgentSettings(sessionId)
      zipDetection.setContext(sessionId, messageId, {
        agent: agentSettings,
        globalSettings: options.globalZipSettings,
        messagesFromEnd: 0
      })

      const incomingZipReferences: ZipReference[] = Array.isArray(data.zipReferences)
        ? data.zipReferences
        : Array.isArray(eventData.zipReferences)
          ? eventData.zipReferences
          : []

      const hasIncomingCoolToolZips = incomingZipReferences.some(
        (ref: any) =>
          typeof ref?.reference === 'string' &&
          ref.reference.includes('batshit-zip:cool_tool_')
      )

      const hasUpstreamIntermediateSteps =
        Array.isArray(data.intermediateSteps) && data.intermediateSteps.length > 0

      const effectiveAgentType = normalizePrimaryAgentType(
        agentSettings,
        eventData.metadata?.agentType ?? data.metadata?.agentType,
      )
      const isManagedAgent = isManagedPrimaryAgentType(effectiveAgentType)
      const isN8nAgent = isN8nPrimaryAgentType(effectiveAgentType)

      // Build fallback intermediate steps from streamed tool_result events when n8n omits intermediateSteps
      const activeState = activeStreams.get(sessionId)
      const toolResultEvents = (activeState?.events ?? [])
        .filter((e: any) =>
          (e.type === 'tool-result' || e.type === 'tool_result') &&
          (!messageId || e.messageId === messageId)
        )
      const reconstructedSteps = (!data.intermediateSteps || data.intermediateSteps.length === 0)
        ? toolResultEvents.map((e: any) => ({
            tool: e.toolName,
            toolName: e.toolName,
            toolArgs: e.args,
            toolResult: e.result,
            action: { tool: e.toolName, toolInput: e.args },
            observation: e.result,
            metadata: e.metadata
          }))
        : data.intermediateSteps

      // Integrate Cool Tools via adapter
      const coolToolZips = hasIncomingCoolToolZips || isManagedAgent
        ? []
        : await adaptCoolToolsToZipSystem(
            reconstructedSteps,
            sessionId,
            messageId,
            agentSettings,
            options.globalZipSettings
          )

      // Recompute streamingContent after we may have added tool_result-derived zips above
      const streamEvents = (activeState?.events ?? [])
        .filter((event) => !messageId || event.messageId === messageId)
      const replayToolZipRefs = dedupeZipReferences([
        ...incomingZipReferences,
        ...coolToolZips
      ]).filter(
        (ref) =>
          typeof ref?.reference === 'string' &&
          ref.reference.includes('batshit-zip:cool_tool_')
      )
      const supportsInlineToolReplay = isManagedAgent || isN8nAgent
      const streamingContentResult = buildEndStreamingContent({
        streamEvents: streamEvents as any,
        inlineCapable: supportsInlineToolReplay,
        toolZipRefs: replayToolZipRefs,
        allZipRefs: dedupeZipReferences([
          ...incomingZipReferences,
          ...streamingRefs,
          ...zipRefs,
          ...coolToolZips
        ])
      })
      const streamingContent = streamingContentResult.content

      // Merge all zip references
      const allZipRefs = dedupeZipReferences([
        ...incomingZipReferences,
        ...streamingRefs,
        ...zipRefs,
        ...coolToolZips
      ])

      // Replace any streaming placeholders with their final zip references (defensive; placeholders should no longer be emitted)
      const replacePlaceholders = (content: string): string => {
        let output = content
        for (const ref of allZipRefs) {
          if (ref.placeholder) {
            output = output.replaceAll(ref.placeholder, ref.reference)
          }
        }
        return output
      }

      // SA-911: Simplified - tools now handled inline during streaming
      // Just clean up any stray placeholders. Missing refs were already appended
      // by the end-content builder with mode-aware inline replay rules.
      let workingContent = streamingContent.replace(/\{\{TOOL_LOADING_PLACEHOLDER:[^}]+\}\}/g, '')

      // Swap any ZIP placeholders with their real references before further processing
      workingContent = replacePlaceholders(workingContent)

      const hasToolArtifacts =
        hasUpstreamIntermediateSteps || hasIncomingCoolToolZips || coolToolZips.length > 0

      const sanitizedEndContent = replacePlaceholders(
        sanitizeAssistantContent(
          data.content || eventData.content || '',
          hasToolArtifacts
        )
      )

      if (workingContent.trim().length === 0 && sanitizedEndContent) {
        workingContent = sanitizedEndContent
      }

      const finalSanitizedContent = sanitizeAssistantContent(
        workingContent,
        hasToolArtifacts
      )

      const finalContent =
        finalSanitizedContent && finalSanitizedContent.trim().length > 0
          ? finalSanitizedContent
          : sanitizedEndContent || allZipRefs.map((ref) => ref.reference).join('\n\n')
      const subagentSanitizedContent = stripLeadingSubagentEchoText(
        finalContent,
        reconstructedSteps || []
      )

      // SA-911: Dedupe zip refs and clean up whitespace
      const seenZips = new Set<string>()
      let cleanedFinalContent = subagentSanitizedContent.replace(/\{\{batshit-zip:[^}]+\}\}/g, (match) => {
        if (seenZips.has(match)) return ''
        seenZips.add(match)
        return match
      })
      const trustedFinalZipIds = allZipRefs
        .map((ref) => extractZipIdFromReference(ref.reference))
        .filter((id): id is string => Boolean(id))
      cleanedFinalContent = neutralizeUntrustedZipReferenceSyntax(cleanedFinalContent, {
        trustedZipIds: trustedFinalZipIds
      })
      cleanedFinalContent = neutralizeAllClipReferenceSyntax(cleanedFinalContent)
      cleanedFinalContent = cleanedFinalContent.replace(/\n{3,}/g, '\n\n').trim()

      logger.debug('[SSE] Finalized message content', {
        sessionId,
        messageId,
        streamingLength: streamingContent.length,
        finalLength: cleanedFinalContent.length,
        zipCount: allZipRefs.length
      })

      const endMetadata =
        data.metadata && typeof data.metadata === 'object'
          ? data.metadata
          : eventData && typeof eventData === 'object' && !Array.isArray(eventData)
            ? (eventData.metadata && typeof eventData.metadata === 'object'
                ? eventData.metadata
                : eventData)
            : {}

      const endEvent = await adapter.emitEnd({
        content: cleanedFinalContent,
        intermediateSteps: reconstructedSteps || [],
        zipReferences: allZipRefs,
        metadata: endMetadata
      })

      enqueueWithTelemetry(sessionId, controller as SSEController, endEvent)
      appendActiveStreamEvent(sessionId, endEvent)
      // Some upstreams never send a "complete" event; ensure the active stream
      // is cleared after the end payload to avoid replaying stale chunks on refresh.
      scheduleActiveStreamCleanup(sessionId, messageId)

      // Clear references handled in zipDetection.finalizeOpenBlocks
      break
    }

    case 'complete': {
      const completeEvent = await adapter.emitComplete({
        metadata: data.metadata || eventData.metadata || {}
      })
      enqueueWithTelemetry(sessionId, controller as SSEController, completeEvent)
      appendActiveStreamEvent(sessionId, completeEvent)
      scheduleActiveStreamCleanup(sessionId, messageId)
      resetStreamAdapter(sessionId)
      break
    }

    case 'error': {
      // Canonical error events are flat ({ type, error, metadata }), so the
      // eventData remap above resolves to data.metadata and would lose the
      // error text — read the flat fields first, legacy nested shapes second.
      const errorEvent = await adapter.emitError({
        error:
          data.error ||
          data.message ||
          eventData.error ||
          eventData.message ||
          'Unknown error',
        metadata: data.metadata || eventData.metadata || {}
      })
      enqueueWithTelemetry(sessionId, controller as SSEController, errorEvent)
      appendActiveStreamEvent(sessionId, errorEvent)
      scheduleActiveStreamCleanup(sessionId, messageId)
      break
    }

    default:
      // Forward unknown events as-is for debugging
      logger.debug(`[SSE] Forwarding unknown event type: ${eventType}`)
      const forwardedEvent = {
        type: eventType,
        ...data,
        ...eventData
      }
      enqueueWithTelemetry(sessionId, controller as SSEController, forwardedEvent)
      appendActiveStreamEvent(sessionId, forwardedEvent)
  }
}

/**
 * Process streaming content for zip patterns
 * Detects zip-capable XML content such as error blocks
 */

/**
 * Set up Redis keyspace monitoring for zip activity
 * Provides real-time visual indicator updates
 */
async function setupRedisMonitoring(
  sessionId: string,
  controller: SSEController
) {
  try {
    await initializeKeyspaceNotifications()

    const cleanup = await setupSessionMonitoring(sessionId, (event: VisualIndicatorEvent) => {
      // Forward visual indicator events through SSE
      try {
        enqueueWithTelemetry(sessionId, controller, {
          type: 'zip_activity_change',
          event,
          sessionId,
          timestamp: new Date().toISOString()
        })

        // Log for debugging (< 50ms latency requirement)
        const latency = Date.now() - event.timestamp
        if (latency > 50) {
          logger.warn(`[SSE] Visual indicator latency: ${latency}ms (exceeds 50ms target)`)
        }
      } catch (err) {
        console.error('[SSE] Failed to send visual indicator event:', err)
      }
    })

    // Store cleanup function for later
    controller._visualCleanup = cleanup

    logger.debug('[SSE] Visual indicator monitoring active for session:', sessionId)
  } catch (err) {
    console.error('[SSE] Failed to setup visual indicator monitoring:', err)
    // Continue without monitoring - it's an enhancement
  }
}

/**
 * POST endpoint for canonical streaming data.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  let data: any
  try {
    data = await request.json()
  } catch {
    throw error(400, 'Invalid JSON body')
  }
  const { sessionId } = data

  if (!sessionId) {
    throw error(400, 'Session ID is required')
  }

  const isTrustedCallback =
    isTrustedInternalRequest(request) ||
    (await isTrustedN8nSseCallbackRequest(request, data))

  if (isTrustedCallback) {
    const session = await redis.getSession(sessionId)
    if (!session) {
      throw error(404, 'Session not found')
    }
  } else {
    if (!locals.user?.id) {
      throw error(401, 'Unauthorized')
    }

    const sessionCheck = await requireOwnedSession(sessionId, locals.user.id)
    if (!sessionCheck.ok) return sessionCheck.response
  }

  const sessionControllers = connections.get(sessionId)
  if (!sessionControllers || sessionControllers.size === 0) {
    // No active SSE connection - this is normal for async webhook calls
    logger.debug('[SSE] No active connection for session:', sessionId)
    return new Response(JSON.stringify({
      success: false,
      message: 'No active SSE connection'
    }), {
      status: 200, // Return 200 to not fail the webhook
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Process as a regular n8n-style event through the NDJSON handler.
  const globalZipSettings = sessionZipSettings.get(sessionId)
  const { controller: collector, events } = createCollectingController(sessionId)
  await processNDJSONLine(sessionId, data, collector, { globalZipSettings })

  for (const event of events) {
    for (const controller of sessionControllers) {
      enqueueWithTelemetry(sessionId, controller, event)
    }
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

function getActiveStreamState(sessionId: string) {
  let state = activeStreams.get(sessionId)
  if (!state) {
    state = { events: [], messageIds: new Set(), nextEventIndex: 0 }
    activeStreams.set(sessionId, state)
  }
  return state
}

function ensureActiveStreamEventId(sessionId: string, event: StreamEventPayload) {
  if (!event?.messageId) return event
  if (typeof event.sseEventId === 'string' && event.sseEventId.trim().length > 0) {
    return event
  }

  const state = getActiveStreamState(sessionId)
  state.nextEventIndex += 1
  event.sseEventId = `${event.messageId}:${state.nextEventIndex}`
  return event
}

function initializeActiveStream(sessionId: string, event: StreamEventPayload) {
  ensureActiveStreamEventId(sessionId, event)
  if (event.messageId) {
    clearActiveStreamCleanup(sessionId, event.messageId)
  }
  const state = getActiveStreamState(sessionId)
  state.events.push(event)
  if (event.messageId) {
    state.messageIds.add(event.messageId)
  }
}

function appendActiveStreamEvent(sessionId: string, event: StreamEventPayload) {
  if (!event.messageId) {
    logger.debug('[SSE] Skipping messageId-less event in active stream replay buffer', {
      sessionId,
      eventType: event.type
    })
    return
  }
  ensureActiveStreamEventId(sessionId, event)
  const state = getActiveStreamState(sessionId)
  state.messageIds.add(event.messageId)
  state.events.push(event)
}

function replayActiveStreamForListener(sessionId: string, controller: SSEController) {
  const state = activeStreams.get(sessionId)
  if (!state || state.events.length === 0) {
    return
  }

  logger.debug('[SSE] Replaying active stream for new listener', {
    sessionId,
    eventCount: state.events.length
  })

  for (const event of state.events) {
    enqueueWithTelemetry(sessionId, controller, event)
  }
}

function removeController(sessionId: string, controller: SSEController) {
  const sessionControllers = connections.get(sessionId)
  if (!sessionControllers || !sessionControllers.has(controller)) {
    return
  }

  controller._closed = true

  if (controller._heartbeat) {
    clearInterval(controller._heartbeat)
    controller._heartbeat = undefined
  }
  if (controller._visualCleanup) {
    void Promise.resolve(controller._visualCleanup()).catch((error) => {
      console.error('[SSE] Failed to close visual monitoring:', error)
    })
  }
  sessionControllers.delete(controller)

  if (sessionControllers.size === 0) {
    connections.delete(sessionId)
  }
}

function enqueueWithTelemetry(sessionId: string, controller: SSEController, payload: any) {
  if (controller._closed) {
    logger.debug('[SSE] Skipping enqueue on closed controller', {
      controllerId: controller._id,
      payloadType: payload?.type,
      sessionId
    })
    return
  }

  try {
    if (payload && typeof payload === 'object' && typeof payload.messageId === 'string') {
      ensureActiveStreamEventId(sessionId, payload as StreamEventPayload)
    }
    controller.enqueue(`data: ${JSON.stringify(payload)}\n\n`)
  } catch (error) {
    const isClosed =
      error instanceof TypeError &&
      typeof error.message === 'string' &&
      error.message.includes('Invalid state')

    if (isClosed) {
      logger.debug('[SSE] Controller already closed, dropping payload', {
        controllerId: controller._id,
        payloadType: payload?.type,
        sessionId
      })
    } else {
      console.error('[SSE] Failed to enqueue payload', {
        controllerId: controller._id,
        payloadType: payload?.type,
        sessionId,
        error
      })
    }
    removeController(sessionId, controller)
  }
}

function createCollectingController(sessionId: string) {
  const events: StreamEventPayload[] = []
  const controller = {
    _id: `collector_${sessionId}`,
    _closed: false,
    enqueue(chunk: string) {
      if (typeof chunk !== 'string' || !chunk.startsWith('data: ')) return
      const payloadText = chunk.slice(6).trim()
      if (!payloadText) return
      try {
        events.push(JSON.parse(payloadText))
      } catch (error) {
        logger.warn('[SSE] Failed to parse collected event payload', {
          sessionId,
          error
        })
      }
    }
  } as unknown as SSEController

  return { controller, events }
}

function scheduleActiveStreamCleanup(sessionId: string, messageId?: string, delay = 5000) {
  if (!messageId) {
    return
  }
  clearActiveStreamCleanup(sessionId, messageId)
  const timers = activeStreamCleanupTimers.get(sessionId) ?? new Map()
  const timer = setTimeout(() => {
    const state = activeStreams.get(sessionId)
    if (state) {
      state.events = state.events.filter((event) => event.messageId !== messageId)
      state.messageIds.delete(messageId)
      if (state.events.length === 0) {
        activeStreams.delete(sessionId)
      }
    }

    const existingTimers = activeStreamCleanupTimers.get(sessionId)
    if (existingTimers) {
      existingTimers.delete(messageId)
      if (existingTimers.size === 0) {
        activeStreamCleanupTimers.delete(sessionId)
      }
    }

    logger.debug('[SSE] Active stream state cleared', { sessionId, messageId })
  }, delay)
  timers.set(messageId, timer)
  activeStreamCleanupTimers.set(sessionId, timers)
}

function clearActiveStreamCleanup(sessionId: string, messageId?: string) {
  if (!messageId) return
  const timers = activeStreamCleanupTimers.get(sessionId)
  const timer = timers?.get(messageId)
  if (timer) {
    clearTimeout(timer)
    timers?.delete(messageId)
    if (timers && timers.size === 0) {
      activeStreamCleanupTimers.delete(sessionId)
    }
  }
}
