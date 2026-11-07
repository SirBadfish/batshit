import { redis } from '$lib/server/redis'
import { acquireSettingsReplacementMutation } from './appActions/settings/lifecycle'
import { isArtifactAccessCleanupUnknown, removeArtifactAgentReferences } from './artifactAgentAccessCleanup'

export type AgentArtifactCleanupProgress = Readonly<{ changedArtifacts: number; removedReferences: number }>
type Failure = 'refused' | 'unknown' | 'progress_unavailable'
export class AgentArtifactCleanupError extends Error {
  readonly status: number
  readonly code: string
  readonly subjectRetained = true
  constructor(readonly outcome: Failure, readonly progress: AgentArtifactCleanupProgress) {
    super(outcome === 'unknown'
      ? 'Artifact reference cleanup was issued but its outcome is unconfirmed. The agent record was retained. Do not repeat deletion while its custody is unresolved.'
      : outcome === 'progress_unavailable'
        ? 'Artifact references were changed, but cleanup progress could not be recorded. The agent record was retained; earlier cleanup remains completed. Reload before another change.'
        : 'Artifact reference cleanup could not be completed. The agent record was retained; earlier cleanup may already have completed. Reload before another change.')
    this.name = 'AgentArtifactCleanupError'
    this.status = outcome === 'refused' ? 409 : 503
    this.code = outcome === 'unknown' ? 'AGENT_ARTIFACT_CLEANUP_UNCONFIRMED'
      : outcome === 'progress_unavailable' ? 'AGENT_ARTIFACT_CLEANUP_PROGRESS_UNAVAILABLE' : 'AGENT_ARTIFACT_CLEANUP_REFUSED'
  }
}

/** Actual deletion owner only. No replay, additional lock/key, or subject removal.
 * The caller supplies its ORIGINAL lifecycle/catalogue check, never a fresh basis.
 * A newly granted reference after enumeration remains a separate writer boundary. */
export async function removeRequiredArtifactAgentReferences(
  subject: Readonly<{ userId: string; id: string; kind: 'primary' | 'subagent' }>,
  checkCurrent: () => void
): Promise<AgentArtifactCleanupProgress> {
  let changedArtifacts = 0
  let removedReferences = 0
  const progress = () => Object.freeze({ changedArtifacts, removedReferences })
  const check = () => {
    try { checkCurrent() } catch (error) {
      if (changedArtifacts) throw new AgentArtifactCleanupError('refused', progress())
      throw error
    }
  }
  check()
  let artifactIds: string[]
  let checkFailed = false
  try {
    artifactIds = await redis.execute(client => {
      try { check() } catch (error) { checkFailed = true; throw error }
      return client.sMembers(`user:${subject.userId}:artifacts`)
    })
  } catch (error) {
    // A lifecycle/preparation refusal keeps its exact owning error.
    if (checkFailed) throw error
    check()
    throw new AgentArtifactCleanupError('refused', progress())
  }
  check()
  for (const artifactId of artifactIds) {
    check()
    const lease = acquireSettingsReplacementMutation(`${subject.kind === 'primary' ? 'agent' : 'subagent'}:${subject.id}`)
    let recorded = false
    try {
      const result = await removeArtifactAgentReferences({ userId: subject.userId, artifactId, agentId: subject.id }, {
        checkBeforeIssue() { lease.check(); check() },
        // This records confirmed physical changes before the next await/Artifact.
        onChanged(change) { recorded = true; changedArtifacts++; removedReferences += change.removed }
      })
      // A recognized changed result remains known even if its notification failed.
      if (result.status === 'changed' && !recorded) { changedArtifacts++; removedReferences += result.removed }
      lease.settle()
      if (result.status === 'changed' && result.notification === 'failed') {
        throw new AgentArtifactCleanupError('progress_unavailable', progress())
      }
      // Artifact deletion removes its record before its index member. This exact
      // absence is safe; unreadable/unowned/conflicted indexed records are not.
      if (result.status === 'refused' && result.reason !== 'artifact_missing') {
        throw new AgentArtifactCleanupError('refused', progress())
      }
    } catch (error) {
      if (isArtifactAccessCleanupUnknown(error)) {
        lease.unknown()
        throw new AgentArtifactCleanupError('unknown', progress())
      }
      lease.settle()
      if (changedArtifacts && !(error instanceof AgentArtifactCleanupError)) throw new AgentArtifactCleanupError('refused', progress())
      throw error
    }
  }
  check()
  return progress()
}
