/**
 * SA-111 P4 (DL-111-09..12) — Workers.
 *
 * A Worker is a throwaway helper a Primary Agent spawns mid-turn: "go find this out and
 * report back". It is deliberately NOT a subagent. Josh's decision #1/#2: the model does
 * not invent a helper's prompt, model, or tools — a worker is either the built-in general
 * worker (borrowing the parent's model and tool scope) or a fresh copy of one of the
 * user's own named subagents. Josh's #2: "It's just a little quick subsession."
 *
 * One batch tool per lane calls this module — `native_spawn_workers` on the API lane,
 * `spawn_workers` through the managed CLI bridge — so the 3/3/9 caps, the validation, and
 * the result shape live in ONE place regardless of how Codex or Claude schedule MCP calls.
 *
 * What a worker never touches (Faye's P4 design note): `subagent_sessions:`,
 * `subagent_thread:`, and the same-subagent run lock. Parallel is the point and a worker
 * has no thread, so the runner is entered with a `none` thread plan.
 */

import { randomUUID } from 'crypto'
import { redis } from '$lib/server/redis'
import type {
  AgentDcmDisplaySettings,
  MCPToolSelections,
  SubagentRow,
} from '$lib/types/database'
import type { ModelConnectionInfo } from '$lib/types/savedModels'
import type { DelegatedRunStatus, DelegatedUsage } from '$lib/types/delegation'
import {
  DEFAULT_WORKER_DISPLAY_NAME,
  WORKERS_MAX_PER_CALL,
  WORKER_ROLE_MAX_CHARS,
  WORKER_TASK_MAX_CHARS,
} from '$lib/utils/delegationCapabilities'
import {
  canonicalizeSubagentRecord,
  isWorkflowBackedSubagentType,
  normalizeSubagentType,
} from '$lib/utils/subagentType'
import { normalizeSubagentSlugValue, resolveSubagentSlug } from '$lib/utils/subagentSlug'
import { executeManagedSubagent } from '$lib/server/services/subagentRunner'
import { reserveWorkerRuns, type WorkerTurnKey } from '$lib/server/services/workerTurnBudget'

/** One worker as the model asks for it (DL-111-09). */
export type WorkerSpec = {
  task: string
  role?: string | null
  base?: string | null
}

export type WorkerRunRecord = {
  index: number
  name: string
  role: string | null
  base: string | null
  status: DelegatedRunStatus
  output: string
  usage: DelegatedUsage | null
  modelId: string | null
  provider: string | null
  durationMs: number
}

export type SpawnWorkersRefusal = {
  kind: 'workers'
  success: false
  error: string
  message: string
  workers: []
}

export type SpawnWorkersSuccess = {
  kind: 'workers'
  success: true
  requested: number
  completed: number
  workers: WorkerRunRecord[]
}

export type SpawnWorkersResult = SpawnWorkersRefusal | SpawnWorkersSuccess

/**
 * Everything a worker inherits from the turn that spawned it. The API lane fills this from
 * the brain's already-resolved run context; the managed CLI lane fills it from the parent
 * agent record inside `/api/subagents/managed-execute`.
 */
export type WorkerParentContext = {
  userId: string
  sessionId: string
  parentAgentId: string
  /** The parent turn's message id — the key the 9-per-turn cap counts against. */
  parentMessageId: string | null
  projectPath: string | null
  /** The runtime family a built-in worker inherits (DL-111-10). */
  lane: 'api' | 'cli'
  /** API lane: the parent's resolved runtime model and connection. */
  parentModelId?: string | null
  parentConnection?: ModelConnectionInfo | null
  /** CLI lane: the parent agent's own model fields, resolved the same way a CLI Subagent's are. */
  cliModelFields?: Partial<
    Pick<
      SubagentRow,
      'primary_model_provider' | 'primary_model_name' | 'model' | 'codex_settings' | 'claude_settings'
    >
  > | null
  providerSettings: Record<string, any> | null
  selectedGateways: string[] | null
  toolSelections: MCPToolSelections | null
  selectedCliToolIds: string[] | null
  defaultGateways: string[] | null
  dcmDisplaySettings: AgentDcmDisplaySettings | null
  /** Assigned subagent records or ids — the only things `base` may name. */
  assignedSubagents: any[] | null
  abortSignal?: AbortSignal
}

export type SpawnWorkersParams = {
  parent: WorkerParentContext
  workers: unknown
}

function refuse(error: string, message: string): SpawnWorkersRefusal {
  return { kind: 'workers', success: false, error, message, workers: [] }
}

function readTrimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Validate the batch exactly as the model sent it. Every failure returns a readable result
 * instead of throwing (DL-111-09) so the model can fix the call rather than seeing an
 * opaque tool error.
 */
function normalizeWorkerSpecs(
  value: unknown
): { ok: true; specs: WorkerSpec[] } | { ok: false; refusal: SpawnWorkersRefusal } {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      refusal: refuse(
        'invalid_input',
        'Send a `workers` array with 1 to ' +
          `${WORKERS_MAX_PER_CALL} entries, each an object with a \`task\`.`
      ),
    }
  }

  const specs: WorkerSpec[] = []
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return {
        ok: false,
        refusal: refuse('invalid_input', `Worker ${index + 1} must be an object with a \`task\`.`),
      }
    }
    const record = entry as Record<string, unknown>
    const task = readTrimmed(record.task ?? record.chatInput ?? record.prompt)
    if (!task) {
      return {
        ok: false,
        refusal: refuse(
          'invalid_input',
          `Worker ${index + 1} has no \`task\`. A worker cannot ask you a follow-up, so state the goal, the constraints, and the answer shape you want.`
        ),
      }
    }
    if (task.length > WORKER_TASK_MAX_CHARS) {
      return {
        ok: false,
        refusal: refuse(
          'invalid_input',
          `Worker ${index + 1}'s task is ${task.length} characters; the limit is ${WORKER_TASK_MAX_CHARS}. Trim it or split the work.`
        ),
      }
    }
    const role = readTrimmed(record.role)
    if (role.length > WORKER_ROLE_MAX_CHARS) {
      return {
        ok: false,
        refusal: refuse(
          'invalid_input',
          `Worker ${index + 1}'s role label is ${role.length} characters; the limit is ${WORKER_ROLE_MAX_CHARS}. It is a short label, not a brief.`
        ),
      }
    }
    specs.push({
      task,
      role: role || null,
      base: readTrimmed(record.base) || null,
    })
  }

  return { ok: true, specs }
}

async function loadAssignedSubagentRecords(parent: WorkerParentContext): Promise<SubagentRow[]> {
  const entries = Array.isArray(parent.assignedSubagents) ? parent.assignedSubagents : []
  const records: SubagentRow[] = []
  const seenIds = new Set<string>()

  for (const entry of entries) {
    if (typeof entry === 'string') {
      const id = entry.trim()
      if (!id || seenIds.has(id)) continue
      seenIds.add(id)
      const raw = await redis.get(`subagent:${id}`).catch(() => null)
      if (!raw) continue
      const record = canonicalizeSubagentRecord(raw as Record<string, any>) as SubagentRow
      if (record.user_id && record.user_id !== parent.userId) continue
      records.push(record)
      continue
    }
    if (entry && typeof entry === 'object') {
      const record = canonicalizeSubagentRecord(entry as Record<string, any>) as SubagentRow
      const id = typeof record.id === 'string' ? record.id.trim() : ''
      if (id && seenIds.has(id)) continue
      if (id) seenIds.add(id)
      if (record.user_id && record.user_id !== parent.userId) continue
      records.push(record)
    }
  }

  return records
}

function matchesBaseReference(record: SubagentRow, reference: string): boolean {
  const wanted = normalizeSubagentSlugValue(reference)
  if (!wanted) return false
  if (resolveSubagentSlug(record) === wanted) return true
  const id = typeof record.id === 'string' ? normalizeSubagentSlugValue(record.id) : ''
  if (id && id === wanted) return true
  const displayName =
    typeof record.displayName === 'string' ? normalizeSubagentSlugValue(record.displayName) : ''
  return Boolean(displayName) && displayName === wanted
}

function workerDisplayName(spec: WorkerSpec, index: number, baseRecord: SubagentRow | null): string {
  if (spec.role) return spec.role
  if (baseRecord?.displayName) return `${baseRecord.displayName} (worker)`
  return `${DEFAULT_WORKER_DISPLAY_NAME} ${index + 1}`
}

/**
 * The ephemeral record one worker runs as. DL-111-10: the built-in general worker inherits
 * the parent's model and resolved tool scope; a `base` clone keeps the base subagent's own
 * prompt, model, scope, and skills — which is why the clone keeps the base's `id`, so
 * `resolveManagedSubagentScope` and the skills lookup read the real record.
 *
 * Neither kind is ever written to Redis. It exists for the length of one run.
 */
function buildWorkerRecord(args: {
  parent: WorkerParentContext
  spec: WorkerSpec
  index: number
  baseRecord: SubagentRow | null
}): SubagentRow {
  const { parent, spec, index, baseRecord } = args
  const displayName = workerDisplayName(spec, index, baseRecord)

  if (baseRecord) {
    return {
      ...baseRecord,
      displayName,
      // A worker never carries the user's global identity prompt (DL-111-10).
      include_global_prompt: false,
    } as SubagentRow
  }

  const now = new Date().toISOString()
  const shared: SubagentRow = {
    id: `worker_${randomUUID()}`,
    user_id: parent.userId,
    displayName,
    description: '',
    created_at: now,
    updated_at: now,
    include_global_prompt: false,
    // The built-in worker's scope IS the parent's resolved scope, expressed as the record's
    // own defaults so `resolveManagedSubagentScope` produces it without a second code path.
    provider_specific_settings: parent.providerSettings ?? undefined,
    ...(parent.selectedGateways ? { defaultMCPGateways: parent.selectedGateways } : {}),
    ...(parent.toolSelections ? { defaultMCPToolSelections: parent.toolSelections } : {}),
    ...(parent.selectedCliToolIds ? { defaultTools: parent.selectedCliToolIds } : {}),
    ...(parent.dcmDisplaySettings ? { dcmDisplaySettings: parent.dcmDisplaySettings } : {}),
    subagentType: parent.lane === 'cli' ? 'cli' : 'api',
  }

  if (parent.lane === 'cli') {
    return {
      ...shared,
      ...(parent.cliModelFields ?? {}),
    }
  }

  // API lane: model fields left blank on purpose, so `resolveSubagentModelId` inherits the
  // parent's runtime model and `runApiSubagent` passes the parent's connection with it.
  return shared
}

/**
 * Run one batch of workers. Concurrent inside the batch (`Promise.all`); a failure in one
 * worker never takes down the others, because each worker's own failure already comes back
 * as a `failed`/`timed_out` result from the shared runner.
 */
export async function spawnWorkers(params: SpawnWorkersParams): Promise<SpawnWorkersResult> {
  const { parent } = params

  if (!parent.userId || !parent.sessionId || !parent.parentAgentId) {
    return refuse(
      'invalid_context',
      'Worker spawning is missing the user, session, or agent context it runs under.'
    )
  }

  // DL-111-09: the 9-per-turn cap counts against the parent TURN, so a run Batshit cannot
  // attribute to a turn is refused rather than given a quietly unlimited budget.
  const parentMessageId = readTrimmed(parent.parentMessageId)
  if (!parentMessageId) {
    return refuse(
      'invalid_context',
      'Batshit could not identify the parent turn this worker batch belongs to, so its per-turn limit cannot be enforced. Do the work yourself and report this.'
    )
  }

  const normalized = normalizeWorkerSpecs(params.workers)
  if (!normalized.ok) return normalized.refusal
  const specs = normalized.specs

  const assigned = await loadAssignedSubagentRecords(parent)
  const baseRecords: (SubagentRow | null)[] = []
  for (let index = 0; index < specs.length; index += 1) {
    const reference = specs[index].base
    if (!reference) {
      baseRecords.push(null)
      continue
    }
    const match = assigned.find((record) => matchesBaseReference(record, reference)) ?? null
    if (!match) {
      const available = assigned.map((record) => resolveSubagentSlug(record))
      return refuse(
        'unknown_base',
        `Worker ${index + 1} asked to clone \`${reference}\`, which is not one of this agent's assigned subagents. ${
          available.length > 0
            ? `Available: ${available.join(', ')}.`
            : 'This agent has no assigned subagents, so omit `base` to use the built-in worker.'
        }`
      )
    }
    if (isWorkflowBackedSubagentType(normalizeSubagentType(match, match.subagentType))) {
      return refuse(
        'unsupported_base',
        `Worker ${index + 1} asked to clone \`${reference}\`, an n8n Workflow Subagent. n8n owns that workflow's runtime and memory, so it cannot be copied into a worker. Call it as a subagent instead, or omit \`base\`.`
      )
    }
    baseRecords.push(match)
  }

  const turnKey: WorkerTurnKey = {
    sessionId: parent.sessionId,
    agentId: parent.parentAgentId,
    parentMessageId,
  }
  const reservation = reserveWorkerRuns(turnKey, specs.length)
  if (!reservation.ok) {
    return refuse(reservation.code, reservation.message)
  }

  const parentAgentSlug = normalizeSubagentSlugValue(parent.parentAgentId, 'agent')

  try {
    const workers = await Promise.all(
      specs.map(async (spec, index): Promise<WorkerRunRecord> => {
        const baseRecord = baseRecords[index]
        const record = buildWorkerRecord({ parent, spec, index, baseRecord })
        const name = record.displayName || `${DEFAULT_WORKER_DISPLAY_NAME} ${index + 1}`
        const baseSlug = baseRecord ? resolveSubagentSlug(baseRecord) : null
        const startedAt = Date.now()

        try {
          const result = await executeManagedSubagent({
            userId: parent.userId,
            sessionId: parent.sessionId,
            chatInput: spec.task,
            subagent: record,
            parentAgentId: parent.parentAgentId,
            parentMessageId,
            projectPath: parent.projectPath,
            parentModelId: parent.parentModelId ?? null,
            parentConnection: parent.parentConnection ?? null,
            toolApprovalMode: 'off',
            delegationKind: 'worker',
            workerRole: spec.role,
            workerBaseLabel: baseRecord?.displayName ?? null,
            // One profile slot per position in the batch, scoped to this parent agent:
            // managed CLI profile files are written non-atomically, so two concurrent
            // workers must never share a profile path.
            delegationSlug: `worker_${parentAgentSlug}_${index + 1}`,
            abortSignal: parent.abortSignal,
          })

          return {
            index,
            name,
            role: spec.role ?? null,
            base: baseSlug,
            status: result.status,
            output: result.output,
            usage: result.usage,
            modelId: result.modelId,
            provider: result.provider,
            durationMs: result.durationMs,
          }
        } catch (error) {
          // A throw here is a setup failure (no model, bad CLI target). Report it as this
          // worker's failed result so the batch's other workers still come back.
          return {
            index,
            name,
            role: spec.role ?? null,
            base: baseSlug,
            status: 'failed' as DelegatedRunStatus,
            output: `${name} could not start: ${
              error instanceof Error ? error.message : String(error)
            }`,
            usage: null,
            modelId: null,
            provider: null,
            durationMs: Math.max(0, Date.now() - startedAt),
          }
        }
      })
    )

    return {
      kind: 'workers',
      success: true,
      requested: workers.length,
      completed: workers.filter((worker) => worker.status === 'completed').length,
      workers,
    }
  } finally {
    reservation.release()
  }
}
