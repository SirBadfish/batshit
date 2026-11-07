/**
 * SA-111 P4 (DL-111-09..12) — Workers.
 *
 * A Worker is a throwaway helper a Primary Agent spawns mid-turn: "go find this out and
 * report back". It is deliberately NOT a subagent. Josh's decision #1/#2: the model does
 * not invent a helper's prompt, model, or tools — a worker is either the built-in general
 * worker (borrowing the parent's model and tool scope) or a fresh copy of one of the
 * user's own named subagents. Josh's #2: "It's just a little quick subsession."
 *
 * One batch tool calls this module, the API Primary's `native_spawn_workers` (SA-139 R4 removed
 * the CLI Primary's `spawn_workers`), so the caps (6 per call, 6 at a time since the delegation
 * limits, 2026-10-24), the validation, and the result shape live in ONE place. Every Worker runs
 * on the API lane (SA-139 R5 removed the CLI Subagent, and with it the CLI Worker). A Worker runs
 * under the same limits rule as a Subagent: none by default, the stall guard always, and a `base`
 * clone's Subagent's own time and tool-step limits (its record is copied whole).
 *
 * What a worker never touches (Faye's P4 design note): `subagent_sessions:` and the
 * same-subagent run lock. Parallel is the point and a worker
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
  isRetiredSubagentType,
  normalizeSubagentType,
  retiredSubagentTypeMessage,
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
 * Everything a worker inherits from the turn that spawned it, filled from the API brain's
 * already-resolved run context.
 */
export type WorkerParentContext = {
  userId: string
  sessionId: string
  parentAgentId: string
  /** The parent turn's message id — the key the six-at-a-time cap counts against. */
  parentMessageId: string | null
  projectPath: string | null
  /** The runtime family a built-in worker inherits (DL-111-10). */
  lane: 'api'
  /** The parent's resolved runtime model and connection. */
  parentModelId?: string | null
  parentConnection?: ModelConnectionInfo | null
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
    subagentType: 'api',
  }

  // Model fields left blank on purpose, so `resolveSubagentModelId` inherits the parent's
  // runtime model and `runApiSubagent` passes the parent's connection with it.
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

  // The six-at-a-time cap counts against the parent TURN, so a run Batshit cannot attribute
  // to a turn is refused rather than given a quietly unlimited budget.
  const parentMessageId = readTrimmed(parent.parentMessageId)
  if (!parentMessageId) {
    return refuse(
      'invalid_context',
      'Batshit could not identify the parent turn this worker batch belongs to, so its limit of workers at a time cannot be enforced. Do the work yourself and report this.'
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
      // A record of a removed type stays matchable (for the readable refusal below) but is never
      // offered as a base (SA-139 R2 and R5, D14).
      const available = assigned
        .filter((record) => !isRetiredSubagentType(normalizeSubagentType(record, record.subagentType)))
        .map((record) => resolveSubagentSlug(record))
      return refuse(
        'unknown_base',
        `Worker ${index + 1} asked to clone \`${reference}\`, which is not one of this agent's assigned subagents. ${
          available.length > 0
            ? `Available: ${available.join(', ')}.`
            : 'This agent has no assigned subagents, so omit `base` to use the built-in worker.'
        }`
      )
    }
    if (isRetiredSubagentType(normalizeSubagentType(match, match.subagentType))) {
      // SA-139 R2/R5 (D14): a removed Subagent type (n8n, or the CLI Subagent) is never cloned
      // into a Worker; refused here, before any Worker run is reserved.
      return refuse(
        'unsupported_base',
        `Worker ${index + 1} asked to clone \`${reference}\`. ${retiredSubagentTypeMessage({ ...match, displayName: match.displayName ?? reference })} Omit \`base\` to use the built-in worker.`
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

  // A worker's slug keeps its position in the batch; it names no folder, thread or lock.
  const parentAgentSlug = normalizeSubagentSlugValue(parent.parentAgentId, 'agent')
  const delegationSlugs = specs.map((_, index) => `worker_${parentAgentSlug}_${index + 1}`)

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
            delegationSlug: delegationSlugs[index],
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
          // A throw here is a setup failure. Report it as this worker's failed result so the
          // batch's other workers still come back.
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
