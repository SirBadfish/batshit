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
import {
  isSubagentBusyError,
  normalizeSubagentThreadMode,
} from '$lib/server/services/subagentThreads'
import { spawnWorkers } from '$lib/server/services/workerRunner'
import { resolveWorkersEnabled } from '$lib/utils/delegationCapabilities'
import { resolveCliSubagentRuntime } from '$lib/server/services/cliSubagentModelResolution'

type ManagedExecuteBody = {
  agentId?: unknown
  subagentId?: unknown
  sessionId?: unknown
  chatInput?: unknown
  projectPath?: unknown
  /** SA-111 P2 (DL-111-04): `'fresh'` (default) or `'resume'`. */
  thread?: unknown
  /** Optional parent send message id (SA-093 forensics correlation). */
  messageId?: unknown
  /**
   * SA-111 P4 (DL-111-09) — worker mode. When present, this is a `spawn_workers` batch
   * from the CLI bridge rather than a subagent call: no `subagentId`, no thread, and the
   * caps/validation live in `workerRunner`.
   */
  workers?: unknown
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** `null` (not `[]`) when the field is absent: `[]` means "none selected", not "unset". */
function normalizeIdList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
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
  const thread = normalizeSubagentThreadMode(body.thread)
  // SA-111 P4: one route, two modes. Worker mode is chosen by the presence of `workers`,
  // never by a caller-supplied discriminator, so a malformed subagent call can never be
  // reinterpreted as a worker batch.
  const isWorkerMode = Array.isArray(body.workers)

  if (!agentId || !sessionId) {
    return jsonError(400, 'missing_fields', 'Managed execution requires agentId and sessionId.')
  }

  if (!isWorkerMode && (!subagentId || typeof body.chatInput !== 'string')) {
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

  if (isWorkerMode) {
    // DL-111-11: the per-agent setting is the gate, checked server-side. A bridge listing
    // built before the toggle changed must never be able to run a worker.
    if (!resolveWorkersEnabled(agent)) {
      return json({
        kind: 'workers',
        success: false,
        error: 'workers_disabled',
        message: 'Workers are turned off for this Primary Agent in Batshit Agent Settings.',
        workers: [],
      })
    }

    const agentRecord = agent as AgentRow & Record<string, any>
    // DL-111-10: a built-in CLI worker follows the parent's runtime family, so it needs the
    // same model fields a CLI Subagent resolves its Codex/Claude lane from.
    const cliModelFields = {
      primary_model_provider: agentRecord.primary_model_provider ?? undefined,
      primary_model_name: agentRecord.primary_model_name ?? undefined,
      model: agentRecord.model ?? undefined,
      codex_settings: agentRecord.codex_settings ?? undefined,
      claude_settings: agentRecord.claude_settings ?? undefined,
    }
    if (!resolveCliSubagentRuntime(cliModelFields)) {
      return json({
        kind: 'workers',
        success: false,
        error: 'invalid_context',
        message:
          'This CLI Primary Agent has no resolvable Codex or Claude model, so a worker cannot inherit its runtime.',
        workers: [],
      })
    }

    const result = await spawnWorkers({
      parent: {
        userId,
        sessionId,
        parentAgentId: agentId,
        parentMessageId,
        projectPath,
        lane: 'cli',
        cliModelFields,
        providerSettings: agentRecord.provider_specific_settings ?? null,
        // The parent's scope as this lane knows it: a CLI primary's own runtime profile is
        // built from these same stored defaults, so a worker inherits exactly what its
        // parent has rather than the wider user-global set.
        selectedGateways: normalizeIdList(agentRecord.defaultMCPGateways ?? agentRecord.default_mcp_gateways),
        toolSelections: normalizeIdList(
          agentRecord.defaultMCPToolSelections ?? agentRecord.default_mcp_tool_selections
        ),
        selectedCliToolIds: normalizeIdList(agentRecord.defaultTools ?? agentRecord.default_tools),
        defaultGateways: normalizeIdList(agentRecord.defaultMCPGateways ?? agentRecord.default_mcp_gateways),
        dcmDisplaySettings: agentRecord.dcmDisplaySettings ?? agentRecord.dcm_display_settings ?? null,
        assignedSubagents: getAssignedSubagentIds(agentRecord),
      },
      workers: body.workers,
    })

    return json(result)
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
    const result = await executeManagedSubagent({
      userId,
      sessionId,
      chatInput,
      subagent,
      parentAgentId: agentId,
      parentMessageId,
      projectPath,
      thread,
    })

    return json({
      success: true,
      kind: 'subagent',
      output: result.output,
      intermediateSteps: result.intermediateSteps,
      subagentType: result.subagentType,
      subagentId,
      subagentName: subagent.displayName || subagent.id,
      usage: result.usage,
      modelId: result.modelId,
      provider: result.provider,
      durationMs: result.durationMs,
      status: result.status,
      thread: result.thread,
      ...(result.threadNote ? { threadNote: result.threadNote } : {}),
      toolSource: toolSourceFor(result.subagentType),
    })
  } catch (error) {
    // SA-111 P2 (DL-111-05): a same-subagent collision is an explicit, expected outcome —
    // the bridge turns this message into readable tool content so the CLI agent can adapt.
    if (isSubagentBusyError(error)) {
      return json({
        success: true,
        kind: 'subagent',
        executionSucceeded: false,
        error: 'subagent_busy',
        output: error.message,
        intermediateSteps: [],
        subagentType,
        subagentId,
        subagentName: subagent.displayName || subagent.id,
        usage: null,
        modelId: subagent.primary_model_name ?? null,
        provider: subagent.primary_model_provider ?? null,
        durationMs: 0,
        status: 'failed',
        thread: null,
        toolSource: toolSourceFor(subagentType),
      })
    }

    const message = error instanceof Error ? error.message : String(error)
    const status = statusForExecutionError(message)
    return jsonError(
      status,
      status === 504 ? 'managed_subagent_timeout' : 'managed_subagent_failed',
      message
    )
  }
}
