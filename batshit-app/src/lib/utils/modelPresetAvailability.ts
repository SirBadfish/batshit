import type { CatalogConnectionOption } from '$lib/types/modelCatalog'
import type { SavedModel } from '$lib/types/savedModels'
import { determineModelCompatibility } from '$lib/data/model-compatibility-registry'
import { LOCAL_AI_SERVER_IDS } from '$lib/data/localAiServers'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'
import { resolveModelVoiceSessionConfig } from '$lib/utils/modelVoiceSession'
import type { PrimaryAgentType } from '$lib/utils/primaryAgentType'
import { isCliPrimaryAgentType } from '$lib/utils/primaryAgentType'
import type { ToolHostScope } from '$lib/utils/brokerAvailability'

/**
 * SA-102 P6: derived, never hand-listed — see localImageTransportPolicy.ts.
 * Hardcoded, `sglang` and `omlx` presets resolved their compatibility as cloud,
 * so the availability chip in the preset picker could mis-label or lock them.
 */
const LOCAL_PROVIDER_IDS: ReadonlySet<string> = LOCAL_AI_SERVER_IDS

export type ModelPresetAvailability = {
  disabled: boolean
  disabledBecause: 'non_chat' | 'incompatible' | 'locked' | 'voice_session' | null
  reason: string | null
  connectionOption: CatalogConnectionOption | null
}

function normalize(value?: string | null) {
  return value?.trim() ?? ''
}

function resolveConnectionOption(
  model: SavedModel,
  options: CatalogConnectionOption[] | null | undefined
): CatalogConnectionOption | null {
  if (!options?.length) return null

  const connection = resolveSavedModelConnection(model)
  const explicitId = normalize(connection.id ?? null)
  if (explicitId) {
    return options.find((option) => option.id === explicitId) ?? null
  }

  if (connection.type === 'openrouter') {
    return options.find((option) => option.id === 'openrouter') ?? null
  }

  if (connection.type === 'vercel-gateway') {
    return options.find((option) => option.id === 'vercel-gateway') ?? null
  }

  if (connection.type === 'direct') {
    const service = normalize(connection.service ?? null)
    if (service) {
      return (
        options.find((option) => option.id === `direct:${service}`) ??
        options.find((option) => option.id === service) ??
        options.find((option) => option.transport === 'direct' && option.service === service) ??
        null
      )
    }
  }

  return null
}

function resolveCompatibility(model: SavedModel) {
  const providerId = normalize(model.provider).toLowerCase()
  const base =
    LOCAL_PROVIDER_IDS.has(providerId)
      ? determineModelCompatibility(providerId)
      : model.compatibility ?? determineModelCompatibility(providerId)
  const connection = resolveSavedModelConnection(model)

  if (connection.type === 'openrouter' || connection.type === 'vercel-gateway') {
    return { n8n: true, managed: true }
  }

  return {
    n8n: base.n8n !== false,
    managed: base.batshit !== false,
    note: base.note
  }
}

export function getModelPresetAvailability({
  model,
  agentType,
  connectionOptions
}: {
  model: SavedModel
  agentType: ToolHostScope
  connectionOptions?: CatalogConnectionOption[] | null
}): ModelPresetAvailability {
  const voiceSession = resolveModelVoiceSessionConfig(model)
  const isChatModel = voiceSession ? true : model.purpose !== undefined ? model.purpose === 'chat' : true
  const compatibility = resolveCompatibility(model)
  const connectionOption = resolveConnectionOption(model, connectionOptions)
  const connection = resolveSavedModelConnection(model)
  const connectionId = normalize(connection.id ?? null)
  const connectionService = normalize(connection.service ?? null)
  const providerHint = normalize(model.provider).toLowerCase()
  const modelHint = normalize(model.modelId).toLowerCase()
  const isCodexPreset =
    connectionId === 'codex-cli' ||
    connectionService.includes('codex') ||
    providerHint.includes('codex') ||
    modelHint.includes('codex')
  const isClaudeCliPreset =
    connectionId === 'claude-cli' ||
    connectionService.includes('claude-cli') ||
    providerHint.includes('claude-cli') ||
    modelHint.includes('claude-cli')
  const isCliPreset = isCodexPreset || isClaudeCliPreset

  if (!isChatModel) {
    return { disabled: true, disabledBecause: 'non_chat', reason: 'Not a chat model', connectionOption }
  }

  if (voiceSession) {
    if (agentType !== 'api') {
      return {
        disabled: true,
        disabledBecause: 'voice_session',
        reason: 'Speech-to-speech presets are for API voice agents',
        connectionOption
      }
    }

    if (voiceSession.supportStatus !== 'supported') {
      return {
        disabled: true,
        disabledBecause: 'voice_session',
        reason:
          voiceSession.supportStatus === 'planned'
            ? 'LiveKit adapter planned'
            : 'LiveKit adapter on watchlist',
        connectionOption
      }
    }
  }

  if (agentType === 'n8n') {
    if (!compatibility.n8n) {
      return {
        disabled: true,
        disabledBecause: 'incompatible',
        reason: compatibility.note ?? 'Not available for n8n agents',
        connectionOption
      }
    }
    return { disabled: false, disabledBecause: null, reason: null, connectionOption }
  }

  if (!compatibility.managed) {
    return {
      disabled: true,
      disabledBecause: 'incompatible',
      reason: compatibility.note ?? 'Not available for API or CLI agents',
      connectionOption
    }
  }

  if (isCliPrimaryAgentType(agentType) && !isCliPreset) {
    return {
      disabled: true,
      disabledBecause: 'incompatible',
      reason: 'CLI agents only support CLI presets',
      connectionOption
    }
  }

  if (!isCliPrimaryAgentType(agentType) && isCliPreset) {
    return {
      disabled: true,
      disabledBecause: 'incompatible',
      reason: 'CLI presets are only available for CLI agents',
      connectionOption
    }
  }

  if (connectionOption?.status === 'locked') {
    if (isCliPrimaryAgentType(agentType) && isCliPreset) {
      return {
        disabled: false,
        disabledBecause: null,
        reason: connectionOption.lockedReason ?? 'CLI login required',
        connectionOption
      }
    }

    return {
      disabled: true,
      disabledBecause: 'locked',
      reason: connectionOption.lockedReason ?? 'Missing API key',
      connectionOption
    }
  }

  return { disabled: false, disabledBecause: null, reason: null, connectionOption }
}
