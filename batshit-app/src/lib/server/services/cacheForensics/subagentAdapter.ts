import { normalizeUsageLike } from '$lib/server/services/apiProviderUsage'
import type {
  CacheForensicsProviderCacheUsage,
  CacheForensicsRecord,
} from '$lib/types/cacheForensics'
import { segmentCompiledMessages } from './cliAdapter'
import { captureCacheForensicsRecord } from './record'

/**
 * SA-093 managed subagent adapter (P4).
 *
 * A managed subagent run (API Subagent through VercelAIBrain, CLI Subagent
 * through the Codex/Claude bridges) fingerprints ITS OWN compiled contract —
 * the runner-built system prompt + memory + chat input message array — never
 * the parent's fingerprint. The record is stored on the PARENT send's
 * Execution Viewer snapshot (DL-093-10: no new storage), marked
 * `actor: 'subagent'` with a pseudonymous `parentRunId` for correlation.
 *
 * Honesty (DL-093-07/08): the tool contract of a managed subagent rides the
 * brain-resolved gateway set or the managed CLI profile, and the provider
 * request boundary is not exposed on these lanes — both facts are disclosed
 * in notes instead of being guessed at.
 */

export type ManagedSubagentForensicsLane = 'api' | 'codex' | 'claude'

function providerCacheUsageFromLane(
  usage: unknown,
): CacheForensicsProviderCacheUsage | undefined {
  const normalized = normalizeUsageLike(usage)
  if (!normalized) return undefined

  const cacheUsage: CacheForensicsProviderCacheUsage = { source: 'runtime' }
  if (typeof normalized.inputTokens === 'number') {
    cacheUsage.inputTokens = normalized.inputTokens
  }
  if (typeof normalized.cachedInputTokens === 'number') {
    cacheUsage.cachedInputTokens = normalized.cachedInputTokens
  }
  if (typeof normalized.cacheCreationInputTokens === 'number') {
    cacheUsage.cacheCreationInputTokens = normalized.cacheCreationInputTokens
  }
  if (
    cacheUsage.inputTokens === undefined &&
    cacheUsage.cachedInputTokens === undefined &&
    cacheUsage.cacheCreationInputTokens === undefined
  ) {
    return undefined
  }
  return cacheUsage
}

export function buildManagedSubagentCacheForensicsRecord(args: {
  lane: ManagedSubagentForensicsLane
  /** RAW runner-compiled message array (system prompt + memory + chat input). */
  messages: unknown[]
  /** Runtime-reported usage for the subagent run, when available. */
  usage?: unknown
  subagentId: string | null | undefined
  connectionId: string | null | undefined
  modelId: string | null | undefined
  /** This subagent run's own message id (raw; pseudonymized as runId). */
  runMessageId: string
  /** The PARENT send's message id (raw; pseudonymized as parentRunId). */
  parentMessageId: string
  experimentGroup?: string | null
  capturedAt?: string
}): CacheForensicsRecord {
  const laneNotes =
    args.lane === 'api'
      ? [
          'Managed API Subagent run: the provider-request boundary is not exposed on this lane, so segments cover the runner-compiled boundary only.',
          'The subagent tool contract is resolved inside the brain from gateway selections and is not fingerprinted in v1.',
        ]
      : [
          `Managed ${args.lane === 'codex' ? 'Codex' : 'Claude'} CLI Subagent run: the harness adds native instructions, tools, and provider serialization after this boundary; that hidden material is unavailable to Batshit.`,
          'The subagent tool contract rides the managed CLI profile and is not fingerprinted in v1.',
        ]

  const record = captureCacheForensicsRecord({
    runtime: args.lane === 'api' ? 'vercel' : args.lane,
    boundary: 'batshit-compiled',
    confidence: 'exact',
    agentId: args.subagentId,
    connectionId: args.connectionId,
    modelId: args.modelId,
    runId: args.runMessageId,
    experimentGroup: args.experimentGroup ?? null,
    segments: segmentCompiledMessages(args.messages),
    capturedAt: args.capturedAt,
    actor: 'subagent',
    parentRunId: args.parentMessageId,
    notes: laneNotes,
  })

  const cacheUsage = providerCacheUsageFromLane(args.usage)
  if (cacheUsage) record.providerCacheUsage = cacheUsage

  return record
}
