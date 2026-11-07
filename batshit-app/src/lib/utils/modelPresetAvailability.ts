import type { CatalogConnectionOption } from '$lib/types/modelCatalog'
import type { SavedModel } from '$lib/types/savedModels'
import { determineModelCompatibility } from '$lib/data/model-compatibility-registry'
import { LOCAL_AI_SERVER_IDS } from '$lib/data/localAiServers'
import { chatModelUnavailableReason, resolveSavedModelConnection } from '$lib/utils/modelConnections'
import { resolveModelVoiceSessionConfig } from '$lib/utils/modelVoiceSession'
import type { ToolHostScope } from '$lib/utils/brokerAvailability'
import { RETIRED_CODEX_CLI_CONNECTION_ID, RETIRED_CODEX_CLI_PROVIDER_IDS } from '$lib/utils/cliRuntimeIdentity'

/**
 * SA-102 P6: derived, never hand-listed — see localImageTransportPolicy.ts.
 * Hardcoded, `sglang` and `omlx` presets resolved their compatibility as cloud,
 * so the availability chip in the preset picker could mis-label or lock them.
 */
const LOCAL_PROVIDER_IDS: ReadonlySet<string> = LOCAL_AI_SERVER_IDS

export type ModelPresetAvailability = {
  disabled: boolean
  /**
   * `unlisted` (BL-517): the saved-models list answer marked the preset (`unavailableReason`)
   * because its connection no longer lists its model. Like `locked`, the preset cannot be picked
   * now but stays saved and stays the agent's selection until the user picks another.
   */
  disabledBecause: 'non_chat' | 'incompatible' | 'locked' | 'unlisted' | 'voice_session' | null
  reason: string | null
  connectionOption: CatalogConnectionOption | null
}

/**
 * Whether a panel keeps an agent's or Subagent's saved preset selected when it opens. A preset
 * that is only unavailable for now (a locked connection, a model its connection stopped listing)
 * stays selected with its reason shown; clearing it would erase the saved choice on the next save.
 */
export function presetAvailabilityKeepsSelection(availability: ModelPresetAvailability): boolean {
  return (
    !availability.disabled ||
    availability.disabledBecause === 'locked' ||
    availability.disabledBecause === 'unlisted'
  )
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
    return { managed: true }
  }

  return {
    managed: base.batshit !== false,
    note: base.note
  }
}

/**
 * `agentType` is the picker's tool-host scope. Every Batshit picker passes `api` (SA-139 R4 for
 * Primaries, R5 for Subagents); a speech-to-speech preset is for that scope only.
 */
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
  // SA-139 R1: only the provider or connection ids name the retired Codex CLI. An OpenAI model id
  // that contains "codex" (an API or ChatGPT plan preset) is an ordinary API preset.
  const isRetiredCodexCliPreset =
    connectionId === RETIRED_CODEX_CLI_CONNECTION_ID ||
    RETIRED_CODEX_CLI_PROVIDER_IDS.has(connectionService) ||
    RETIRED_CODEX_CLI_PROVIDER_IDS.has(providerHint)
  // SA-139 R5: the Claude Code CLI lane was removed with its Subagent type, so a saved Claude Code
  // CLI preset gets the Codex CLI treatment: it stays saved and readable, and nothing can use it.
  const isRetiredClaudeCliPreset =
    connectionId === 'claude-cli' ||
    connectionService.includes('claude-cli') ||
    providerHint.includes('claude-cli') ||
    modelHint.includes('claude-cli')

  // A saved Codex CLI or Claude Code CLI preset never runs, and never runs as an API preset either.
  if (isRetiredCodexCliPreset || isRetiredClaudeCliPreset) {
    return { disabled: true, disabledBecause: 'incompatible', reason: 'This preset can no longer be used', connectionOption }
  }

  const chatUnavailable = !voiceSession &&
    chatModelUnavailableReason(connection, model.effectiveModelId ?? model.modelId, model.purpose)
  if (chatUnavailable) {
    return { disabled: true, disabledBecause: 'locked', reason: chatUnavailable, connectionOption }
  }

  if (!isChatModel) {
    return { disabled: true, disabledBecause: 'non_chat', reason: 'Not a chat model', connectionOption }
  }

  if (voiceSession) {
    if (agentType !== 'api') {
      return {
        disabled: true,
        disabledBecause: 'voice_session',
        reason: 'Speech-to-speech: Primary Agents only',
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

  if (!compatibility.managed) {
    return {
      disabled: true,
      disabledBecause: 'incompatible',
      reason: compatibility.note ?? 'Not available for agents',
      connectionOption
    }
  }

  const unavailableReason = normalize(model.unavailableReason ?? null)
  if (unavailableReason) {
    return { disabled: true, disabledBecause: 'unlisted', reason: unavailableReason, connectionOption }
  }

  if (connectionOption?.status === 'locked') {
    return {
      disabled: true,
      disabledBecause: 'locked',
      reason: connectionOption.lockedReason ?? 'Missing API key',
      connectionOption
    }
  }

  return { disabled: false, disabledBecause: null, reason: null, connectionOption }
}
