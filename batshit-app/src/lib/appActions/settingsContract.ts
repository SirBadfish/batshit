import { refuse } from './catalog'
import { validateInspection, validateOwnRead, validateOwnUpdate } from './settings/validation'

/** Fixed executor bindings; descriptors alone cannot register a new executable control. */
export const SETTINGS_FABRIC_CONTROLS = {
  'settings.inspect': 'sys.ui.settings_inspect',
  'settings.agent.memory.read': 'sys.ui.settings_agent_memory_read',
  'settings.agent.memory.update': 'sys.ui.settings_agent_memory_update',
  'settings.agent.identity.read': 'sys.ui.settings_agent_identity_read',
  'settings.agent.identity.update': 'sys.ui.settings_agent_identity_update'
} as const
export type SettingsActionId = keyof typeof SETTINGS_FABRIC_CONTROLS

/** Pure admission runs before the existing Fabric consent gate. Never reads an owner. */
export function parseSettingsAction(id: SettingsActionId, args: unknown) {
  switch (id) {
    case 'settings.inspect': return validateInspection(args)
    case 'settings.agent.memory.read':
    case 'settings.agent.identity.read': return validateOwnRead(args)
    case 'settings.agent.memory.update': return validateOwnUpdate(args, 'memory')
    case 'settings.agent.identity.update': return validateOwnUpdate(args, 'identity')
    default: refuse('unsupported_action')
  }
}
