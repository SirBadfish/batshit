import { isCanonicalAgentId } from '$lib/utils/agentId'
import {
  acquireSettingsMutation, assertSettingsLifecycle, captureSettingsLifecycle,
  type SettingsLifecycleSnapshot
} from '$lib/server/services/appActions/settings/lifecycle'

type AccessRecord = { agent_allowlist?: unknown; metadata?: unknown }
type SubjectClient = { json: { get(key: string): Promise<unknown> } }
declare const preparationBrand: unique symbol
export type ArtifactGrantPreparation = Readonly<{ [preparationBrand]: true }>
type Preparation = { count: number; snapshots: Map<string, SettingsLifecycleSnapshot | null> }
const preparations = new WeakMap<ArtifactGrantPreparation, Preparation>()
const MAX_CANDIDATES = 256
const aliases = ['agent_allowlist', 'agentAllowlist', 'assigned_agent_ids', 'assignedAgentIds'] as const

function references(record: AccessRecord): Set<string> {
  const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
    ? record.metadata as Record<string, unknown> : {}
  const ids = new Set<string>()
  for (const list of [record.agent_allowlist, ...aliases.map(alias => metadata[alias])]) {
    if (Array.isArray(list)) for (const value of list) if (typeof value === 'string') ids.add(value)
  }
  return ids
}

/** Capture at the actual service entry BEFORE any await/lock. Tentative refusals
 * apply only if the one held Artifact snapshot proves an actual added reference. */
export function prepareArtifactGrants(input: AccessRecord): ArtifactGrantPreparation {
  const candidates = references(input)
  const snapshots = new Map<string, SettingsLifecycleSnapshot | null>()
  for (const id of candidates) {
    if (snapshots.size === MAX_CANDIDATES) break
    try { snapshots.set(id, captureSettingsLifecycle([`agent:${id}`, `subagent:${id}`])) }
    catch { snapshots.set(id, null) }
  }
  const handle = Object.freeze({}) as ArtifactGrantPreparation
  preparations.set(handle, { count: candidates.size, snapshots })
  return handle
}

export class ArtifactGrantRefusal extends Error {
  readonly outcome = 'not_written'
  constructor(readonly code: 'ARTIFACT_GRANT_BUDGET_EXCEEDED' | 'ARTIFACT_GRANT_STALE' | 'ARTIFACT_GRANT_SUBJECT_INVALID' | 'ARTIFACT_GRANT_SUBJECT_UNAVAILABLE', readonly status: number) {
    super(code === 'ARTIFACT_GRANT_BUDGET_EXCEEDED'
      ? 'This grant change exceeds the 256 candidate-agent limit. No change was saved. Use the one-agent Access toggle for a large existing list.'
      : code === 'ARTIFACT_GRANT_SUBJECT_INVALID'
        ? 'New Artifact access must name a current owned agent or Subagent with an exact valid ID. No change was saved.'
        : code === 'ARTIFACT_GRANT_SUBJECT_UNAVAILABLE'
          ? 'The target agent identity could not be checked. No grant change was saved.'
          : 'The target agent changed or is being replaced. No grant change was saved. Reload before another change.')
    this.name = 'ArtifactGrantRefusal'
  }
}

export class ArtifactGrantUnknownError extends Error {
  readonly status = 503
  readonly code = 'ARTIFACT_GRANT_UNCONFIRMED'
  readonly outcome = 'unknown'
  readonly details: Readonly<{ artifactId: string; record: 'unknown' | 'saved'; indexPublication: 'not_started' | 'unknown' | 'unchanged'; outcome: 'unknown' }>
  constructor(artifactId: string, readonly record: 'unknown' | 'saved', readonly indexPublication: 'not_started' | 'unknown' | 'unchanged') {
    super(record === 'saved'
      ? 'The Artifact record was saved, but its index publication is unconfirmed. Grant custody is held; do not repeat this creation.'
      : 'The Artifact grant write was issued but its outcome is unconfirmed. Grant custody is held; do not repeat the write.')
    this.name = 'ArtifactGrantUnknownError'
    this.details = Object.freeze({ artifactId, record, indexPublication, outcome: 'unknown' })
  }
}

/** Only these fixed server-owned errors cross the HTTP/Fabric result boundary. */
export function serializeArtifactGrantFailure(error: unknown) {
  if (!(error instanceof ArtifactGrantRefusal) && !(error instanceof ArtifactGrantUnknownError)) return null
  return { success: false as const, error: error.message, status: error.status, code: error.code, outcome: error.outcome,
    ...(error instanceof ArtifactGrantUnknownError ? { details: error.details } : {}) }
}

/** No new authority: only genuinely added literal references enter the existing
 * subject lifecycle. Unchanged raw legacy values are neither validated nor repaired. */
async function checkedSnapshots(preparation: ArtifactGrantPreparation, userId: string, ids: string[], client: SubjectClient) {
  const held = preparations.get(preparation)
  if (!held || held.count > MAX_CANDIDATES || ids.some(id => !held.snapshots.has(id))) {
    throw new ArtifactGrantRefusal('ARTIFACT_GRANT_BUDGET_EXCEEDED', 400)
  }
  if (ids.some(id => !isCanonicalAgentId(id))) throw new ArtifactGrantRefusal('ARTIFACT_GRANT_SUBJECT_INVALID', 400)
  const snapshots = ids.map(id => held.snapshots.get(id)!)
  const check = () => {
    try { for (const snapshot of snapshots) { if (!snapshot) throw new Error(); assertSettingsLifecycle(snapshot) } }
    catch { throw new ArtifactGrantRefusal('ARTIFACT_GRANT_STALE', 409) }
  }
  check()
  for (const id of ids) {
    let records: unknown[]
    try { records = await Promise.all([client.json.get(`agent:${id}`), client.json.get(`subagent:${id}`)]) }
    catch { check(); throw new ArtifactGrantRefusal('ARTIFACT_GRANT_SUBJECT_UNAVAILABLE', 503) }
    check()
    if (!records.some(record => record && typeof record === 'object' && !Array.isArray(record) &&
      (record as Record<string, unknown>).id === id && (record as Record<string, unknown>).user_id === userId)) {
      throw new ArtifactGrantRefusal('ARTIFACT_GRANT_SUBJECT_INVALID', 404)
    }
  }
  check()
  return snapshots as SettingsLifecycleSnapshot[]
}

/** The existing explicit enable route also validates an already-present target.
 * This is a read-only no-op check, not a grant lease or legacy-list repair. */
export async function assertArtifactEnableTarget(preparation: ArtifactGrantPreparation, userId: string, id: string, client: SubjectClient) {
  await checkedSnapshots(preparation, userId, [id], client)
}

export async function admitArtifactGrants(
  preparation: ArtifactGrantPreparation, userId: string, before: AccessRecord, after: AccessRecord, client: SubjectClient
): Promise<ReturnType<typeof acquireSettingsMutation> | undefined> {
  const previous = references(before)
  const added = [...references(after)].filter(id => !previous.has(id))
  if (!added.length) return undefined
  const snapshots = await checkedSnapshots(preparation, userId, added, client)
  const first = snapshots[0]!
  // All tentative snapshots were captured in the same synchronous entry.
  return acquireSettingsMutation({ epoch: first.epoch, records: snapshots.flatMap(snapshot => snapshot!.records) })
}
