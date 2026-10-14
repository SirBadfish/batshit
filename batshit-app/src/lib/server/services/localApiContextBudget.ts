import { LOCAL_AI_SERVER_DEFINITIONS } from '$lib/data/localAiServers'
import { listLocalAiServers } from './localAiServers'
import { readLocalProgramApiKey } from './localProgramApiKeys'
import {
  localRuntimeReportsLoadedContext, readLocalRuntimeContextEvidence,
  resolveEffectiveContextLimit
} from './localRuntimeContext'
import type { LocalContextBudgetEvidence } from '$lib/types/localContextBudget'

/** One resolver for actual sends, previews, trim and compact. The browser never probes or compiles. */
export async function resolveApiContextBudget(args: {
  userId: string
  providerId: string | null | undefined
  modelId: string | null | undefined
  presetContextWindow: number | null | undefined
  requestedContextWindow?: number | null
  servers?: Awaited<ReturnType<typeof listLocalAiServers>>
}) {
  const definition = LOCAL_AI_SERVER_DEFINITIONS.find((entry) => entry.id === args.providerId)
  if (!definition) {
    return { ...resolveEffectiveContextLimit({ ...args, reading: null }), evidence: null }
  }
  const server = (args.servers ?? await listLocalAiServers(args.userId))
    .find((entry) => entry.id === definition.id)
  const apiKey = await readLocalProgramApiKey(definition.id, args.userId)
  const probe = server?.enabled ? await readLocalRuntimeContextEvidence({
    providerId: definition.id, modelId: args.modelId, baseUrl: server.baseUrl,
    userId: args.userId, apiKey
  }) : null
  const reports = localRuntimeReportsLoadedContext(definition.id)
  const reading = probe?.reading ?? (reports ? {
    source: 'unknown-until-loaded' as const, loadedContextWindow: null,
    maxContextWindow: null, remainingTtlSeconds: null
  } : null)
  const effective = resolveEffectiveContextLimit({ ...args, reading })
  const checkedAt = probe?.checkedAt ?? Date.now()
  const allocation = effective.source === 'requested' ? args.requestedContextWindow : effective.loadedContextWindow
  const planningNote = typeof allocation === 'number' && effective.contextLimit !== null && effective.contextLimit < allocation
    ? ` Batshit plans against the smaller preset limit of ${effective.contextLimit.toLocaleString()} tokens.` : ''
  const note = effective.source === 'requested'
    ? `${definition.label} will be asked to use ${allocation?.toLocaleString()} tokens for this request.${planningNote}`
    : effective.source === 'loaded'
      ? `${definition.label} reported a loaded context of ${allocation?.toLocaleString()} tokens.${planningNote}`
      : effective.source === 'preset'
        ? `${definition.label} has not reported its context. This limit is the saved preset estimate.`
        : `${definition.label} has not reported a loaded context. The context limit is unknown.`
  const evidence: LocalContextBudgetEvidence = {
    providerId: definition.id, modelId: args.modelId ?? '', source: effective.source === 'model-max' ? 'preset' : effective.source,
    checkedAt, expiresAt: probe?.expiresAt ?? checkedAt + 30_000, note
  }
  return { ...effective, evidence }
}
