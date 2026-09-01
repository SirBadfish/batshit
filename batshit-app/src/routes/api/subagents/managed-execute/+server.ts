import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import type { AgentRow, SubagentRow } from '$lib/types/database'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import {
  canonicalizeSubagentRecord,
  isSubagentCompatibleWithPrimaryAgent,
  normalizeSubagentType,
  type SubagentType,
} from '$lib/utils/subagentType'
import { isTrustedInternalRequest } from '$lib/server/services/internalRequestAuth'
import { executeManagedSubagent } from '$lib/server/services/subagentRunner'

const DEFAULT_TIMEOUT_MS = 120000
const MAX_TIMEOUT_MS = 10 * 60 * 1000

type ManagedExecuteBody = {
  agentId?: unknown
  subagentId?: unknown
  sessionId?: unknown
  chatInput?: unknown
  projectPath?: unknown
  timeoutMs?: unknown
  /** Optional parent send message id (SA-093 forensics correlation). */
  messageId?: unknown
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function jsonError(status: number, code: string, message: string) {
  return json({ success: false, error: { code, message } }, { status })
}

function getAssignedSubagentIds(agent: AgentRow & Record<string, unknown>): string[] {
  return Array.from(
    new Set(
      [
        ...(Array.isArray(agent.assignedSubagents) ? agent.assignedSubagents : []),
        ...(Array.isArray(agent.assigned_subagent_ids) ? agent.assigned_subagent_ids : []),
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    )
  )
}

async function isAssigned(agentId: string, subagentId: string, agent: AgentRow) {
  const ids = getAssignedSubagentIds(agent as AgentRow & Record<string, unknown>)
  if (ids.includes(subagentId)) return true

  try {
    const setIds = await redis.sMembers(`agent:${agentId}:subagents`)
    return setIds.includes(subagentId)
  } catch {
    return false
  }
}

function normalizeTimeoutMs(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.floor(parsed), MAX_TIMEOUT_MS)
}

function toolSourceFor(subagentType: SubagentType) {
  if (subagentType === 'cli') return 'managed-cli-subagent'
  if (subagentType === 'api') return 'managed-api-subagent'
  if (subagentType === 'n8n-workflow') return 'workflow-webhook'
  return 'subagent'
}

function statusForExecutionError(message: string) {
  const lower = message.toLowerCase()
  if (lower.includes('timed out') || lower.includes('aborted')) return 504
  if (lower.includes('needs a model') || lower.includes('needs a real')) return 400
  if (lower.includes('production webhook url')) return 400
  if (lower.includes('must point to either codex cli or claude cli')) return 400
  return 500
}

async function executeWithTimeout<T>(
  work: (abortSignal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new Error(`Managed subagent execution timed out after ${timeoutMs}ms.`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export const POST: RequestHandler = async ({ request }) => {
  if (!isTrustedInternalRequest(request)) {
    return jsonError(401, 'unauthorized', 'Managed subagent execution requires trusted Batshit internal auth.')
  }

  const userId = readString(request.headers.get('x-batshit-user-id'))
  if (!userId) {
    return jsonError(400, 'missing_user', 'Managed subagent execution requires x-batshit-user-id.')
  }

  let body: ManagedExecuteBody
  try {
    body = await request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body must be valid JSON.')
  }

  const agentId = readString(body.agentId)
  const subagentId = readString(body.subagentId)
  const sessionId = readString(body.sessionId)
  const chatInput = typeof body.chatInput === 'string' ? body.chatInput : ''
  const projectPath = readString(body.projectPath) || null
  const parentMessageId = readString(body.messageId) || null
  const timeoutMs = normalizeTimeoutMs(body.timeoutMs)

  if (!agentId || !subagentId || !sessionId || typeof body.chatInput !== 'string') {
    return jsonError(
      400,
      'missing_fields',
      'Managed subagent execution requires agentId, subagentId, sessionId, and chatInput.'
    )
  }

  const session = await redis.getSession(sessionId)
  if (!session) {
    return jsonError(404, 'session_not_found', 'Parent chat session was not found.')
  }
  if (session.user_id !== userId) {
    return jsonError(403, 'session_user_mismatch', 'Parent chat session is not owned by the bridge user.')
  }

  const agent = (await redis.get(`agent:${agentId}`)) as AgentRow | null
  if (!agent) {
    return jsonError(404, 'agent_not_found', 'Primary agent was not found.')
  }
  if (agent.user_id !== userId) {
    return jsonError(403, 'agent_user_mismatch', 'Primary agent is not owned by the bridge user.')
  }

  const primaryAgentType = normalizePrimaryAgentType(agent)
  if (primaryAgentType !== 'cli') {
    return jsonError(400, 'invalid_primary_type', 'Only CLI Primary Agents can use this managed bridge route.')
  }

  if (!(await isAssigned(agentId, subagentId, agent))) {
    return jsonError(403, 'subagent_not_assigned', 'Requested subagent is not assigned to this Primary Agent.')
  }

  const subagentRaw = await redis.get(`subagent:${subagentId}`)
  if (!subagentRaw) {
    return jsonError(404, 'subagent_not_found', 'Requested subagent was not found.')
  }

  const subagent = canonicalizeSubagentRecord(
    subagentRaw as Record<string, any>
  ) as SubagentRow
  if (subagent.user_id !== userId) {
    return jsonError(403, 'subagent_user_mismatch', 'Requested subagent is not owned by the bridge user.')
  }

  const subagentType = normalizeSubagentType(subagent)
  if (subagentType !== 'api' && subagentType !== 'cli' && subagentType !== 'n8n-workflow') {
    return jsonError(
      400,
      'invalid_subagent_type',
      'This route only executes API, CLI, and n8n Workflow Subagents. n8n Subnode Subagents were removed.'
    )
  }

  if (!isSubagentCompatibleWithPrimaryAgent(primaryAgentType, subagent)) {
    return jsonError(400, 'incompatible_subagent', 'Requested subagent is not compatible with CLI Primary Agents.')
  }

  try {
    const result = await executeWithTimeout(
      (abortSignal) =>
        executeManagedSubagent({
          userId,
          sessionId,
          chatInput,
          subagent,
          parentAgentId: agentId,
          parentMessageId,
          projectPath,
          abortSignal,
        }),
      timeoutMs
    )

    return json({
      success: true,
      output: result.output,
      intermediateSteps: result.intermediateSteps,
      subagentType: result.subagentType,
      subagentId,
      subagentName: subagent.displayName || subagent.id,
      toolSource: toolSourceFor(result.subagentType),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = statusForExecutionError(message)
    return jsonError(
      status,
      status === 504 ? 'managed_subagent_timeout' : 'managed_subagent_failed',
      message
    )
  }
}
