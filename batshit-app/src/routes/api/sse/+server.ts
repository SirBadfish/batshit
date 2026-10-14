import { error, json } from '@sveltejs/kit'
import { logger } from '$lib/utils/logger'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { redisStreamService } from '$lib/server/redisStreamService'
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
import {
  canonicalizePrimaryAgentRecord,
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
  extractZipIdFromReference,
  neutralizeAllClipReferenceSyntax,
  neutralizeUntrustedZipReferenceSyntax
} from '$lib/utils/zipReferenceSafety'
import { registerRuntimeShutdownTask } from '$lib/server/services/runtimeShutdown'
import {
  closeSseExternalSubscriber,
  ensureSseExternalSubscriber,
  registerSseExternalSinks
} from '$lib/server/sseExternalSubscriber'
import {
  buildClaudeApprovalReplayEvents,
  isClaudeApprovalEvent
} from '$lib/server/services/claudeApprovalEvents'
import {
  forgetClaudeApprovals,
  listClaudeApprovalsForSession
} from '$lib/server/services/claudeApprovalRegistry'
import {
  clearAllReplyRecords,
  hasReplyRecord,
  isLateReplyEvent,
  listReplayEvents,
  setChatForgetHook,
  recordReplayOnlyEvent,
  recordReplyEvent,
  replyZipDetection,
  scheduleReplyRecordCleanup,
  stampReplyEventId,
  startReplyRecord,
  retractReplySegment
} from '$lib/server/services/replyStreamRecord'
import { getWakeRun, hasActiveWakeRun } from '$lib/server/services/wakeRunRegistry'
import {
  getActiveSessionTurn,
  getActiveStream,
  hasRunningRequest,
  keepAllQueuedSessionTurns,
  listWaitingQueuedSends,
  getQueueCardHold
} from '$lib/server/services/streamAbortRegistry'
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

// Active SSE connections (can have multiple listeners per session)
const connections = new Map<string, Set<SSEController>>()
/**
 * SA-113 P1 (DL-113-06) — the user-scoped channel, kept in its own map on purpose.
 * A user connection is not a session connection: it has no zip buffers, no stream adapter,
 * and no replay buffer, so sharing `connections` would run session-shaped teardown against
 * a user id.
 */
const userConnections = new Map<string, Set<SSEController>>()
const sessionAdapters = new Map<string, StreamEventAdapter>()
const sessionSubagentCache = new Map<string, any[]>()
let sseRuntimeShutdownPromise: Promise<void> | null = null

export function _closeSseRuntimeResources(reason = 'shutdown'): Promise<void> {
  sseRuntimeShutdownPromise ??= (async () => {
    // BL-4: a send waiting in a chat's line will not run now. Every one is kept, BEFORE the wait
    // below: when the turn it waits for ends, it moves its saved message to the end of the chat,
    // unanswered, and its tab hears why (`queuedSendKeeper.ts`). Its tabs are told at once,
    // while the hubs are still open.
    for (const { sessionId, userMessageIds } of keepAllQueuedSessionTurns('shutdown')) {
      forwardExternalEvent(sessionId, {
        type: 'queued_send_dropped',
        sessionId,
        userMessageIds,
        reason: 'shutdown'
      })
    }
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

    // BL-775: every running turn has ended (the wait above), so the recorded reply events go.
    clearAllReplyRecords()
    sessionAdapters.clear()
    sessionSubagentCache.clear()
    sessionZipSettings.clear()
    agentSettingsCache.clear()

    await closeSseExternalSubscriber()
    await Promise.all(visualCleanups)
    logger.debug(`[SSE] Runtime resources closed for ${reason}`)
  })()
  return sseRuntimeShutdownPromise
}

registerRuntimeShutdownTask('sse', _closeSseRuntimeResources)

// The server's Redis subscriber (`sseExternalSubscriber.ts`) forwards the chat and user channels
// to this route's listeners. It may have started before this module loaded (a managed Claude
// run waits for it before launch, BL-496); events published before now reached no tab anyway.
registerSseExternalSinks({ session: forwardExternalEvent, user: forwardUserEvent })

function forwardExternalEvent(sessionId: string, payload: any) {
  // BL-496 (A2): a Claude approval card is part of its reply's replay, watched or not, in the
  // order it came. Replay only: its events must not enter the end rebuild, which never held
  // them (the card lives in the reply's `metadata.toolApprovals`, not in its text).
  // Only for a reply still on record or a chat with a running request: a late event after the
  // reply's end and cleanup must not create replay state nobody clears.
  if (
    isClaudeApprovalEvent(payload) &&
    typeof payload.messageId === 'string' &&
    payload.messageId &&
    (hasReplyRecord(sessionId, payload.messageId) || hasRunningRequest(sessionId))
  ) {
    recordReplayOnlyEvent(sessionId, payload)
  }
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

// The stream path's zip detector is the reply record's (BL-775): the finalize's rebuild takes
// its unclosed words and stream-made references from the same instance.
const zipDetection = replyZipDetection
const agentSettingsCache = new Map<string, any>()
const sessionZipSettings = new Map<string, Record<string, any> | undefined>()

/**
 * SA-113 F-P1-2, BL-775 — sessions whose zip settings were loaded for a run nobody watches
 * (a woken turn, or any reply whose tab closed or never opened) rather than by a tab connecting.
 *
 * `sessionZipSettings` is normally filled when a tab subscribes to the chat
 * (`attachSessionListener`) and dropped when its last listener goes. Since BL-775 every event of
 * a chat with a running request goes through the stream path, watched or not, so without this
 * the user's own thresholds would be ignored for exactly the turns they never see happen.
 * Tracking which entries an unwatched run owns is
 * what lets them be dropped again without touching an entry a real tab owns.
 */
const unwatchedRunZipSettings = new Set<string>()

async function ensureZipSettingsForUnwatchedRun(sessionId: string, userId: string) {
  if (sessionZipSettings.has(sessionId)) return
  let globalZipSettings: Record<string, any> | undefined = undefined
  try {
    const userSettings = await redis.getUserSettings(userId)
    globalZipSettings = userSettings?.global_zip_settings || undefined
  } catch (err) {
    console.error('[SSE] Failed to load zip settings for an unwatched run:', err)
  }
  sessionZipSettings.set(sessionId, globalZipSettings)
  unwatchedRunZipSettings.add(sessionId)
}

function releaseUnwatchedRunZipSettings(sessionId: string) {
  if (!unwatchedRunZipSettings.delete(sessionId)) return
  // A tab that connected meanwhile now owns the entry and its disconnect drops it.
  const sessionControllers = connections.get(sessionId)
  if (sessionControllers && sessionControllers.size > 0) return
  sessionZipSettings.delete(sessionId)
}

/**
 * BL-775: an unwatched run fills this chat's stream adapter and caches too (every running reply is
 * recorded, tab or not). When nothing of the chat is recorded any more and no tab listens, they
 * go with its zip settings; a tab that listens owns them, and its disconnect drops them.
 */
function releaseUnwatchedChatState(sessionId: string) {
  releaseUnwatchedRunZipSettings(sessionId)
  const sessionControllers = connections.get(sessionId)
  if (sessionControllers && sessionControllers.size > 0) return
  resetStreamAdapter(sessionId)
  agentSettingsCache.delete(sessionId)
  sessionSubagentCache.delete(sessionId)
}

/** Tests: which per-chat state this route still holds for a chat. */
export function _chatStateForTests(sessionId: string) {
  return {
    adapter: sessionAdapters.has(sessionId),
    agentSettings: agentSettingsCache.has(sessionId),
    subagents: sessionSubagentCache.has(sessionId),
    zipSettings: sessionZipSettings.has(sessionId)
  }
}

/** A deleted chat's adapter, caches, and unwatched zip settings go with its records. */
setChatForgetHook('api/sse', (sessionId) => {
  releaseUnwatchedRunZipSettings(sessionId)
  resetStreamAdapter(sessionId)
  agentSettingsCache.delete(sessionId)
  sessionSubagentCache.delete(sessionId)
})

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
  unwatchedRunZipSettings.delete(sessionId)

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
  // BL-496 (A2): and a Claude approval card the buffer does not hold (it came before its
  // reply's start, or the cap evicted it), from the server's record of it.
  replayClaudeApprovalCardsForListener(sessionId, controllerRef)
  // BL-4: and the sends waiting in the chat's line, from the line itself.
  await replayQueuedSendsForListener(sessionId, controllerRef)

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
      agentSettingsCache.delete(sessionId)
      sessionSubagentCache.delete(sessionId)
      if (hasRunningRequest(sessionId)) {
        // BL-775 (B2): the reply goes on without a tab, through the same stream path. Its zip
        // detector state (an `<error>` block still open, held words), its temp zip chunks, its
        // stream adapter, and the user's zip settings stay; each message's state goes at its own
        // terminal event, and the settings when the chat's record empties.
        if (sessionZipSettings.has(sessionId)) unwatchedRunZipSettings.add(sessionId)
        return
      }
      zipDetection.deleteSessionBuffers(sessionId)
      sessionZipSettings.delete(sessionId)
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

  await ensureSseExternalSubscriber()

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
 * A chunk the zip detector handed back, neutralized and sent like every text chunk. `segmentId`
 * (BL-759) names the managed lane's segment it came from and is recorded with it, so a retract of
 * that segment finds it; held words handed back before a tool card have none.
 */
async function emitDetectedChunk(
  sessionId: string,
  messageId: string,
  adapter: ReturnType<typeof getStreamAdapter>,
  controller: ReadableStreamDefaultController,
  content: string,
  segmentId: string | null = null
) {
  const knownStreamingZipIds = zipDetection
    .getMessageReferences(sessionId, messageId)
    .map((ref) => extractZipIdFromReference(ref.reference))
    .filter((id): id is string => Boolean(id))
  const safeProcessedContent = neutralizeAllClipReferenceSyntax(
    neutralizeUntrustedZipReferenceSyntax(
      content,
      {
        trustedZipIds: knownStreamingZipIds,
      }
    )
  )
  const chunkEvent = await adapter.emitChunk({
    content: safeProcessedContent,
    segmentId
  })
  enqueueWithTelemetry(sessionId, controller as SSEController, chunkEvent)
  recordReplyEvent(sessionId, {
    ...chunkEvent
  })
}

/**
 * BL-489: the words of an `<error>` block that never closed go out as an ordinary chunk where
 * they were written: before a tool card, and when the reply ends. The detector holds them only
 * while the pair may still close, so a block never spans a tool card and a reply keeps its words.
 */
async function emitUnclosedZipText(
  sessionId: string,
  messageId: string,
  adapter: ReturnType<typeof getStreamAdapter>,
  controller: ReadableStreamDefaultController,
  options?: { endOfReply?: boolean }
) {
  const text = zipDetection.takeUnclosedText(sessionId, messageId, options)
  if (text) {
    await emitDetectedChunk(sessionId, messageId, adapter, controller, text)
  }
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
): Promise<{ refused: string } | void> {
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
      startReplyRecord(sessionId, startEvent)
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

      // BL-775: checked again right before the zip detection, because the awaits above can let the
      // finalize close the reply after this forward passed the POST's arrival check. A close that
      // lands INSIDE one `processChunk` call is a known, narrow race (the detector can still make
      // one zip no saved reply names); the record write refuses the chunk either way.
      if (isLateReplyEvent(sessionId, { type: 'chunk', messageId })) {
        console.warn('[SSE] BL-775: refused a late chunk of a reply already saved, before its zip detection', {
          sessionId,
          messageId
        })
        break
      }

      // Check for zip patterns and handle streaming to temporary storage. BL-759: the chunk's
      // segment goes along, so what the detector hands back and holds is that segment's.
      const segmentId = typeof data.segmentId === 'string' && data.segmentId ? data.segmentId : null
      const processed = await zipDetection.processChunk(sessionId, messageId, content, segmentId)

      if (processed.shouldStream) {
        await emitDetectedChunk(sessionId, messageId, adapter, controller, processed.content, segmentId)
      }
      break
    }

    case 'text_retract': {
      // BL-759: a managed lane took back a segment of this reply (a Codex message that dropped
      // and was started again). `retractReplySegment` takes its chunks out of the record and the
      // replay, rewinds the zip detector, and removes a zip made from its words. Every tab then
      // gets the reply's text as it now reads, and so does a tab that joins later (the replay).
      // The retract itself is not recorded or sent to a tab: it has no words of its own.
      const segmentId = typeof data.segmentId === 'string' ? data.segmentId : ''
      const retracted = await retractReplySegment(sessionId, messageId, segmentId)
      if (!retracted) {
        // No record to take it from (or the reply is already saved): the reply's record never
        // held it, so send-routed must not trust the record (a gap; its own copy is right).
        logger.warn('[SSE] BL-759: a retract found no reply record to take back from', {
          sessionId,
          messageId,
          segmentId
        })
        return { refused: 'no_reply_record' }
      }
      if (retracted.detector === 'superseded') {
        // Words were read after the segment: it cannot be taken back exactly, and nothing was
        // changed. Answered without success, so send-routed saves its own copy, already taken
        // back by segment, with the notice (never silently).
        console.error('[SSE] BL-759: a retracted segment could not be taken back exactly; the reply is a gap', {
          sessionId,
          messageId,
          segmentId
        })
        return { refused: 'superseded' }
      }
      if (retracted.removedText || retracted.detector === 'rewound') {
        const metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : {}
        const resetEvent = await adapter.emitContentReset({
          content: retracted.content,
          metadata: {
            reason: typeof metadata.reason === 'string' ? metadata.reason : 'retry',
            message: typeof metadata.message === 'string' ? metadata.message : null,
            program: typeof metadata.program === 'string' ? metadata.program : null,
            segmentId,
            // The words taken back, so Voice Mode drops exactly those of what it has not spoken.
            removedText: retracted.removedText
          }
        })
        // Recorded first, so the tab's copy and a joining tab's copy carry the same event id.
        recordReplayOnlyEvent(sessionId, resetEvent)
        enqueueWithTelemetry(sessionId, controller as SSEController, resetEvent)
      }
      break
    }

    case 'tool_start': {
      await emitUnclosedZipText(sessionId, messageId, adapter, controller)
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
      recordReplyEvent(sessionId, toolStartEvent)
      break
    }

    case 'tool-call': {
      await emitUnclosedZipText(sessionId, messageId, adapter, controller)
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
      recordReplyEvent(sessionId, toolCallEvent)
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
      recordReplyEvent(sessionId, approvalEvent)
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
      recordReplyEvent(sessionId, toolResultEvent)
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
        recordReplyEvent(sessionId, thinkingEvent)
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
        recordReplyEvent(sessionId, planEvent)
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
      recordReplyEvent(sessionId, toolEndEvent)
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
      recordReplyEvent(sessionId, objectEvent)
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
      // BL-4: a send waiting in the chat's line is replayed from the line itself
      // (`replayQueuedSendsForListener`), never from this buffer: the reply it waits for may not
      // have begun, and that reply's `start` clears what the buffer held for it, and a buffered
      // bubble could outlive its send.
      if (!(eventType === 'steer_queued' && (steerEvent as { queuedSend?: unknown }).queuedSend)) {
        recordReplyEvent(sessionId, steerEvent)
      }
      break
    }

    /**
     * BL-4 — chat facts, not parts of a reply: a user message landing in the chat (the page's own
     * broadcast, a queued send's message moving to the end) and queued sends that will not be
     * sent. Forwarded to every tab now and never buffered, so a tab that joins later reads them
     * from the chat and the line instead of replaying them.
     */
    case 'user_message':
    case 'queued_send_dropped':
    // BL-713: the chat's line starts or stops holding for an approval card.
    case 'queued_send_hold': {
      enqueueWithTelemetry(sessionId, controller as SSEController, {
        type: eventType,
        sessionId,
        ...data,
        ...eventData
      })
      break
    }

    case 'finish': {
      const usage = data.usage || eventData.usage
      const finishEvent = await adapter.emitFinish({
        usage
      })
      enqueueWithTelemetry(sessionId, controller as SSEController, finishEvent)
      recordReplyEvent(sessionId, finishEvent)
      break
    }

    case 'end': {
      // BL-775: the server owns the reply's saved record. send-routed's finalize rebuilt the
      // reply from this chat's recorded events (`replyStreamRecord.ts`: the words of an `<error>`
      // block that never closed, the stream-made zips, the page's old edits), SAVED it, and only
      // then forwards `end` with the saved bytes (`savedRecord: true`). So `end` is handed to
      // every tab as it is: what a tab shows, what is stored, and what the agent reads next are
      // the same bytes. Nothing is rebuilt here, and no tab saves it back.
      if (data.savedRecord !== true) {
        console.error('[SSE] An end event arrived that no finalize saved; forwarded as it came', {
          sessionId,
          messageId
        })
      }
      const endEvent = await adapter.emitEnd({
        content: typeof data.content === 'string' ? data.content : '',
        intermediateSteps: Array.isArray(data.intermediateSteps) ? data.intermediateSteps : [],
        zipReferences: Array.isArray(data.zipReferences) ? data.zipReferences : [],
        metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : {},
        savedRecord: data.savedRecord === true
      })

      enqueueWithTelemetry(sessionId, controller as SSEController, endEvent)
      recordReplyEvent(sessionId, endEvent)
      // Some upstreams never send a "complete" event; ensure the active stream
      // is cleared after the end payload to avoid replaying stale chunks on refresh.
      scheduleActiveStreamCleanup(sessionId, messageId)
      break
    }

    case 'complete': {
      await emitUnclosedZipText(sessionId, messageId, adapter, controller, { endOfReply: true })
      const completeEvent = await adapter.emitComplete({
        metadata: data.metadata || eventData.metadata || {}
      })
      enqueueWithTelemetry(sessionId, controller as SSEController, completeEvent)
      recordReplyEvent(sessionId, completeEvent)
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
      await emitUnclosedZipText(sessionId, messageId, adapter, controller, { endOfReply: true })
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
      recordReplyEvent(sessionId, errorEvent)
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
      recordReplyEvent(sessionId, forwardedEvent)
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

  const isInternalForward = isTrustedInternalRequest(request)
  const isTrustedCallback =
    isInternalForward ||
    (await isTrustedN8nSseCallbackRequest(request, data))

  let sessionOwnerId: string | null = null
  if (isTrustedCallback) {
    const session = await redis.getSession(sessionId)
    if (!session) {
      throw error(404, 'Session not found')
    }
    sessionOwnerId = typeof session.user_id === 'string' ? session.user_id : null
  } else {
    if (!locals.user?.id) {
      throw error(401, 'Unauthorized')
    }

    const sessionCheck = await requireOwnedSession(sessionId, locals.user.id)
    if (!sessionCheck.ok) return sessionCheck.response
  }

  // BL-775: a content or tool event of a reply whose finalize already rebuilt it is late (a slow
  // forward that answered after the finalize's wait). It is refused before the zip detection, so
  // it cannot close an `<error>` block into a zip no saved reply names, nor bring back a record
  // the cleanup removed.
  if (isInternalForward && isLateReplyEvent(sessionId, data)) {
    console.warn('[SSE] BL-775: refused a late event of a reply already saved', {
      sessionId,
      messageId: data.messageId,
      type: data.type
    })
    return new Response(JSON.stringify({ success: false, message: 'The reply was already saved' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
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
  //
  // BL-775: and so is EVERY reply whose request is running. The server owns a reply's saved
  // record, and its finalize saves the rebuild of the events recorded here, so a reply whose
  // tab closed, never opened, or lost its connection must be recorded whole. A trusted internal
  // forward (send-routed's) for a chat with a running request is recorded, listener or not, and
  // answers `success: true`; send-routed counts any other answer as a gap in the record. This
  // also folds in BL-496's recording of an unwatched run's start.
  const bufferForWakeRun = !hasListeners && hasActiveWakeRun(sessionId)
  const recordUnwatchedRun = !hasListeners && isInternalForward && hasRunningRequest(sessionId)

  if (!hasListeners && !bufferForWakeRun && !recordUnwatchedRun) {
    // Nothing runs and nobody is watching: give back any zip settings an unwatched run
    // loaded, in case the run ended without a terminal event (F-P1-2).
    releaseUnwatchedRunZipSettings(sessionId)
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

  // F-P1-2 — a run nobody watches must zip by the user's own thresholds. Nothing has loaded
  // them, because loading happens when a tab connects; the wake registry, or the chat's owner,
  // says whose run this is.
  if (bufferForWakeRun) {
    const wakeRun = getWakeRun(sessionId)
    if (wakeRun) await ensureZipSettingsForUnwatchedRun(sessionId, wakeRun.userId)
  } else if (recordUnwatchedRun && sessionOwnerId) {
    await ensureZipSettingsForUnwatchedRun(sessionId, sessionOwnerId)
  }

  // Process as a regular n8n-style event through the NDJSON handler.
  const globalZipSettings = sessionZipSettings.get(sessionId)
  const { controller: collector, events } = createCollectingController(sessionId)
  const outcome = await processNDJSONLine(sessionId, data, collector, { globalZipSettings })

  for (const event of events) {
    for (const controller of sessionControllers ?? []) {
      enqueueWithTelemetry(sessionId, controller, event)
    }
  }

  // BL-759: an event the route could not apply (a retract it could not take back exactly, or with
  // no record) is answered without success; send-routed counts that as a gap in the record.
  if (outcome?.refused) {
    return new Response(JSON.stringify({ success: false, message: outcome.refused }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

/**
 * BL-4 — a tab that joins a chat (opened, or reloaded) while sends wait in its line gets their
 * "Queued" bubbles, from the line itself, filed under the reply they wait for: the same event
 * each tab got when the send joined the line. A kept send (Stop, shutdown, the cap) will not
 * run, so it gets none; its words show at the end of the chat once they are moved there.
 */
async function replayQueuedSendsForListener(sessionId: string, controller: SSEController) {
  const waiting = listWaitingQueuedSends(sessionId)
  if (waiting.length === 0) return
  const runningReplyId =
    getActiveStream(sessionId)?.messageId ?? getActiveSessionTurn(sessionId)?.messageId ?? null
  // BL-713: the line holds for the user's answer to an approval card (no turn runs), so the
  // joining tab draws the bubble as waiting for that card, with Send now.
  const cardHold = getActiveSessionTurn(sessionId) ? null : getQueueCardHold(sessionId)
  for (const queued of waiting) {
    let text = ''
    try {
      const saved = (await redis.execute((client) =>
        client.json.get(`message:${sessionId}:${queued.userMessageId}`)
      )) as { content?: unknown } | null
      text = typeof saved?.content === 'string' ? saved.content : ''
    } catch (error) {
      logger.warn('[SSE] Could not read a waiting send for a joining tab', {
        sessionId,
        userMessageId: queued.userMessageId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    enqueueWithTelemetry(sessionId, controller, {
      type: 'steer_queued',
      sessionId,
      ...(runningReplyId ? { messageId: runningReplyId } : {}),
      steerId: queued.userMessageId,
      text,
      at: new Date(queued.queuedAt).toISOString(),
      deliver: 'end',
      queuedSend: {
        userMessageId: queued.userMessageId,
        assistantMessageId: queued.assistantMessageId
      },
      ...(cardHold ? { heldForApprovalCard: { messageId: cardHold.messageId } } : {})
    })
  }
}

function replayActiveStreamForListener(sessionId: string, controller: SSEController) {
  // The recorded replay (`replyStreamRecord.ts`): each start the capped buffer evicted first (a
  // joining tab needs the owner of the tail, an approval resume's prefix included), then the buffer.
  const replay = listReplayEvents(sessionId)
  if (replay.length === 0) return
  logger.debug('[SSE] Replaying active stream for new listener', { sessionId, eventCount: replay.length })
  for (const event of replay) {
    enqueueWithTelemetry(sessionId, controller, event)
  }
}

/**
 * BL-496 (A2): a Claude approval card the replay does not hold (it came before its reply's start,
 * or the cap evicted it), from the server's record of it.
 */
function replayClaudeApprovalCardsForListener(sessionId: string, controller: SSEController) {
  const buffered = new Set(
    listReplayEvents(sessionId)
      .filter((event) => event.type === 'tool-call' && isClaudeApprovalEvent(event))
      .map((event) => event.toolCallId)
  )
  for (const record of listClaudeApprovalsForSession(sessionId)) {
    // A card whose run ended is in that reply's `end` and its saved record.
    if (record.runEndedAt !== null || buffered.has(record.approvalId)) continue
    for (const event of buildClaudeApprovalReplayEvents(record)) {
      enqueueWithTelemetry(sessionId, controller, event)
    }
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
      stampReplyEventId(sessionId, payload as StreamEventPayload)
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

/**
 * A message reached its terminal event: its recorded events go 5 s later (a tab that joins in
 * that window still gets the finished reply). Then its Claude cards' record (BL-496: its `end`
 * carried them and the finalize saved them), and, when the chat has nothing left recorded, the
 * zip settings an unwatched run loaded.
 */
function scheduleActiveStreamCleanup(sessionId: string, messageId?: string) {
  scheduleReplyRecordCleanup(sessionId, messageId, {
    onMessageCleared: () => {
      if (messageId) forgetClaudeApprovals(sessionId, messageId)
    },
    onChatEmpty: () => releaseUnwatchedChatState(sessionId)
  })
}
