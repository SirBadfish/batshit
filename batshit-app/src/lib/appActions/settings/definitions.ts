import { MEMORY_MAX_LINGER_TURNS } from '$lib/utils/memoryControl'
import type { StoredSettingsSubjectKind } from './subjectTypes'
import { API_REASONING_RETENTION_MODES, WHITEBOARD_MIN_BUDGET, WHITEBOARD_MAX_BUDGET } from '$lib/utils/reasoningRetention'
import { MCP_CONFIGURATION_ID, MCP_CONFIGURATION_EFFECTS } from './mcpConfiguration'

/** User-owned gateway resources are separate from subject Settings descriptors. */
export const MCP_CONFIGURATION_DEFINITION = Object.freeze({ id: MCP_CONFIGURATION_ID, scope: 'user-resource', permission: 'mcpManagement',
  effects: MCP_CONFIGURATION_EFFECTS, owner: 'mcpGatewayService prepared normalization / existing Settings operation ledger' } as const)

export type AdoptedSettingDefinition<Id extends string = string> = Readonly<{
  id: Id
  scope: 'subjects'
  label: string
  category: 'ordinary' | 'instructions' | 'memory-settings' | 'context-management'
  permission: 'ordinary' | 'instructions' | 'memorySettings' | 'contextManagement'
  refreshFamily: 'identity' | 'instructions' | 'memory' | 'retention' | 'model-selection' | 'auto-compact' | 'voice-selection'
  effects: readonly string[]
  summaryPriority: number
  subjectKinds: readonly StoredSettingsSubjectKind[]
  subjectTypes: readonly 'api'[]
  unavailableReason: string
  fields: readonly Readonly<{ id: string; label: string; change: 'scoped-adapter' | 'report-only'; type: 'string' | 'integer' | 'boolean' | 'enum' | 'array'; nullable?: boolean; values?: readonly string[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number }>[]
  read: 'internal-projection'
  change: 'scoped-adapter'
  owner: Readonly<{ read: string; validation: string; write: string; refresh: string; inheritance: string; saveGroup: string }>
}>
function define<const Id extends string>(value: AdoptedSettingDefinition<Id>): AdoptedSettingDefinition<Id> {
  return Object.freeze({ ...value, effects: Object.freeze([...value.effects]), subjectKinds: Object.freeze([...value.subjectKinds]), subjectTypes: Object.freeze([...value.subjectTypes]),
    fields: Object.freeze(value.fields.map(field => Object.freeze({ ...field }))), owner: Object.freeze({ ...value.owner }) })
}
/** Explicit adoption only. These descriptors neither inspect storage nor authorize changes. */
const SUBJECT_SETTING_DEFINITIONS = Object.freeze([
  define({ scope: 'subjects', id: 'agent.voice.tts-selection', label: 'Configured reply voice', category: 'ordinary', permission: 'ordinary', refreshFamily: 'voice-selection', summaryPriority: 55,
    effects: ['Selects one configured voice/profile for future TTS. Explicit Fish account choices read one bounded workspace page. Held membership is observed; entitlement/readiness is unknown. Selection itself makes no network, audio, setup, playback or room call. The provider is the future audio destination and may charge when used. Speech-to-speech locks remain authoritative. Other account catalogs require a saved/static source.'],
    subjectKinds: ['primary'], subjectTypes: ['api'], unavailableReason: 'tts_primary_only', fields: [
      { id: 'selection', label: 'Selection', change: 'scoped-adapter', type: 'enum', values: ['inherit', 'provider', 'profile'] },
      { id: 'providerId', label: 'Reply Voice Provider', change: 'scoped-adapter', type: 'string', maxLength: 256 },
      { id: 'modelId', label: 'Reply Voice Model', change: 'scoped-adapter', type: 'string', nullable: true, maxLength: 256 },
      { id: 'voiceId', label: 'Reply Voice', change: 'scoped-adapter', type: 'string', nullable: true, maxLength: 256 },
      { id: 'profileId', label: 'Saved Voice Profile', change: 'scoped-adapter', type: 'string', maxLength: 256 },
      { id: 'speechToSpeechLocked', label: 'Speech-to-speech Model Lock', change: 'report-only', type: 'boolean' },
      { id: 'configuration', label: 'Provider Configured', change: 'report-only', type: 'enum', values: ['yes', 'no', 'unknown'] },
      { id: 'modelSource', label: 'Reply Voice Model Source', change: 'report-only', type: 'enum', values: ['agent', 'global', 'saved-profile', 'engine-default', 'builtin-default', 'unknown'] },
      { id: 'voiceSource', label: 'Reply Voice Source', change: 'report-only', type: 'enum', values: ['agent', 'global', 'saved-profile', 'engine-default', 'builtin-default', 'unknown'] }
    ], read: 'internal-projection', change: 'scoped-adapter', owner: { read: 'Fixed configured TTS snapshot/local sources; explicit one-subject Fish workspace report with private issued cursors', validation: 'validateConfiguredTtsChanges / planConfiguredTtsSelection / held Fish choice and current local source guard',
      write: 'Existing sparse Primary owner with original selection, source, lifecycle, authority and deadline guard', refresh: 'agent_settings_changed:voice-selection',
      inheritance: 'One coherent tuple; inherit removes selection overrides without reviving legacy aliases. Existing global/profile/engine resolver precedence remains.', saveGroup: 'Four TTS selectors and superseded identity aliases only; all STT/runtime/narration/style/extensions preserved' } }),
  define({ scope: 'subjects', id: 'agent.context.auto-compact', label: 'Auto Compact preferences', category: 'context-management', permission: 'contextManagement', refreshFamily: 'auto-compact', summaryPriority: 46,
    effects: ['Selects common Auto Compact preferences for later existing runtime decisions. This does not run Compact or Nap. Global preferences and advanced model/prompt settings are unchanged. Smart thresholds use the runtime context window; an explicit null threshold keeps that fallback.'],
    subjectKinds: ['primary'], subjectTypes: ['api'], unavailableReason: 'auto_compact_primary_only',
    fields: [{ id: 'mode', label: 'Auto Compact', change: 'scoped-adapter', type: 'enum', values: ['inherit', 'off', 'ask', 'auto'] },
      { id: 'triggerMode', label: 'Compact Trigger', change: 'scoped-adapter', type: 'enum', values: ['inherit', 'smart', 'remaining_tokens'] },
      { id: 'remainingTokens', label: 'Remaining Tokens', change: 'scoped-adapter', type: 'integer', nullable: true, minimum: 1000, maximum: 1000000 }],
    read: 'internal-projection', change: 'scoped-adapter', owner: { read: 'Fixed common Auto Compact snapshot / canonical effective resolver', validation: 'validateAutoCompactChanges / planAutoCompactChanges',
      write: 'Existing sparse Primary script with original common group and selected global dependencies', refresh: 'agent_settings_changed:auto-compact',
      inheritance: 'Explicit inherit uses global common preferences; null threshold keeps canonical smart fallback. No guessed context window.', saveGroup: 'Only requested fixed common paths; human whole saves carry original group base; advanced and unknown siblings preserved' } }),
  define({ scope: 'subjects', id: 'agent.instructions', label: 'Agent custom instructions', category: 'instructions', permission: 'instructions', refreshFamily: 'instructions', summaryPriority: 18,
    effects: ['Changes only the selected agents\' custom instructions or global-prompt inclusion for subsequent compilation, not an already-frozen reply.',
      'Global inclusion uses that target\'s existing global prompt source, including later human edits. Global/core prompt text is unchanged.'],
    subjectKinds: ['primary', 'subagent'], subjectTypes: ['api'], unavailableReason: 'stored_agent_instructions_only',
    fields: [{ id: 'customPrompt', label: 'Custom Instructions', change: 'scoped-adapter', type: 'string', nullable: true, minLength: 0, maxLength: 16384 },
      { id: 'includeGlobalPrompt', label: 'Include Global Prompt', change: 'scoped-adapter', type: 'boolean', nullable: true }],
    read: 'internal-projection', change: 'scoped-adapter', owner: {
      read: 'instructionAdapter metadata / fixed bounded instructionTextSnapshot explicit read', validation: 'validateInstructionsChanges / planInstructionsChanges',
      write: 'Fixed requested instruction leaves with original target/raw preimages, authority, lifecycle and issue deadline',
      refresh: 'agent_settings_changed:instructions / subagent_settings_changed:instructions',
      inheritance: 'Primary inclusion defaults true; Subagent false. Primary exact stored text; Subagent trimmed text or delete. Global text is never copied.',
      saveGroup: 'Only requested system_prompt/include_global_prompt leaves; explicit human baseline and no automatic dirty rebase/replay'
    } }),
  define({ scope: 'subjects', id: 'agent.model.selection', label: 'Saved model selection', category: 'ordinary', permission: 'ordinary', refreshFamily: 'model-selection', summaryPriority: 15,
    effects: ['Selects an existing owned compatible preset, or explicitly clears its selection, without a model call.',
      'Supported LiveKit speech-to-speech selection is Primary configuration for the next deliberate Connect only. It does not start, stop or reconnect a room.',
      'Clear preserves native/legacy model, reasoning, permission and Voice fields. Subagent inheritance requires no own or legacy model; no replacement runtime is promised.'],
    subjectKinds: ['primary', 'subagent'], subjectTypes: ['api'], unavailableReason: 'unsupported_model_selection_type',
    fields: [{ id: 'presetId', label: 'Saved Model', change: 'scoped-adapter', type: 'string', maxLength: 256 }],
    read: 'internal-projection', change: 'scoped-adapter', owner: {
      read: 'modelSelectionAdapter / exact owned preset selection snapshot', validation: 'validateModelSelectionChanges / modelPresetSelectionOwner',
      write: 'Existing sparse Primary/Subagent record scripts with modelSelectionMutation conditional proof',
      refresh: 'agent_settings_changed:model-selection / subagent_settings_changed:model-selection',
      inheritance: 'Explicit clear or owned selection. Only a Subagent with no own/legacy model inherits its parent model and connection at run time; Primary replacement is not promised.',
      saveGroup: 'Primary fourteen model leaves/model-owned keys with native retention; Subagent four identities in one original-base sparse CAS'
    } }),
  define({ scope: 'subjects', id: 'agent.model.preset-copy', label: 'Named model preset copy and assignment', category: 'ordinary', permission: 'ordinary', refreshFamily: 'model-selection', summaryPriority: 16,
    effects: ['Creates one visible named copy, then assigns only the admitted selected targets. The original preset is unchanged.',
      'Only offered typed parameters can change. Unknown inherited fields remain private. Native readiness and actual execution are unknown.',
      'A saved copy survives partial or blocked assignment. Unknown creation stops assignment; no automatic retry, rollback or deletion.'],
    subjectKinds: ['primary', 'subagent'], subjectTypes: ['api'], unavailableReason: 'unsupported_model_selection_type',
    fields: [{ id: 'sourcePresetId', label: 'Original Saved Model', change: 'scoped-adapter', type: 'string', maxLength: 256 },
      { id: 'copyName', label: 'New Saved Model Name', change: 'scoped-adapter', type: 'string', maxLength: 200 },
      { id: 'parameters', label: 'Typed Parameter Changes', change: 'scoped-adapter', type: 'array' }],
    read: 'internal-projection', change: 'scoped-adapter', owner: {
      read: 'Original bounded owned preset copy snapshot and original target model/native reads', validation: 'validateModelPresetCopyChanges / actual parameter definitions and source-bound plan',
      write: 'Conditional model storage create and post-replacement handoff, then existing A3 sparse assignment in one operation',
      refresh: 'model_presets_changed / existing model-selection target events with pure stored projection',
      inheritance: 'Faithful original preset copy; unset removes only an offered leaf; native precedence and all other controls retained.',
      saveGroup: 'One reserved copy identity plus exact selected A3 targets; unknown effects never replay'
    } }),
  define({ scope: 'subjects', id: 'agent.identity', label: 'Agent name', category: 'ordinary', permission: 'ordinary', refreshFamily: 'identity',
    effects: ['Save agent display names; agent IDs, Subagent slugs and access stay unchanged.'], summaryPriority: 10,
    subjectKinds: ['primary', 'subagent'], subjectTypes: ['api'], unavailableReason: 'unsupported_subject_type', fields: [{ id: 'displayName', label: 'Display Name', change: 'scoped-adapter', type: 'string', maxLength: 200 }],
    read: 'internal-projection', change: 'scoped-adapter', owner: {
      read: 'appActions/settings/report identity projection', validation: 'validateIdentityChanges',
      write: 'createSettingsChanges / admittedAgentSettings / conditionalAgentSettings (Primary and Subagent identity)',
      refresh: 'agent_settings_changed:identity / subagent_settings_changed:identity',
      inheritance: 'No inherited agent name; invalid or absent is unknown.', saveGroup: 'displayName only; never id or slug'
    } }),
  define({ scope: 'subjects', id: 'agent.memory.preferences', label: 'Agent Memory preferences', category: 'memory-settings', permission: 'memorySettings', refreshFamily: 'memory',
    effects: ['Changes Memory enablement, budgets, linger or the automatic window for future replies. Disabling preserves stored memories. Automatic window changes only floor/headroom modes and retains numeric, nap, idle and summary choices. Enablement requires an already-ready builtin or valid configured external embedder; external availability is checked when used. This never prepares, downloads or runs a Nap.'], summaryPriority: 20,
    subjectKinds: ['primary'], subjectTypes: ['api'], unavailableReason: 'memory_is_primary_only', fields: [
      { id: 'enabled', label: 'Memory Enabled', change: 'scoped-adapter', type: 'boolean' },
      { id: 'windowMode', label: 'Memory Window', change: 'scoped-adapter', type: 'enum', values: ['auto'] },
      { id: 'floorMode', label: 'Memory Window Floor', change: 'report-only', type: 'enum', values: ['auto', 'custom'] },
      { id: 'ceilingHeadroomMode', label: 'Memory Window Headroom', change: 'report-only', type: 'enum', values: ['auto', 'custom'] },
      { id: 'onMyMind', label: 'On My Mind Budget', change: 'scoped-adapter', type: 'integer', minimum: 0, maximum: 20000 },
      { id: 'triggers', label: 'Trigger Budget', change: 'scoped-adapter', type: 'integer', minimum: 0, maximum: 20000 },
      { id: 'recalled', label: 'Recall Budget', change: 'scoped-adapter', type: 'integer', minimum: 0, maximum: 20000 },
      { id: 'triggerLingerTurns', label: 'STM Trigger Linger Default', change: 'scoped-adapter', type: 'integer', minimum: 0, maximum: MEMORY_MAX_LINGER_TURNS },
      { id: 'recallLingerTurns', label: 'Recall Linger', change: 'scoped-adapter', type: 'integer', minimum: 0, maximum: MEMORY_MAX_LINGER_TURNS }
    ], read: 'internal-projection', change: 'scoped-adapter', owner: {
      read: 'memoryControl resolvers', validation: 'validateMemoryChanges / memoryControl',
      write: 'createSettingsChanges / admittedAgentSettings / conditionalAgentSettings (fixed Primary-only preferences and ready-only enablement)',
      refresh: 'agent_settings_changed:memory', inheritance: 'Agent canonical/legacy values; factory defaults from memoryControl.',
      saveGroup: 'Fixed requested leaves; enabled aliases/window modes and original human expectedMemory guarded; no preparation or custom tuning.'
    } }),
  define({ scope: 'subjects', id: 'agent.reasoning.presentation', label: 'API reasoning display', category: 'ordinary', permission: 'ordinary', refreshFamily: 'retention', summaryPriority: 30,
    effects: ['Changes how reasoning and Whiteboard are displayed. Unset display preferences use the factory defaults: Display Reasoning on and Display Whiteboard on. Capture, saved reasoning and the Whiteboard contents are unchanged.'],
    subjectKinds: ['primary'], subjectTypes: ['api'], unavailableReason: 'api_primary_only', fields: [
      { id: 'displayReasoning', label: 'Display Reasoning', change: 'scoped-adapter', type: 'boolean', nullable: true },
      { id: 'displayWhiteboard', label: 'Display Whiteboard', change: 'scoped-adapter', type: 'boolean', nullable: true }
    ], read: 'internal-projection', change: 'scoped-adapter', owner: {
      read: 'API presentation resolver / shouldShowReasoningByDefaultForPrimaryAgent', validation: 'validateApiPresentationChanges',
      write: 'admittedAgentSettings / conditionalAgentSettings API presentation', refresh: 'agent_settings_changed:retention',
      inheritance: 'Per-agent; null/absent uses each display field factory default.', saveGroup: 'Independent display leaves; no retention/content write'
    } }),
  define({ scope: 'subjects', id: 'agent.reasoning.retention', label: 'API reasoning retention', category: 'context-management', permission: 'contextManagement', refreshFamily: 'retention', summaryPriority: 40,
    effects: ['Changes completed-reply reasoning retention and Whiteboard context for future replies. An unset retention mode uses Whiteboard only (Preserve off); an unset Whiteboard budget uses 1,500 tokens. Saved Whiteboard text is preserved, including when its budget is lowered.'],
    subjectKinds: ['primary'], subjectTypes: ['api'], unavailableReason: 'api_primary_only', fields: [
      { id: 'mode', label: 'Reasoning Retention', change: 'scoped-adapter', type: 'enum', values: API_REASONING_RETENTION_MODES, nullable: true },
      { id: 'whiteboardBudgetTokens', label: 'Whiteboard Budget', change: 'scoped-adapter', type: 'integer', minimum: WHITEBOARD_MIN_BUDGET, maximum: WHITEBOARD_MAX_BUDGET, nullable: true }
    ], read: 'internal-projection', change: 'scoped-adapter', owner: {
      read: 'resolveApiReasoningRetention', validation: 'validateApiRetentionChanges / validateReasoningRetentionSave',
      write: 'admittedAgentSettings / conditionalAgentSettings API retention', refresh: 'agent_settings_changed:retention',
      inheritance: 'Per-agent only; null/absent restores factory Whiteboard only and 1500. No global or legacy Preserve mapping.', saveGroup: 'Only requested retention/budget leaves; no board content or provider changes'
    } })
] as const)

/** One adopted metadata catalogue. Domain bindings import it; no second label/category map. */
export const ADOPTED_APP_ACTIONS_DEFINITIONS = Object.freeze([
  ...SUBJECT_SETTING_DEFINITIONS,
  Object.freeze({ id: 'agent.skills.access', scope: 'alias-access', label: 'Existing skill access',
    category: 'management', permission: 'skillAccess', refreshFamily: 'slash-commands', summaryPriority: 50,
    effects: Object.freeze(['Updates which selected agents can load these existing skills on their next skill load. Skill content, trust and already loaded instructions stay unchanged.']),
    read: 'internal-projection', change: 'scoped-adapter', owner: Object.freeze({
      read: 'skillAccessReport / complete current alias catalogue', validation: 'parseSkillAccessQuery / parseSkillAccessChange / conditionalSkillAccess',
      write: 'skillAccessOperations / conditionalSkillAccess / slashCommandRevision', refresh: 'slash_commands_changed',
      inheritance: 'Effective access is the OR of current active invocable aliases; universal conversion requires explicit whole-population authority.',
      saveGroup: 'Complete server-held alias/effect closure; no caller alias IDs, paths, bodies or new subjects'
    }) } as const),
  Object.freeze({ id: 'runtime.inspection', scope: 'instance-read', label: 'Runtime status',
    category: 'management', permission: 'runtimeManagement', refreshFamily: null, summaryPriority: 60,
    effects: Object.freeze(['Reads bounded reported status for this Batshit instance. It does not start, install, stop or repair a runtime.']),
    read: 'internal-projection', change: 'report-only', owner: Object.freeze({
      read: 'appActions/runtimeInspection / existing fixed runtime status owners', validation: 'runtimeInspection finite DTO projection',
      write: 'No mutation', refresh: 'Fresh read with current actor and runtime-management authority',
      inheritance: 'Instance read independent of agent subject scope; reported evidence is not readiness proof.',
      saveGroup: 'No subject, operation, settings write or executable runtime control'
    }) } as const)
] as const)
export type AppActionsSemanticId = typeof ADOPTED_APP_ACTIONS_DEFINITIONS[number]['id']
export type SettingsChangeId = Extract<typeof ADOPTED_APP_ACTIONS_DEFINITIONS[number], { change: 'scoped-adapter' }>['id']
export const SETTINGS_CHANGE_IDS: readonly SettingsChangeId[] = Object.freeze(ADOPTED_APP_ACTIONS_DEFINITIONS.filter(definition => definition.change === 'scoped-adapter').map(definition => definition.id))
export const ADOPTED_SETTINGS_DEFINITIONS = Object.freeze(ADOPTED_APP_ACTIONS_DEFINITIONS.filter(
  (definition): definition is typeof SUBJECT_SETTING_DEFINITIONS[number] => definition.scope === 'subjects'))
export function appActionsDefinition(id: AppActionsSemanticId) {
  const definition = ADOPTED_APP_ACTIONS_DEFINITIONS.find(item => item.id === id)
  if (!definition) throw new Error(`Unadopted App Actions definition: ${id}`)
  return definition
}

export type SettingsReportId = typeof ADOPTED_SETTINGS_DEFINITIONS[number]['id']
export const SETTINGS_REPORT_IDS: readonly SettingsReportId[] = Object.freeze(ADOPTED_SETTINGS_DEFINITIONS.map(definition => definition.id))

export function assertSettingsDefinitionCoverage(definitions: readonly AdoptedSettingDefinition[] = ADOPTED_SETTINGS_DEFINITIONS): void {
  const seen = new Set<string>()
  for (const definition of definitions) {
    if (!(SETTINGS_REPORT_IDS as readonly string[]).includes(definition.id)) throw new Error(`Unrecognized adopted setting id: ${definition.id}`)
    if (seen.has(definition.id) || !definition.fields.length || !definition.subjectKinds.length ||
      definition.read !== 'internal-projection' || definition.change !== 'scoped-adapter' || !definition.effects.length ||
      !definition.permission || !definition.refreshFamily ||
      definition.fields.some(field => !field.label.trim() || field.change !== 'scoped-adapter' && field.change !== 'report-only') ||
      ['read', 'validation', 'write', 'refresh', 'inheritance', 'saveGroup'].some(key => !definition.owner[key as keyof typeof definition.owner]?.trim())) {
      throw new Error(`Incomplete adopted setting definition: ${definition.id}`)
    }
    seen.add(definition.id)
    if (new Set(definition.fields.map(field => field.id)).size !== definition.fields.length) throw new Error(`Duplicate setting field: ${definition.id}`)
  }
  if (seen.size !== SETTINGS_REPORT_IDS.length) throw new Error('Incomplete adopted setting coverage.')
}
export function settingsFieldDefinition(id: SettingsReportId, fieldId: string) {
  const field = ADOPTED_SETTINGS_DEFINITIONS.find(definition => definition.id === id)?.fields.find(field => field.id === fieldId)
  if (!field) throw new Error(`Unadopted Settings field: ${id}/${fieldId}`)
  return field
}

export function settingsDefinition(id: SettingsReportId): AdoptedSettingDefinition<SettingsReportId> {
  const definition = ADOPTED_SETTINGS_DEFINITIONS.find(item => item.id === id)
  if (!definition) throw new Error(`Unadopted Settings definition: ${id}`)
  return definition
}

/** Static per-feature JSON schema from the same adopted field metadata. */
export function settingsChangeProperties() {
  const entries = ADOPTED_SETTINGS_DEFINITIONS.flatMap(definition => definition.fields
    .filter(field => field.change === 'scoped-adapter').map(field => {
      const shape = field.type === 'enum' ? { type: 'string', enum: field.values } : { type: field.type,
        ...(field.minimum !== undefined ? { minimum: field.minimum } : {}), ...(field.maximum !== undefined ? { maximum: field.maximum } : {}),
        ...(field.maxLength !== undefined ? { minLength: field.minLength ?? 1, maxLength: field.maxLength } : {}) }
      return [field.id, field.nullable ? { anyOf: [shape, { type: 'null' }] } : shape]
    }))
  const grouped = new Map<string, unknown[]>()
  for (const [id, shape] of entries) grouped.set(id as string, [...(grouped.get(id as string) ?? []), shape])
  return { ...Object.fromEntries([...grouped].map(([id, shapes]) => [id, shapes.length === 1 ? shapes[0] : { anyOf: shapes }])),
    clear: { type: 'boolean', const: true, description: 'agent.model.selection only: use exactly {clear:true} OR {presetId}, never both. Clear has no replacement runtime or profile effect.' } }
}
