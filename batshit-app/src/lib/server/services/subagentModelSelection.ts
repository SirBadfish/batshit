import type { ModelConnectionInfo } from '$lib/types/savedModels'
import type { SubagentRow } from '$lib/types/database'
import type { ParameterValue } from '$lib/data/parameter-schemas'
import { resolveRuntimeModelSelection } from '$lib/utils/modelPresetRuntime'
import { buildRuntimeModelSettings, type RuntimeModelSettings } from '$lib/utils/modelSettingsMapper'
import { resolveModelIds } from '$lib/utils/modelIdResolver'
import { loadRuntimeModelPreset } from './runtimeModelPreset'

export class SubagentModelSelectionError extends Error {
  readonly code = 'subagent_model_connection_missing'

  constructor(message: string) {
    super(message)
    this.name = 'SubagentModelSelectionError'
  }
}

export type ApiSubagentModel = {
  /** The id the provider is called with (`resolveModelIds`, the primary's rule). */
  modelId: string
  connection: ModelConnectionInfo | null
  provider: string | null
  settings: Record<string, any> | null
  presetId: string | null
  /** True when the Subagent has no model of its own and runs on the parent's. */
  inherited: boolean
  /**
   * BL-800: the sampling values and provider options the run's model call sends, built by the
   * mapper a primary's send uses (`buildRuntimeModelSettings`) from the live preset. Blank sends
   * nothing and zero is real; a value the model rejects stays out. Empty for a run on the
   * parent's model, which has no preset of its own.
   */
  runtimeSettings: RuntimeModelSettings
}

type SubagentModelFields = Pick<
  SubagentRow,
  | 'displayName'
  | 'model'
  | 'primary_model_provider'
  | 'primary_model_name'
  | 'primary_model_preset_id'
  | 'primary_model_connection'
  | 'provider_specific_settings'
>

/**
 * BL-183, BL-184: a delegated API run carries no request-level cache setting, which is why every
 * cache point on it lives five minutes and why the Token Panel prices its cache writes at five
 * minutes (`resolveDelegatedCacheTtl` in `tokenPanel.ts`). A preset's Prompt cache TTL is exactly
 * such a setting (`anthropic.cacheControl`), so it stays out of a delegated run until the Token
 * Panel can read each run's own lifetime; every other provider option of the preset goes through.
 */
function withoutRequestCacheSetting(runtime: RuntimeModelSettings): RuntimeModelSettings {
  const providerOptions: Record<string, Record<string, any>> = {}
  for (const [namespace, options] of Object.entries(runtime.providerOptions)) {
    const { cacheControl: _cacheControl, cache_control: _cacheControlSnake, ...rest } = options
    if (Object.keys(rest).length > 0) providerOptions[namespace] = rest
  }
  return { standard: runtime.standard, providerOptions }
}

/**
 * BL-266: the model and connection an API Subagent runs on, resolved the way a primary's are.
 *
 * A Subagent with its own model names the saved preset the user picked, and the preset carries
 * the connection (direct Google, OpenRouter, a local server). It used to pass no connection at
 * all, so the model was resolved by NAME, and with an AI Gateway key configured every such model
 * went through the gateway: the wrong provider, the wrong bill, and a Gemini model that answered
 * empty five times there. The preset is read fresh each run, so moving it to another connection
 * moves every agent and Subagent that names it.
 *
 * An own model saved before the preset was kept (a record with a model name and no preset id)
 * is refused with the fix in the message: guessing the connection from the name is the bug.
 * A Subagent with no model of its own runs on the parent's model AND the parent's connection.
 */
export async function resolveApiSubagentModel(input: {
  subagent: SubagentModelFields
  parentModelId?: string | null
  parentConnection?: ModelConnectionInfo | null
}): Promise<ApiSubagentModel> {
  const { subagent } = input
  const settings =
    subagent.provider_specific_settings && typeof subagent.provider_specific_settings === 'object'
      ? (subagent.provider_specific_settings as Record<string, any>)
      : null
  const ownModel = subagent.primary_model_name?.trim() || subagent.model?.trim() || ''

  if (!ownModel) {
    const parentModelId = input.parentModelId?.trim() ?? ''
    if (!parentModelId) {
      throw new Error('API Subagent needs a model selection or a parent model to inherit.')
    }
    return {
      modelId: parentModelId,
      connection: input.parentConnection ?? null,
      provider: input.parentConnection?.service?.trim() || null,
      settings,
      presetId: null,
      inherited: true,
      // No preset, so no preset values: the parent's model answers with its own defaults.
      runtimeSettings: { standard: {}, providerOptions: {} },
    }
  }

  const presetId = subagent.primary_model_preset_id?.trim() ?? ''
  if (!presetId) {
    const name = subagent.displayName?.trim() || 'This Subagent'
    throw new SubagentModelSelectionError(
      `${name}'s model (${ownModel}) was saved before Batshit kept which connection it uses, so Batshit will not guess one. Open Settings → Agents → ${name} and pick its model again.`,
    )
  }

  const preset = await loadRuntimeModelPreset(presetId, 'Subagent')
  const selection = resolveRuntimeModelSelection({
    preset,
    presetId,
    provider: subagent.primary_model_provider ?? null,
    modelId: ownModel,
    connection: subagent.primary_model_connection ?? null,
    settings,
  })
  const resolvedIds = resolveModelIds({
    developerId: selection.provider,
    modelId: selection.modelId,
    effectiveModelId: selection.effectiveModelId,
    connection: selection.connection,
  })
  // BL-800: the same mapper, with the same inputs, a primary's send builds its request from
  // (`send-routed`). A Subagent that names a preset takes its values from the preset alone (BL-515),
  // so no `primary_model_*` fallbacks ride along.
  const runtimeSettings = withoutRequestCacheSetting(
    buildRuntimeModelSettings({
      provider: selection.provider,
      modelId: selection.modelId,
      vercelId: null,
      connection: selection.connection,
      contextWindow: selection.contextWindow,
      capabilities: selection.capabilities,
      settings: selection.settings as Record<string, ParameterValue> | null,
    }),
  )
  return {
    modelId: resolvedIds?.effectiveModelId || selection.modelId || ownModel,
    connection: selection.connection,
    provider: selection.provider,
    settings: selection.settings,
    presetId: selection.presetId,
    inherited: false,
    runtimeSettings,
  }
}
