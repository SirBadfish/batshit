type StreamAbortEntry = {
  messageId: string
  controller: AbortController
  startedAt: number
  abortedAt?: number | null
}

type GroupAbortEntry = {
  controller: AbortController
  startedAt: number
  abortedAt?: number | null
}

type SessionTurnKind = 'single' | 'group'

type SessionTurnEntry = {
  kind: SessionTurnKind
  startedAt: number
  messageId?: string | null
}

type N8nPrimaryRunEntry = {
  userId: string
  sessionId: string
  messageId?: string | null
  agentId?: string | null
  startedAt: number
}

const activeStreams = new Map<string, StreamAbortEntry>()
const activeGroupTurns = new Map<string, GroupAbortEntry>()
const activeSessionTurns = new Map<string, SessionTurnEntry>()
const activeN8nPrimaryRuns = new Map<string, N8nPrimaryRunEntry>()
const N8N_PRIMARY_RUN_STALE_MS = 6 * 60 * 60 * 1000
const SESSION_TURN_STALE_MS = 6 * 60 * 60 * 1000
const ABORTED_TURN_RELEASE_MS = 5 * 1000
const ORPHANED_TURN_RELEASE_MS = 2 * 60 * 1000

function pruneStaleN8nPrimaryRuns(now = Date.now()) {
  for (const [userId, entry] of activeN8nPrimaryRuns.entries()) {
    if (now - entry.startedAt > N8N_PRIMARY_RUN_STALE_MS) {
      activeN8nPrimaryRuns.delete(userId)
    }
  }
}

function pruneStaleSessionTurns(now = Date.now()) {
  for (const [sessionId, stream] of activeStreams.entries()) {
    if (now - stream.startedAt > SESSION_TURN_STALE_MS) {
      activeStreams.delete(sessionId)
    }
  }

  for (const [sessionId, group] of activeGroupTurns.entries()) {
    if (now - group.startedAt > SESSION_TURN_STALE_MS) {
      activeGroupTurns.delete(sessionId)
    }
  }

  for (const [sessionId, turn] of activeSessionTurns.entries()) {
    if (now - turn.startedAt > SESSION_TURN_STALE_MS) {
      activeSessionTurns.delete(sessionId)
      continue
    }

    const activeStream = activeStreams.get(sessionId)
    const activeGroup = activeGroupTurns.get(sessionId)
    if (turn.kind === 'single' && activeStream) {
      if (
        typeof activeStream.abortedAt === 'number' &&
        now - activeStream.abortedAt > ABORTED_TURN_RELEASE_MS
      ) {
        activeStreams.delete(sessionId)
        activeSessionTurns.delete(sessionId)
      }
      continue
    }
    if (turn.kind === 'group' && activeGroup) {
      if (
        typeof activeGroup.abortedAt === 'number' &&
        now - activeGroup.abortedAt > ABORTED_TURN_RELEASE_MS
      ) {
        activeGroupTurns.delete(sessionId)
        activeSessionTurns.delete(sessionId)
      }
      continue
    }

    // If the abort controller is already gone, the turn lock is stale. Keeping
    // it blocks the next message while there is nothing left to interrupt. A
    // brand-new turn can exist briefly before its stream controller is created,
    // so only release older orphaned locks.
    if (now - turn.startedAt <= ORPHANED_TURN_RELEASE_MS) continue
    activeSessionTurns.delete(sessionId)
  }
}

export function registerStreamAbort(
  sessionId: string,
  messageId: string,
  controller: AbortController
) {
  activeStreams.set(sessionId, {
    messageId,
    controller,
    startedAt: Date.now(),
    abortedAt: null
  })
}

export function clearStreamAbort(sessionId: string, messageId?: string) {
  const entry = activeStreams.get(sessionId)
  if (!entry) return
  if (messageId && entry.messageId !== messageId) return
  activeStreams.delete(sessionId)
}

export function abortStream(sessionId: string, reason?: string) {
  pruneStaleSessionTurns()
  const entry = activeStreams.get(sessionId)
  if (!entry) {
    return { ok: false, messageId: null as string | null }
  }

  entry.abortedAt = Date.now()
  try {
    entry.controller.abort(reason ?? 'user')
  } catch {
    // Ignore abort errors (already aborted)
  }

  return { ok: true, messageId: entry.messageId }
}

export function getActiveStream(sessionId: string) {
  pruneStaleSessionTurns()
  return activeStreams.get(sessionId) ?? null
}

export function registerSessionTurn(
  sessionId: string,
  kind: SessionTurnKind,
  messageId?: string | null
) {
  pruneStaleSessionTurns()
  const existing = activeSessionTurns.get(sessionId)
  if (existing) {
    return {
      ok: false,
      existing
    } as const
  }

  const entry: SessionTurnEntry = {
    kind,
    startedAt: Date.now(),
    messageId: messageId ?? null
  }
  activeSessionTurns.set(sessionId, entry)
  return {
    ok: true,
    entry
  } as const
}

export function clearSessionTurn(sessionId: string, messageId?: string | null) {
  if (messageId) {
    const entry = activeSessionTurns.get(sessionId)
    if (entry?.messageId && entry.messageId !== messageId) return
  }
  activeSessionTurns.delete(sessionId)
}

export function getActiveSessionTurn(sessionId: string) {
  pruneStaleSessionTurns()
  return activeSessionTurns.get(sessionId) ?? null
}

export function registerN8nPrimaryRun(params: {
  userId: string
  sessionId: string
  messageId?: string | null
  agentId?: string | null
}) {
  pruneStaleN8nPrimaryRuns()
  const existing = activeN8nPrimaryRuns.get(params.userId)
  if (existing && existing.sessionId !== params.sessionId) {
    return {
      ok: false,
      existing
    } as const
  }

  const entry: N8nPrimaryRunEntry = {
    userId: params.userId,
    sessionId: params.sessionId,
    messageId: params.messageId ?? null,
    agentId: params.agentId ?? null,
    startedAt: Date.now()
  }
  activeN8nPrimaryRuns.set(params.userId, entry)
  return {
    ok: true,
    entry
  } as const
}

export function clearN8nPrimaryRun(userId: string, sessionId?: string | null) {
  const entry = activeN8nPrimaryRuns.get(userId)
  if (!entry) return
  if (sessionId && entry.sessionId !== sessionId) return
  activeN8nPrimaryRuns.delete(userId)
}

export function getActiveN8nPrimaryRun(userId: string) {
  pruneStaleN8nPrimaryRuns()
  return activeN8nPrimaryRuns.get(userId) ?? null
}

export function registerGroupAbort(sessionId: string, controller: AbortController) {
  activeGroupTurns.set(sessionId, {
    controller,
    startedAt: Date.now(),
    abortedAt: null
  })
}

export function clearGroupAbort(sessionId: string) {
  activeGroupTurns.delete(sessionId)
}

export function abortGroupChat(sessionId: string, reason?: string) {
  pruneStaleSessionTurns()
  const entry = activeGroupTurns.get(sessionId)
  if (!entry) {
    return { ok: false }
  }

  entry.abortedAt = Date.now()
  try {
    entry.controller.abort(reason ?? 'user')
  } catch {
    // Ignore abort errors (already aborted)
  }

  return { ok: true }
}

export function getActiveGroupAbort(sessionId: string) {
  pruneStaleSessionTurns()
  return activeGroupTurns.get(sessionId) ?? null
}
