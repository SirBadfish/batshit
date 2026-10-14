import type { SettingsTab } from '$lib/appActions/catalog'
import { SETTINGS_FIELDS, type SettingsFieldDescriptor, type SettingsScalar } from '$lib/appActions/settings/fields'
import { refuseSettings, validateInspection, type SettingsOwnerContext } from '$lib/appActions/settings/validation'
import type { SettingsRead } from './conditionalAgentSettings'
import type { MemoryPreferenceValues } from '$lib/appActions/settings/validation'
import { normalizeVoiceSettings } from '$lib/utils/voiceSchema'

type FieldState = 'value' | 'unset' | 'masked' | 'human_only' | 'unavailable'
export type SettingsFieldRead = SettingsFieldDescriptor & { state: FieldState; value?: SettingsScalar }
export type SettingsInspection = {
  tab: SettingsTab
  availability: 'read_only' | 'human_only' | 'unavailable' | 'not_implemented'
  fields: SettingsFieldRead[]
  subjectAgentId?: string
  revision?: string
  reason?: string
  basis: 'saved_fields' | 'effective_agent_settings' | 'owner_inventory' | 'capability_boundary'
}
export type SettingsInspectionSources = {
  userSettings?: unknown
  entityCount?: number
  agent?: { displayName: string; agentType: 'api' | 'cli' }
  memory?: SettingsRead<MemoryPreferenceValues>
  unavailableFields?: readonly string[]
}
function admitted(value: unknown, type: 'boolean' | 'integer' | 'string', values?: readonly string[]): SettingsScalar | undefined {
  if (typeof value !== type && !(type === 'integer' && typeof value === 'number' && Number.isInteger(value))) return undefined
  if (typeof value === 'string' && (value.length > 200 || !value.isWellFormed() || values && !values.includes(value))) return undefined
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || value > 1_000_000)) return undefined
  return value as SettingsScalar
}

/** A pure projection; unknown source fields can never enter the returned object. */
export function projectSettingsInspection(tab: SettingsTab, sources: SettingsInspectionSources, actorKind: 'agent' | 'developer'): SettingsInspection {
  const values: Record<string, SettingsScalar | undefined> = {}
  const invalid = new Set<string>()
  function savedObject(value: unknown, affectedFields: readonly string[]): Record<string, unknown> {
    // The owning saved readers treat an absent/null block as unset; a stored
    // scalar or array is unreadable and must never look like an empty record.
    if (value === undefined || value === null) return {}
    if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    for (const field of affectedFields) invalid.add(field)
    return {}
  }
  function assign(id: string, raw: unknown, type: 'boolean' | 'integer' | 'string', options?: readonly string[]) {
    values[id] = admitted(raw, type, options)
    if (raw !== undefined && raw !== null && values[id] === undefined) invalid.add(id)
  }
  const user = savedObject(sources.userSettings, SETTINGS_FIELDS[tab].filter(field => field.access === 'read_only' || field.access === 'own_agent').map(field => field.id))
  let basis: SettingsInspection['basis'] = 'saved_fields'
  switch (tab) {
    case 'agents':
      basis = 'effective_agent_settings'
      assign('displayName', sources.agent?.displayName, 'string')
      assign('agentType', sources.agent?.agentType, 'string', ['api', 'cli'])
      break
    case 'memory':
      basis = 'effective_agent_settings'
      values.enabled = admitted(sources.memory?.memoryEnabled, 'boolean')
      values.onMyMind = admitted(sources.memory?.values.onMyMind, 'integer')
      values.triggers = admitted(sources.memory?.values.triggers, 'integer')
      values.recalled = admitted(sources.memory?.values.recalled, 'integer')
      values.triggerLingerTurns = admitted(sources.memory?.values.triggerLingerTurns, 'integer')
      values.recallLingerTurns = admitted(sources.memory?.values.recallLingerTurns, 'integer')
      break
    case 'groups': case 'models': case 'projects': case 'artifacts':
      basis = 'owner_inventory'; assign('entityCount', sources.entityCount, 'integer'); break
    case '3d-goons':
      basis = 'owner_inventory'
      assign('entityCount', sources.entityCount, 'integer')
      assign('dockOpen', savedObject(user.goons_settings, ['dockOpen']).dockOpen, 'boolean')
      break
    case 'tools': {
      const zip = savedObject(user.global_zip_settings, ['zipViewMode', 'toolNotes'])
      assign('zipViewMode', zip.zip_ai_view_mode, 'string', ['inline', 'appended'])
      assign('toolNotes', zip.zip_tool_notes_enabled, 'boolean')
      break
    }
    case 'voice': {
      const voice = savedObject(user.voice_settings, ['lipSyncMode'])
      const lip = savedObject(voice.goonLipSync, ['lipSyncMode'])
      const rawMode = voice.goonLipSync !== undefined && voice.goonLipSync !== null ? lip.mode : voice.goonLipSyncMode
      assign('lipSyncMode', rawMode, 'string', ['amplitude', 'viseme'])
      const namesMode = voice.goonLipSync !== undefined && voice.goonLipSync !== null ? Object.hasOwn(lip, 'mode') : Object.hasOwn(voice, 'goonLipSyncMode')
      if (namesMode && rawMode !== 'amplitude' && rawMode !== 'viseme') invalid.add('lipSyncMode')
      if (values.lipSyncMode !== undefined && !invalid.has('lipSyncMode')) values.lipSyncMode = normalizeVoiceSettings({ goonLipSync: { mode: rawMode } }).goonLipSync?.mode
      break
    }
    case 'clips': {
      const ui = savedObject(user.ui_settings, ['compressImages', 'compressionQuality', 'maxImageSize', 'forceJpeg'])
      assign('compressImages', ui.compress_images, 'boolean')
      const quality = admitted(ui.compression_quality, 'integer')
      values.compressionQuality = typeof quality === 'number' && quality >= 10 && quality <= 100 ? quality : undefined
      if (ui.compression_quality !== undefined && ui.compression_quality !== null && values.compressionQuality === undefined) invalid.add('compressionQuality')
      assign('maxImageSize', ui.max_image_size, 'string', ['none', '512', '768', '1024', '1280', '1536', '2048'])
      assign('forceJpeg', ui.force_jpeg, 'boolean')
      break
    }
    case 'user':
      if (actorKind === 'developer') assign('displayName', user.displayName, 'string')
      break
    case 'slash-commands': case 'icons': case 'theme': case 'local-ai': case 'api-keys': case 'admin': case 'dev':
      basis = 'capability_boundary'; break
  }
  const fields: SettingsFieldRead[] = SETTINGS_FIELDS[tab].map((descriptor: SettingsFieldDescriptor) => {
    if (sources.unavailableFields?.includes(descriptor.id)) return { ...descriptor, state: 'unavailable', reason: 'User-owned library counts require a developer caller.' }
    if (tab === 'user' && actorKind === 'agent' && descriptor.id === 'displayName') return { ...descriptor, state: 'masked', reason: 'User profile identity is not supplied to agents.' }
    if (descriptor.access === 'masked' || descriptor.access === 'human_only' || descriptor.access === 'unavailable') return { ...descriptor, state: descriptor.access }
    if (invalid.has(descriptor.id)) return { ...descriptor, state: 'unavailable', reason: 'unsupported_saved_value' }
    const value = values[descriptor.id]
    return value === undefined ? { ...descriptor, state: 'unset' } : { ...descriptor, state: 'value', value }
  })
  return {
    tab, fields, basis,
    availability: tab === 'theme' ? 'not_implemented' : fields.every(field => field.state === 'human_only') ? 'human_only' :
      fields.some(field => field.state === 'unavailable') && fields.every(field => ['unavailable', 'human_only', 'masked'].includes(field.state)) ? 'unavailable' : 'read_only',
    ...(sources.memory ? { subjectAgentId: sources.memory.subjectAgentId, revision: sources.memory.revision } : {})
  }
}

export type SettingsInspectionStore = {
  readUserSettings(userId: string): Promise<unknown>
  countEntities(tab: 'groups' | 'models' | 'projects' | 'artifacts' | '3d-goons', userId: string): Promise<number>
  readAgent(subjectAgentId: string, userId: string): Promise<{ displayName: string; agentType: 'api' | 'cli' }>
  readMemory(args: unknown, context: SettingsOwnerContext): Promise<SettingsRead<MemoryPreferenceValues>>
}
export function createSettingsInspector(store: SettingsInspectionStore) {
  return async (args: unknown, context: SettingsOwnerContext): Promise<SettingsInspection> => {
    const request = validateInspection(args)
    context.check()
    if ((context.actor.kind !== 'agent' && context.actor.kind !== 'developer') || typeof context.actor.userId !== 'string' || !context.actor.userId) refuseSettings('unauthorized')
    const { tab } = request
    // Protected tabs never read their source records, even for a developer.
    if (['api-keys', 'admin', 'dev', 'theme', 'local-ai', 'icons', 'slash-commands'].includes(tab)) return projectSettingsInspection(tab, {}, context.actor.kind)
    const sources: SettingsInspectionSources = {}
    try {
      if (tab === 'agents' || tab === 'memory') {
        const subjectAgentId = request.subjectAgentId ?? context.actor.actingAgentId
        if (!subjectAgentId) refuseSettings('subject_agent_required')
        if (context.actor.kind === 'agent' && subjectAgentId !== context.actor.actingAgentId) refuseSettings('own_agent_required')
        if (tab === 'agents') sources.agent = await store.readAgent(subjectAgentId, context.actor.userId)
        else if (context.actor.kind === 'agent') sources.memory = await store.readMemory({ subjectAgentId }, context)
        else return { ...projectSettingsInspection(tab, {}, 'developer'), availability: 'unavailable', reason: 'Own-agent memory inspection requires a server-vouched acting Primary Agent.', fields: SETTINGS_FIELDS.memory.map(field => ({ ...field, state: field.access === 'human_only' ? 'human_only' : 'unavailable' })) }
      }
      if (['groups', 'models', 'projects', 'artifacts', '3d-goons'].includes(tab)) {
        if (context.actor.kind === 'agent') {
          if (tab !== '3d-goons') return { ...projectSettingsInspection(tab, {}, 'agent'), availability: 'unavailable', reason: 'User-owned library counts require a developer caller; agents use existing scoped Fabric discovery.', fields: SETTINGS_FIELDS[tab].map(field => ({ ...field, state: field.access === 'masked' || field.access === 'human_only' ? field.access : 'unavailable' })) }
          sources.unavailableFields = ['entityCount']
        } else sources.entityCount = await store.countEntities(tab as 'groups' | 'models' | 'projects' | 'artifacts' | '3d-goons', context.actor.userId)
      }
      if (['tools', 'voice', 'clips', 'user', '3d-goons'].includes(tab)) sources.userSettings = await store.readUserSettings(context.actor.userId)
      context.check()
      const result = projectSettingsInspection(tab, sources, context.actor.kind)
      if (request.subjectAgentId && tab === 'agents') result.subjectAgentId = request.subjectAgentId
      return result
    } catch (error) {
      // Authentication/expiry refusals must remain refusals. A data-source
      // outage is visibly unavailable, never a successful empty/default read.
      if (error instanceof Error && error.name === 'SettingsActionRefusal') throw error
      context.check()
      return { ...projectSettingsInspection(tab, {}, context.actor.kind), availability: 'unavailable', reason: 'settings_source_unavailable',
        fields: SETTINGS_FIELDS[tab].map(field => ({ ...field, state: field.access === 'masked' || field.access === 'human_only' ? field.access : 'unavailable' })) }
    }
  }
}
