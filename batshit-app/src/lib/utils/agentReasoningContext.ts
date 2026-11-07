import type { SavedModel } from '$lib/types/savedModels'
import type { AgentReasoningOverrides, ReasoningControlIdentity, LocalReasoningContract } from '$lib/types/reasoningControls'
import { reviewedReasoningBinding, isOllamaReasoningConnection } from '$lib/data/reasoning-controls'
import { reasoningOverrideKey, reasoningControlKeys, REASONING_CONTROL_IDS } from '$lib/utils/modelReasoningControls'
import { isRetiredPrimaryAgentType, normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'

export function agentReasoningContext(agent: {
  primary_model_preset_id?: string | null; primary_model_name?: string | null
  primary_model_connection?: SavedModel['connection'] | null
  provider_specific_settings?: Record<string, any> | null
  model_reasoning_overrides?: AgentReasoningOverrides
  agentType?: string; primary_model_provider?: string | null; primary_model_capabilities?: SavedModel['capabilities'] | null
} | null | undefined, preset?: SavedModel | null, localReasoning?: LocalReasoningContract | null) {
  if (!agent) return null
  // SA-139 R4: a leftover Primary of a retired type has no live reasoning controls; it is never
  // read through the API path.
  if (isRetiredPrimaryAgentType(normalizePrimaryAgentType(agent))) return null
  const connection = preset?.connection ?? agent.primary_model_connection
  const effectiveModelId = preset?.effectiveModelId ?? preset?.modelId ?? agent.primary_model_name
  if (!connection || !effectiveModelId) return null
  const identity: ReasoningControlIdentity = { presetId: preset?.id ?? agent.primary_model_preset_id ?? null,
    connection, effectiveModelId }
  return { identity, key: reasoningOverrideKey(identity, 'effort'), keys: reasoningControlKeys(identity),
    provider: preset?.provider ?? agent.primary_model_provider,
    binding: reviewedReasoningBinding({ modelId: effectiveModelId, connection, localReasoning }),
    capabilities: preset?.capabilities ?? agent.primary_model_capabilities ?? null,
    settings: preset ? preset.settings : agent.provider_specific_settings }
}

/** Known controls plus retained unsupported intent all participate in the primary Send guard. */
export function agentReasoningControlKeys(context: NonNullable<ReturnType<typeof agentReasoningContext>>, overrides?: AgentReasoningOverrides): string[] {
  return REASONING_CONTROL_IDS.filter(id => context.binding?.controls.some(control => control.id === id) || id === 'thinking' && isOllamaReasoningConnection(context.identity.connection) || overrides?.[context.keys[id]] !== undefined)
    .map(id => context.keys[id])
}
