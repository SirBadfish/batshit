import { error, json } from '@sveltejs/kit'
import { logger } from '$lib/utils/logger'
import { readApprovalResumeStart } from '$lib/utils/approvalResumeStream'
import { mergeResumedMetadata, mergeResumedSteps } from '$lib/server/services/approvalResumeMessage'
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
import { ZipDetectionService } from '$lib/server/services/zipDetection'
import { createClient } from 'redis'
import { env } from '$env/dynamic/private'
import { buildEndStreamingContent } from '$lib/server/services/sseEndContentBuilder'
import { stripLeadingSubagentEchoText } from '$lib/server/services/finalAssistantTextSanitizer'
import {
  canonicalizePrimaryAgentRecord,
  isManagedPrimaryAgentType,
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
  collectTrustedZipIdsFromMetadata,
  neutralizeAllClipReferenceSyntax,
  neutralizeUntrustedZipReferenceSyntax
} from '$lib/utils/zipReferenceSafety'
import { registerRuntimeShutdownTask } from '$lib/server/services/runtimeShutdown'
import { parseSseChannel } from '$lib/server/ssePublisher'
import { getWakeRun, hasActiveWakeRun } from '$lib/server/services/wakeRunRegistry'
import {
  createLiveHubRegistry,
  parseHubSubscriptionChange,
  type HubListener
} from '$lib/server/sseLiveHub'
import {
  TURN_SHUTDOWN_WAIT_MS,
  hasTurnOutcome,
  waitForRunningTurns,
  watchTurnOutcome
} from '$lib/server/services/turnOutcomeRegistry'
import type { TurnOverEvent } from '$lib/services/liveHub/protocol'

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
  /**
   * End finalization needs the WHOLE current run even when the joining-aid replay buffer is
   * capped. One entry per active message keeps its start envelope plus only content/tool events;
   * adjacent text chunks are coalesced so a long answer does not retain thousands of objects.
   */
  reconstructionByMessage: Map<string, {
    start: StreamEventPayload | null;
    events: StreamEventPayload[];
  }>;
}

// Active SSE connections (can have multiple listeners per session)
const connections = new Map<string, Set<SSEController>>()
/**
 * SA-113 P1 (DL-113-06) — the user-scoped channel, kept in its own map on purpose.
 * A user connection is not a session connection: it has no zip buffers, no stream adapter,
 * and no replay buffer, so sharing `connections` would run session-shaped teardown against
 * a user id.
 */
const userConnections = new Map<string, Set<SSEController>>()
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
        // SA-113 P1: the same pattern now carries two channel shapes. `parseSseChannel`
        // is THE rule that tells them apart, so a user event can never be mistaken for a
        // session whose id happens to start with the user segment.
        const parsed = parseSseChannel(channel)
        if (!parsed) return

        let payload: any = { type: 'external_event', raw: message }
        try {
          payload = JSON.parse(message)
        } catch {
          // keep fallback payload
        }

        if (parsed.scope === 'user') {
          forwardUserEvent(parsed.userId, payload)
          return
        }

        forwardExternalEvent(parsed.sessionId, payload)
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
    // A send answered early (respond-async, 2026-09-18) is still running here, and its tab hears
    // how it ended only over its live hub. Its request used to be one adapter-node drained before
    // it closed (up to 30 s); now the hubs stay open until those turns end, and Redis stays up
    // until this task is done (`closeRuntimeResources` in hooks.server.ts awaits it first).
    if (!(await waitForRunningTurns(TURN_SHUTDOWN_WAIT_MS))) {
      console.warn(`[SSE] Closing the live streams with a reply still running (${reason})`)
    }
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

    for (const userControllers of userConnections.values()) {
      for (const controller of userControllers) {
        controller._closed = true
        if (controller._heartbeat) {
          clearInterval(controller._heartbeat)
          controller._heartbeat = undefined
        }
        try {
          controller.close()
        } catch {
          // The client may already have closed the stream.
        }
      }
    }
    userConnections.clear()
    // Every listener above may have been a live hub subscription; now end the hub streams.
    liveHubs.closeAllStreams()

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

/**
 * SA-113 P1 (DL-113-06). Deliberately does NOT go through `enqueueWithTelemetry`: that
 * helper stamps `sseEventId` into the SESSION replay buffer for any payload carrying a
 * `messageId`, which would file a user-channel event under a phantom session.
 */
function forwardUserEvent(userId: string, payload: any) {
  const listeners = userConnections.get(userId)
  if (!listeners || listeners.size === 0) return

  for (const controller of listeners) {
    if (controller._closed) continue
    try {
      controller.enqueue(`data: ${JSON.stringify(payload)}\n\n`)
    } catch (err) {
      logger.debug('[SSE] Dropping a closed user-channel controller', {
        userId,
        controllerId: controller._id,
        error: err
      })
      removeUserController(userId, controller)
    }
  }
}

function removeUserController(userId: string, controller: SSEController) {
  const listeners = userConnections.get(userId)
  if (!listeners) return
  controller._closed = true
  if (controller._heartbeat) {
    clearInterval(controller._heartbeat)
    controller._heartbeat = undefined
  }
  listeners.delete(controller)
  if (listeners.size === 0) userConnections.delete(userId)
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

/**
 * SA-113 F-P1-2 — sessions whose zip settings were loaded for a headless woken turn
 * rather than by a tab connecting.
 *
 * `sessionZipSettings` is normally filled when a tab subscribes to the chat
 * (`attachSessionListener`) and dropped when its last listener goes. A woken turn can stream with nobody watching, and AMD-113-01 hands its zips
 * to the stream path, so without this the user's own thresholds would be ignored for
 * exactly the turns they never see happen. Tracking which entries the wake path owns is
 * what lets them be dropped again without touching an entry a real tab owns.
 */
const wakeOwnedZipSettings = new Set<string>()

async function ensureZipSettingsForWakeRun(sessionId: string, userId: string) {
  if (sessionZipSettings.has(sessionId)) return
  let globalZipSettings: Record<string, any> | undefined = undefined
  try {
    const userSettings = await redis.getUserSettings(userId)
    globalZipSettings = userSettings?.global_zip_settings || undefined
  } catch (err) {
    console.error('[SSE] Failed to load zip settings for a woken turn:', err)
  }
  sessionZipSettings.set(sessionId, globalZipSettings)
  wakeOwnedZipSettings.add(sessionId)
}

function releaseWakeOwnedZipSettings(sessionId: string) {
  if (!wakeOwnedZipSettings.delete(sessionId)) return
  // A tab that connected meanwhile now owns the entry and its disconnect drops it.
  const sessionControllers = connections.get(sessionId)
  if (sessionControllers && sessionControllers.size > 0) return
  sessionZipSettings.delete(sessionId)
}

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
 * Attach one listener to a chat: what a tab's own `GET /api/sse?sessionId=` did when it
 * connected, before the live hub (2026-09-18). Loads the user's zip settings, files the
 * listener, greets it, replays the chat's live turn to it, and starts zip-activity monitoring.
 * The live hub calls this once per chat SUBSCRIPTION, so two tabs on one chat are still two
 * listeners, as they were when each had its own stream.
 */
async function attachSessionListener(
  sessionId: string,
  controllerRef: SSEController,
  userId: string
) {
  let globalZipSettings: Record<string, any> | undefined = undefined
  try {
    const userSettings = await redis.getUserSettings(userId)
    globalZipSettings = userSettings?.global_zip_settings || undefined
  } catch (err) {
    console.error('[SSE] Failed to load user zip settings:', err)
  }

  sessionZipSettings.set(sessionId, globalZipSettings)
  // A real tab now owns this entry; its disconnect is what drops it (F-P1-2).
  wakeOwnedZipSettings.delete(sessionId)

  if (!controllerRef._id) {
    controllerRef._id = `sse-${randomUUID()}`
  }

  // Store connection (support multiple concurrent listeners)
  let sessionControllers = connections.get(sessionId)
  if (!sessionControllers) {
    sessionControllers = new Set<SSEController>()
    connections.set(sessionId, sessionControllers)
  }
  sessionControllers.add(controllerRef)

  logger.debug('[SSE] Active listeners for session', {
    sessionId,
    listenerCount: sessionControllers.size,
    controllers: Array.from(sessionControllers).map((entry) => entry._id)
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

  // Set up Redis keyspace monitoring for zip activity
  try {
    await setupRedisMonitoring(sessionId, controllerRef)
  } catch (err) {
    console.error('[SSE] Error setting up Redis monitoring:', err)
    // Continue anyway - monitoring is optional
  }

  // Shutdown can begin while the async Redis subscription is still being
  // established. If it did, tear down the late resource immediately.
  if (controllerRef._closed) {
    const lateVisualCleanup = controllerRef._visualCleanup
    controllerRef._visualCleanup = undefined
    await lateVisualCleanup?.()
  }
}

/**
 * Detach one listener from a chat: what a tab's stream closing did before the live hub. When
 * the chat's LAST listener goes, its zip buffers, caches, stream adapter, and temp storage are
 * torn down, exactly as before.
 */
async function detachSessionListener(sessionId: string, cancelController: SSEController) {
  logger.debug('[SSE] Connection closed for session:', sessionId)

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

/**
 * SA-113 P1 (DL-113-06) — attach one listener to the user-scoped live channel, which carries
 * `session_created`, `session_updated`, `session_run_status`, `dm_inbox_changed`, and the chat
 * page's re-read events. Intentionally simpler than a chat listener: no zip settings, no stream
 * adapter, no replay buffer, no visual-indicator monitoring. Those are all chat concerns.
 */
function attachUserListener(userId: string, controller: SSEController) {
  let listeners = userConnections.get(userId)
  if (!listeners) {
    listeners = new Set<SSEController>()
    userConnections.set(userId, listeners)
  }
  listeners.add(controller)

  try {
    controller.enqueue(`data: ${JSON.stringify({ type: 'connected', scope: 'user' })}\n\n`)
  } catch (err) {
    logger.debug('[SSE] Failed to greet a user-channel listener', { userId, error: err })
  }

  logger.debug('[SSE] User channel opened', { userId, controllerId: controller._id })
}

function sessionRefusalCode(status: number) {
  if (status === 404) return 'session_not_found'
  if (status === 403) return 'forbidden'
  return 'invalid_session'
}

/**
 * A send's turn (2026-09-18). The page's send is answered once the server owns its turn
 * (`Prefer: respond-async`, `respondAsyncSend.ts`), so its request no longer holds one of the
 * browser's six connections for the whole reply; the tab subscribes to the turn and hears ONE
 * event, `turn_over`, with the answer send-routed gave at the end of the turn. A subscription
 * added after the turn ended gets it at once (the registry keeps it), which is what keeps a hub
 * that reconnected mid-reply from waiting forever. Another user's turn and an unknown one are
 * refused alike, `turn_not_found`.
 */
const turnWatchStops = new WeakMap<HubListener, () => void>()

function attachTurnListener(turnId: string, listener: HubListener, userId: string) {
  const stop = watchTurnOutcome(turnId, userId, (outcome) => {
    const event: TurnOverEvent = { type: 'turn_over', turnId, ...outcome }
    listener.enqueue(`data: ${JSON.stringify(event)}\n\n`)
  })
  if (!stop) throw new Error('turn_not_found')
  turnWatchStops.set(listener, stop)
}

function detachTurnListener(listener: HubListener) {
  turnWatchStops.get(listener)?.()
  turnWatchStops.delete(listener)
}

/**
 * The live hub (2026-09-18): ONE stream per browser. A browser opens at most six HTTP/1.1
 * connections to one server, shared by all its tabs, and every chat tab used to hold two of
 * them forever (its user channel and the chat on screen), so three tabs froze every request of
 * every tab. Now the browser's SharedWorker opens `GET /api/sse?scope=hub` once and adds or
 * removes subscriptions with `PATCH /api/sse`. Every subscription is its OWN listener, filed in
 * `connections` or `userConnections` by the functions above, so the rules of this route (drop an
 * event nobody hears, replay a live turn to a new listener, tear a chat down with its last
 * listener) did not change. `$lib/server/sseLiveHub.ts` owns the hubs; the wire format is
 * `$lib/services/liveHub/protocol.ts`.
 */
const liveHubs = createLiveHubRegistry({
  async ownsSession(sessionId, userId) {
    const check = await requireOwnedSession(sessionId, userId)
    if (check.ok) return { ok: true }
    const status = check.response.status
    return { ok: false, status, code: sessionRefusalCode(status) }
  },
  attachSession: (sessionId, listener, userId) =>
    attachSessionListener(sessionId, listener as unknown as SSEController, userId),
  detachSession: (sessionId, listener) =>
    detachSessionListener(sessionId, listener as unknown as SSEController),
  attachUser: (userId, listener) => attachUserListener(userId, listener as unknown as SSEController),
  detachUser: (userId, listener) => removeUserController(userId, listener as unknown as SSEController),
  ownsTurn: (turnId, userId) =>
    hasTurnOutcome(turnId, userId) ? { ok: true } : { ok: false, status: 404, code: 'turn_not_found' },
  attachTurn: (turnId, listener, userId) => attachTurnListener(turnId, listener, userId),
  detachTurn: (_turnId, listener) => detachTurnListener(listener)
})

/**
 * `GET /api/sse?scope=hub` — the browser's one live stream. Cookie-only: an `EventSource`
 * cannot send headers, so there is no token lane here and there must not be one. The first
 * frame is `hub_connected` with this stream's hub id; every later frame is one subscription's
 * event, wrapped with its id.
 */
async function openLiveHub(url: URL, locals: App.Locals): Promise<Response> {
  if (!locals.user) {
    throw error(401, 'Unauthorized')
  }
  const userId = locals.user.id

  await ensureExternalSubscriber()

  let hubId: string | null = null
  const stream = new ReadableStream({
    start(controller) {
      hubId = liveHubs.open(userId, {
        write: (text) => controller.enqueue(text),
        close: () => controller.close()
      }).id
      logger.debug('[SSE] Live hub opened', { userId, hubId })
    },
    async cancel() {
      if (!hubId) return
      logger.debug('[SSE] Live hub closed', { userId, hubId })
      await liveHubs.close(hubId)
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': url.origin
    }
  })
}

/**
 * The browser's live stream. Only `?scope=hub` remains: the per-tab streams
 * (`?sessionId=` and `?scope=user`) were removed with the live hub on 2026-09-18. A tab that was
 * open across that update gets 410 and stops hearing live updates until it reloads.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
  if (url.searchParams.get('scope') === 'hub') {
    return openLiveHub(url, locals)
  }
  throw error(410, 'Batshit now sends live updates over one connection per browser. Reload this page.')
}

/**
 * `PATCH /api/sse` — add or remove subscriptions on one of this user's live hubs. Removals run
 * before additions; a chat the user does not own is refused per subscription, never attached.
 * Answers `{ added, removed, refused }`, or 404 `hub_not_found` when the hub is gone (its
 * stream closed, or the server restarted), which makes the browser open a new one.
 */
export const PATCH: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    throw error(401, 'Unauthorized')
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw error(400, 'Invalid JSON body')
  }
  const parsed = parseHubSubscriptionChange(body)
  if (!parsed.ok) {
    return json({ error: parsed.error, code: 'invalid_change' }, { status: 400 })
  }
  const answer = await liveHubs.change(locals.user.id, parsed.value)
  return json(answer.body, { status: answer.status })
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

    /**
     * SA-114 (DL-114-03) — the three steer events.
     *
     * They are forwarded verbatim AND appended to the replay buffer, which is the whole
     * point of routing them through this POST rather than `publishSessionEvent`: a tab
     * opened mid-turn replays `steer_queued` and `steer_delivered` in order, so the inset
     * inside the reply is never unexplained. The default branch below would already
     * forward them; they get their own case so the contract is deliberate rather than
     * inherited from an "unknown event" fallback.
     */
    case 'steer_queued':
    case 'steer_delivered':
    case 'steer_promoted': {
      const steerEvent = {
        type: eventType,
        sessionId,
        ...data,
        ...eventData
      }
      enqueueWithTelemetry(sessionId, controller as SSEController, steerEvent)
      appendActiveStreamEvent(sessionId, steerEvent)
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

      // Build fallback intermediate steps from streamed tool_result events when n8n omits intermediateSteps
      const activeState = activeStreams.get(sessionId)
      const reconstruction = messageId
        ? activeState?.reconstructionByMessage.get(messageId)
        : undefined
      const resumeStartEvent = reconstruction?.start
      const approvalResume = readApprovalResumeStart(resumeStartEvent?.metadata)
      const priorZipReferences: ZipReference[] = Array.isArray(approvalResume?.prior.metadata.zipReferences)
        ? approvalResume.prior.metadata.zipReferences
        : []
      // The capped replay buffer is only a joining aid. End content must use the complete,
      // compact reconstruction for THIS start, independent of another same-id approval run.
      const reconstructionEvents = reconstruction?.events ?? (activeState?.events ?? [])
        .filter((event) => !messageId || event.messageId === messageId)
      const toolResultEvents = reconstructionEvents
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

      // SA-106: the cool-tool zip adapter ran here only for NON-managed agents, i.e.
      // the retired n8n Primary lane, which reconstructed its tool steps at end. Every
      // surviving producer is managed and creates its zips inline during the stream, so
      // this was already a no-op for them. `reconstructedSteps` itself STAYS — it still
      // feeds subagent-echo stripping and the end event's `intermediateSteps`.
      const coolToolZips: typeof incomingZipReferences = []

      // Recompute streamingContent after we may have added tool_result-derived zips above
      const streamEvents = reconstructionEvents
      const replayToolZipRefs = dedupeZipReferences([
        ...incomingZipReferences,
        ...coolToolZips
      ]).filter(
        (ref) =>
          typeof ref?.reference === 'string' &&
          ref.reference.includes('batshit-zip:cool_tool_')
      )
      const supportsInlineToolReplay = isManagedAgent
      const streamingContentResult = buildEndStreamingContent({
        priorContent: approvalResume?.prior.content,
        streamEvents: streamEvents as any,
        inlineCapable: supportsInlineToolReplay,
        toolZipRefs: replayToolZipRefs,
        allZipRefs: dedupeZipReferences([
          ...priorZipReferences,
          ...incomingZipReferences,
          ...streamingRefs,
          ...zipRefs,
          ...coolToolZips
        ])
      })
      const streamingContent = streamingContentResult.content

      // Merge all zip references
      const allZipRefs = dedupeZipReferences([
        ...priorZipReferences,
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
      const trustedFinalZipIds = Array.from(new Set([
        ...collectTrustedZipIdsFromMetadata(approvalResume?.prior.metadata),
        ...allZipRefs
          .map((ref) => extractZipIdFromReference(ref.reference))
          .filter((id): id is string => Boolean(id))
      ]))
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
        intermediateSteps: approvalResume
          ? mergeResumedSteps(approvalResume.prior.intermediateSteps, reconstructedSteps) || []
          : reconstructedSteps || [],
        zipReferences: allZipRefs,
        metadata: approvalResume ? mergeResumedMetadata(approvalResume.prior.metadata, endMetadata) : endMetadata
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
      // error text — read the flat fields FIRST, legacy nested shapes second.
      // That ordering is a Fragility-Map pin; do not reverse it.
      //
      // SA-106 removed the two trailing `content` fallbacks: they existed only for the
      // n8n native-stream error shape, which carried its text in the same `content`
      // field its item/chunk events used. No surviving producer emits that shape.
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
  const hasListeners = Boolean(sessionControllers && sessionControllers.size > 0)

  // SA-113 P1 / AMD-113-01 — a woken turn is watchable even before anyone watches it.
  //
  // Dropping events for an unwatched session is right for an async n8n callback, but a
  // wake-up opens a real user-facing chat. The P0 spike measured the cost: a tab opened
  // 7 s into a headless turn received no `start`, no `tool-call`, and none of the first
  // chunks, so the reply appeared to begin mid-sentence. Running the event through the
  // normal path fills the replay buffer, and a tab that joins mid-turn then gets the
  // existing replay.
  //
  // Returning `success: true` also hands this turn's zips to the stream path, exactly as
  // for a watched turn — send-routed reads that flag to decide whether to run its batch
  // zip pass instead (`selectFinishZipInput`).
  const bufferForWakeRun = !hasListeners && hasActiveWakeRun(sessionId)

  if (!hasListeners && !bufferForWakeRun) {
    // The woken turn is over and nobody is watching: give back any zip settings the wake
    // path loaded, in case the turn ended without a terminal event (F-P1-2).
    releaseWakeOwnedZipSettings(sessionId)
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

  // F-P1-2 — a headless woken turn must zip by the user's own thresholds. Nothing has
  // loaded them, because loading happens when a tab connects; the wake registry knows
  // whose turn this is.
  if (bufferForWakeRun) {
    const wakeRun = getWakeRun(sessionId)
    if (wakeRun) await ensureZipSettingsForWakeRun(sessionId, wakeRun.userId)
  }

  // Process as a regular n8n-style event through the NDJSON handler.
  const globalZipSettings = sessionZipSettings.get(sessionId)
  const { controller: collector, events } = createCollectingController(sessionId)
  await processNDJSONLine(sessionId, data, collector, { globalZipSettings })

  for (const event of events) {
    for (const controller of sessionControllers ?? []) {
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
    state = {
      events: [],
      messageIds: new Set(),
      nextEventIndex: 0,
      reconstructionByMessage: new Map()
    }
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

/**
 * The replay buffer is a JOINING AID, not a transcript, so it is capped.
 *
 * It used to be self-limiting: a session with no listener returned early and nothing was
 * buffered at all. `bufferForWakeRun` removed that floor on purpose — a headless woken turn
 * now fills the buffer so a tab opened mid-turn joins cleanly — which left an unbounded
 * array growing for a run nobody is watching. A wake-up may run for
 * `MAX_WAKE_TIMEOUT_MINUTES` (240) and three may run at once, so three complete
 * object-per-chunk transcripts could sit resident for four hours each.
 *
 * Keeping the most recent slice is enough for what the buffer is for: a joining tab wants
 * the tail it missed. The message's start is pinned separately so the tail always has an owner,
 * and complete end reconstruction is also separate so this cap can never truncate persistence.
 * The terminal-event cleanup still clears the whole entry as before.
 */
const MAX_ACTIVE_STREAM_REPLAY_EVENTS = 2000

const END_RECONSTRUCTION_EVENT_TYPES = new Set([
  'chunk',
  'tool_start',
  'tool-call',
  'tool_call',
  'tool-result',
  'tool_result'
])

function appendEndReconstructionEvent(
  state: ReturnType<typeof getActiveStreamState>,
  event: StreamEventPayload
) {
  const messageId = event.messageId
  if (!messageId || !END_RECONSTRUCTION_EVENT_TYPES.has(event.type)) return

  let reconstruction = state.reconstructionByMessage.get(messageId)
  if (!reconstruction) {
    reconstruction = { start: null, events: [] }
    state.reconstructionByMessage.set(messageId, reconstruction)
  }

  const last = reconstruction.events[reconstruction.events.length - 1]
  if (
    event.type === 'chunk' &&
    last?.type === 'chunk' &&
    typeof last.content === 'string' &&
    typeof event.content === 'string'
  ) {
    // End reconstruction only needs the complete text, not one object per provider delta.
    last.content += event.content
    return
  }

  reconstruction.events.push({ ...event })
}

function pushActiveStreamEvent(
  state: ReturnType<typeof getActiveStreamState>,
  event: StreamEventPayload
) {
  state.events.push(event)
  if (state.events.length > MAX_ACTIVE_STREAM_REPLAY_EVENTS) {
    state.events.splice(0, state.events.length - MAX_ACTIVE_STREAM_REPLAY_EVENTS)
  }
}

function initializeActiveStream(sessionId: string, event: StreamEventPayload) {
  ensureActiveStreamEventId(sessionId, event)
  if (event.messageId) {
    clearActiveStreamCleanup(sessionId, event.messageId)
  }
  const state = getActiveStreamState(sessionId)
  if (event.messageId) {
    // Approval resumes deliberately reuse the assistant message id. The old turn's replay and
    // reconstruction must not bleed into the new continuation (the terminal cleanup waits 5 s).
    state.events = state.events.filter((entry) => entry.messageId !== event.messageId)
    state.reconstructionByMessage.set(event.messageId, {
      start: { ...event },
      events: []
    })
  }
  pushActiveStreamEvent(state, event)
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
  appendEndReconstructionEvent(state, event)
  pushActiveStreamEvent(state, event)
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

  // The ordinary replay buffer is capped. A long stream can evict its start, but a joining tab
  // still needs that envelope before any tail events (especially an approval-resume prefix).
  for (const [messageId, reconstruction] of state.reconstructionByMessage) {
    const start = reconstruction.start
    if (!start) continue
    const startStillBuffered = state.events.some(
      (event) => event.messageId === messageId && event.type === 'start'
    )
    if (!startStillBuffered) enqueueWithTelemetry(sessionId, controller, start)
  }

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
      state.reconstructionByMessage.delete(messageId)
      if (state.events.length === 0) {
        activeStreams.delete(sessionId)
        releaseWakeOwnedZipSettings(sessionId)
      }
    } else {
      releaseWakeOwnedZipSettings(sessionId)
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
