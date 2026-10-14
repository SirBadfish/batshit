import { APP_ACTIONS_VERSION, P1_APP_ACTION_DESCRIPTORS, refuse } from './catalog'
import { SETTINGS_ACTION_DESCRIPTORS } from './settings/fields'
import { SETTINGS_FABRIC_CONTROLS } from './settingsContract'
import { SUPPLIED_FILE_ACTION_CATALOG } from './imports/catalog'
import { VOICE_ONLY_ACTION_DESCRIPTORS, VOICE_QUICK_ACTION_PROJECTION } from './voice/quickActionExecutor'
import { canonicalActionJson } from './protocol'
import type { AppActionCaller, AppActionDescriptor } from './family'

// Assembly references each owner's one catalog. Existing Artifact/Memory/DM/Voice
// operations remain in Fabric's scoped registry rather than being copied here.
export const APP_ACTION_FAMILIES = Object.freeze({
  views: P1_APP_ACTION_DESCRIPTORS,
  settings: SETTINGS_ACTION_DESCRIPTORS,
  suppliedFiles: SUPPLIED_FILE_ACTION_CATALOG,
  voice: VOICE_ONLY_ACTION_DESCRIPTORS
})
export { VOICE_QUICK_ACTION_PROJECTION }

function entries(caller: AppActionCaller): readonly AppActionDescriptor[] {
  if (!['developer', 'agent', 'speech'].includes(caller)) refuse('invalid_caller')
  const all: readonly AppActionDescriptor[] = Object.values(APP_ACTION_FAMILIES).flat()
  return all.filter(action => action.callers.includes(caller))
}
function execution(action: AppActionDescriptor) {
  if (action.owner === 'developer_bytes') return { transport: 'supplied_bytes', reason: 'File or byte input and a mounted owner are required; JSON/Fabric cannot execute this action.' }
  if (action.callers.length === 1 && action.callers[0] === 'speech') return { transport: 'voice_owner_only', reason: 'The existing opted-in speech owner alone admits this action.' }
  if (action.owner === 'server') {
    const controlId = SETTINGS_FABRIC_CONTROLS[action.id as keyof typeof SETTINGS_FABRIC_CONTROLS]
    if (!controlId) refuse('unsupported_action')
    return { transport: 'existing_fabric', controlId }
  }
  return { transport: 'document_transport', controlId: `sys.ui.${action.id.replace('.', '_')}` }
}
function detached<T>(value: T): T { return JSON.parse(canonicalActionJson(value)) as T }

/** Caller-filtered, bounded metadata; this function grants no execution authority. */
export function discoverAppActionFamilies(caller: AppActionCaller, options: { query?: string; limit?: number; offset?: number } = {}) {
  const { query = '', limit = 5, offset = 0 } = options
  if (typeof query !== 'string' || query.length > 128 || !Number.isInteger(limit) || limit < 1 || limit > 5 ||
    !Number.isInteger(offset) || offset < 0 || offset > 128) refuse('invalid_discovery')
  const term = query.toLowerCase()
  const matching = entries(caller).filter(action => `${action.id} ${action.label}`.toLowerCase().includes(term))
  const page = matching.slice(offset, offset + limit)
  return detached({ catalogVersion: APP_ACTIONS_VERSION, count: matching.length,
    ...(caller === 'speech' ? { projection: VOICE_QUICK_ACTION_PROJECTION } : {}),
    nextOffset: offset + page.length < matching.length ? offset + page.length : null,
    actions: page.map(action => ({ id: action.id, label: action.label, owner: action.owner,
      callers: action.callers, risk: action.risk, effects: action.effects, execution: execution(action) })) })
}
export function describeAppActionFamily(caller: AppActionCaller, id: string) {
  if (typeof id !== 'string' || id.length > 128) refuse('unsupported_action')
  const action = entries(caller).find(entry => entry.id === id)
  if (!action) refuse('unsupported_action')
  return detached({ catalogVersion: APP_ACTIONS_VERSION, ...action, execution: execution(action) })
}
