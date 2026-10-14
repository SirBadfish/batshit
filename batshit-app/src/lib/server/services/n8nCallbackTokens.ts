import { randomBytes, timingSafeEqual } from 'crypto'

import { redis } from '$lib/server/redis'

export const N8N_SSE_CALLBACK_TOKEN_HEADER = 'x-batshit-callback-token'
export const N8N_NATIVE_TOOL_CALLBACK_TOKEN_HEADER = 'x-batshit-native-tool-token'
export const N8N_SSE_CALLBACK_TOKEN_TTL_SECONDS = 30 * 60

type N8nSseCallbackTokenRecord = {
  token: string
  sessionId: string
  messageId: string
  userId: string
  agentId?: string
  subagentId?: string
  projectPath?: string
  createdAt: string
  expiresAt: string
}

type CreateN8nSseCallbackTokenInput = {
  sessionId: string
  messageId: string
  userId: string
  agentId?: string | null
  subagentId?: string | null
  projectPath?: string | null
}

function normalizeIdentifier(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeUserId(value: unknown): string {
  return normalizeIdentifier(value).toLowerCase()
}

function callbackTokenKey(sessionId: string, messageId: string): string {
  return `n8n:sse-callback:${sessionId}:${messageId}`
}

function safeTokenEquals(actual: string | null, expected: string | null): boolean {
  if (!actual || !expected) return false

  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  if (actualBuffer.length !== expectedBuffer.length) return false

  return timingSafeEqual(actualBuffer, expectedBuffer)
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function extractCallbackIdentity(data: unknown): {
  sessionId: string
  messageId: string
  userId: string
  agentId: string
  parentAgentId: string
  actorType: string
} {
  const body = readRecord(data)
  const context = readRecord(body.context)

  return {
    sessionId: normalizeIdentifier(
      body.sessionId ?? body.session_id ?? context.sessionId ?? context.session_id,
    ),
    messageId: normalizeIdentifier(
      body.messageId ?? body.message_id ?? context.messageId ?? context.message_id,
    ),
    userId: normalizeUserId(body.userId ?? body.user_id ?? context.userId ?? context.user_id),
    agentId: normalizeIdentifier(body.agentId ?? body.agent_id ?? context.agentId ?? context.agent_id),
    parentAgentId: normalizeIdentifier(
      body.parentAgentId ??
        body.parent_agent_id ??
        context.parentAgentId ??
        context.parent_agent_id,
    ),
    actorType: normalizeIdentifier(context.actorType ?? context.actor_type).toLowerCase(),
  }
}

function parseStoredRecord(value: unknown): N8nSseCallbackTokenRecord | null {
  if (!value) return null

  if (typeof value === 'string') {
    try {
      return parseStoredRecord(JSON.parse(value))
    } catch {
      return null
    }
  }

  if (typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<N8nSseCallbackTokenRecord>
  if (
    typeof record.token !== 'string' ||
    typeof record.sessionId !== 'string' ||
    typeof record.messageId !== 'string' ||
    typeof record.userId !== 'string' ||
    typeof record.expiresAt !== 'string'
  ) {
    return null
  }

  return record as N8nSseCallbackTokenRecord
}

export async function createN8nSseCallbackToken({
  sessionId,
  messageId,
  userId,
  agentId,
  subagentId,
  projectPath,
}: CreateN8nSseCallbackTokenInput): Promise<{
  token: string
  expiresAt: string
}> {
  const normalizedSessionId = normalizeIdentifier(sessionId)
  const normalizedMessageId = normalizeIdentifier(messageId)
  const normalizedUserId = normalizeIdentifier(userId)
  const normalizedAgentId = normalizeIdentifier(agentId)
  const normalizedSubagentId = normalizeIdentifier(subagentId)
  const normalizedProjectPath = normalizeIdentifier(projectPath)

  if (!normalizedSessionId) {
    throw new Error('Session ID is required to create an n8n callback token.')
  }
  if (!normalizedMessageId) {
    throw new Error('Message ID is required to create an n8n callback token.')
  }
  if (!normalizedUserId) {
    throw new Error('User ID is required to create an n8n callback token.')
  }
  if (normalizedSubagentId && !normalizedAgentId) {
    throw new Error('A Workflow Subagent callback token needs its parent agent ID.')
  }

  const createdAtDate = new Date()
  const expiresAtDate = new Date(
    createdAtDate.getTime() + N8N_SSE_CALLBACK_TOKEN_TTL_SECONDS * 1000,
  )
  const record: N8nSseCallbackTokenRecord = {
    token: randomBytes(32).toString('base64url'),
    sessionId: normalizedSessionId,
    messageId: normalizedMessageId,
    userId: normalizedUserId,
    ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
    ...(normalizedSubagentId ? { subagentId: normalizedSubagentId } : {}),
    ...(normalizedProjectPath ? { projectPath: normalizedProjectPath } : {}),
    createdAt: createdAtDate.toISOString(),
    expiresAt: expiresAtDate.toISOString(),
  }

  await redis.execute(async (client) => {
    await client.set(
      callbackTokenKey(normalizedSessionId, normalizedMessageId),
      JSON.stringify(record),
      { EX: N8N_SSE_CALLBACK_TOKEN_TTL_SECONDS },
    )
  })

  return {
    token: record.token,
    expiresAt: record.expiresAt,
  }
}

export async function isTrustedN8nSseCallbackRequest(
  request: Request,
  data: unknown,
): Promise<boolean> {
  return (await validateN8nScopedCallbackRequest(request, data)).valid
}

export async function validateN8nScopedCallbackRequest(
  request: Request,
  data: unknown,
  claimedUserId?: string | null,
): Promise<
  | {
      valid: true
      userId: string
      sessionId: string
      messageId: string
      projectPath: string | null
    }
  | { valid: false }
> {
  const { sessionId, messageId, userId, agentId, parentAgentId, actorType } =
    extractCallbackIdentity(data)
  const normalizedClaimedUserId = normalizeUserId(claimedUserId)
  const suppliedToken =
    request.headers.get(N8N_NATIVE_TOOL_CALLBACK_TOKEN_HEADER) ||
    request.headers.get(N8N_SSE_CALLBACK_TOKEN_HEADER)

  if (!sessionId || !messageId || !suppliedToken) {
    return { valid: false }
  }

  const stored = parseStoredRecord(
    await redis.get(callbackTokenKey(sessionId, messageId)),
  )
  if (!stored) return { valid: false }

  if (stored.sessionId !== sessionId || stored.messageId !== messageId) {
    return { valid: false }
  }

  const storedUserId = normalizeUserId(stored.userId)
  if (!storedUserId) {
    return { valid: false }
  }

  if (normalizedClaimedUserId && normalizedClaimedUserId !== storedUserId) {
    return { valid: false }
  }

  if (userId && userId !== storedUserId) {
    return { valid: false }
  }

  const storedAgentId = normalizeIdentifier(stored.agentId)
  const storedSubagentId = normalizeIdentifier(stored.subagentId)
  const isNativeDispatch = new URL(request.url).pathname.endsWith('/api/native-tools/dispatch')
  if (isNativeDispatch) {
    const context = readRecord(readRecord(data).context)
    // The dispatcher reads these snake-case fields. Aliases must never mask a forged value
    // on either a Workflow Subagent or a primary callback.
    const contextActorType = normalizeIdentifier(context.actor_type).toLowerCase()
    const contextAgentId = normalizeIdentifier(context.agent_id)
    const contextParentAgentId = normalizeIdentifier(context.parent_agent_id)
    if (
      normalizeIdentifier(context.session_id) !== stored.sessionId ||
      normalizeIdentifier(context.message_id) !== stored.messageId
    ) {
      return { valid: false }
    }
    if (contextActorType === 'subagent') {
      // A parent-only token minted before subagent binding cannot choose its own scope.
      if (!storedSubagentId || !storedAgentId || contextAgentId !== storedSubagentId ||
          contextParentAgentId !== storedAgentId) return { valid: false }
    } else if (contextActorType === 'primary') {
      if (storedSubagentId || !storedAgentId || contextAgentId !== storedAgentId) return { valid: false }
    } else {
      return { valid: false }
    }
  } else if (storedAgentId) {
    const effectiveAgentId =
      actorType === 'subagent' ? parentAgentId || agentId : agentId
    if (effectiveAgentId && effectiveAgentId !== storedAgentId) {
      return { valid: false }
    }
  }

  const expiresAtMs = Date.parse(stored.expiresAt)
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) {
    await redis.del(callbackTokenKey(sessionId, messageId)).catch(() => undefined)
    return { valid: false }
  }

  if (!safeTokenEquals(suppliedToken, stored.token)) {
    return { valid: false }
  }

  return {
    valid: true,
    userId: storedUserId,
    sessionId,
    messageId,
    projectPath: normalizeIdentifier(stored.projectPath) || null,
  }
}
