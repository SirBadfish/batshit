import type { SavedModel } from '$lib/types/savedModels'
import { sanitizeId } from '$lib/utils/idSanitizer'
import { CLAUDE_PLAN_CONNECTION_ID, CLAUDE_PLAN_LABEL, CLAUDE_PLAN_SERVICE, claudePlanModelChoice } from '$lib/utils/claudePlanConnection'
import { assertClaudePlanIdentity, assertClaudePlanModel, assertClaudePlanPresetSettings, ClaudePlanError } from './claudePlanAdmission'

/**
 * SA-139 (D12): a Claude plan preset keeps only what Claude Code can honor: the model and, when set,
 * the effort and (on the models that allow it) Thinking. Any other saved setting is refused, never dropped. Saving needs no readiness: a preset
 * stays stored while Claude Code is signed out or missing, and every run is admitted again.
 */
export function normaliseClaudePlanPreset(payload: SavedModel): SavedModel {
  assertClaudePlanIdentity(payload.connection)
  if ((payload.purposeOverride && payload.purposeOverride !== 'chat') || (payload.purpose && payload.purpose !== 'chat')) {
    throw new ClaudePlanError('consumer_unsupported', 'Claude plan presets are chat presets for agents, Subagents, Workers and Compact.')
  }
  const settings = payload.settings ?? {}
  const modelId = assertClaudePlanModel(payload.modelId)
  assertClaudePlanPresetSettings(settings, modelId)
  const label = claudePlanModelChoice(modelId)!.label
  const preset: SavedModel = { ...payload,
    id: payload.id?.trim() || sanitizeId(`${payload.modelName || label}_${CLAUDE_PLAN_CONNECTION_ID}_${modelId}`),
    modelName: payload.modelName?.trim() || `${label} (${CLAUDE_PLAN_LABEL})`, provider: 'anthropic', modelId, effectiveModelId: modelId,
    connection: { id: CLAUDE_PLAN_CONNECTION_ID, type: 'direct', service: CLAUDE_PLAN_SERVICE, useDeveloperPrefix: false },
    catalogModelId: undefined, vercelSourceId: undefined, isVercelImport: false, purpose: 'chat', purposeOverride: undefined,
    pricing: {}, settings, voiceSession: undefined,
    contextWindow: typeof payload.contextWindow === 'number' && payload.contextWindow > 0 && Number.isFinite(payload.contextWindow) ? payload.contextWindow : undefined,
    compatibility: { provider: 'anthropic', batshit: true, n8n: false, label: 'batshit_only', note: 'Your own Claude Code on your Claude plan; agents, Subagents, Workers and Compact only.' },
    // Every listed Claude model reads images (P0 §A): `vision` (image input) stays true, so send-routed never refuses an
    // attachment; `image` means image generation, which the connection has not.
    capabilities: { ...payload.capabilities, streaming: true, tools: true, vision: true, audio: false, image: false }, enrichment: undefined }
  delete preset.unavailableReason
  return preset
}
