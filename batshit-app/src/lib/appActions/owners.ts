import type { ActionArgs, ActionId, SettingsTarget } from './catalog'
import { refuse } from './catalog'
import type { ImportArgs, ImportOutcome } from './imports/contracts'
import type { ActionContext, ActionOutcome } from './actionTypes'

export type { ActionContext, ActionOutcome } from './actionTypes'
export type ActionHandler = (args: ActionArgs, context: ActionContext) => Promise<ActionOutcome>
export type SettingsPanelState = {
  entityId?: string | null
  toolsTab?: string
  busy: boolean
  dirty: boolean
  error?: string | null
}
export type SettingsPanelHandle = {
  readAppActionState(): SettingsPanelState
  selectAppActionTarget?(target: SettingsTarget, context: ActionContext): void
  suppliedAvatarAvailability?(args: ImportArgs['avatar.import_file']): string
  importAppActionAvatar?(args: ImportArgs['avatar.import_file'], files: File[], context: ActionContext): Promise<ImportOutcome>
  suppliedFileAvailability?(id: 'goon.import_file' | 'goon.replace_vrm_file', args: ImportArgs['goon.import_file'] | ImportArgs['goon.replace_vrm_file']): string
  importAppActionGoonFile?(args: ImportArgs['goon.import_file'], files: File[], context: ActionContext): Promise<ImportOutcome>
  importAppActionVrmFile?(args: ImportArgs['goon.replace_vrm_file'], files: File[], context: ActionContext): Promise<ImportOutcome>
}
export type LazyPanelHandle = {
  readAppActionState(): { mounted: boolean; error: string | null; panel: SettingsPanelHandle | null }
}

// Registered only by mounted browser owners. No remote transport or server authority.
const handlers = new Map<ActionId, ActionHandler>()
const availability = new Map<ActionId, () => string>()
const observations = new Map<string, () => Record<string, unknown>>()
const drafts = new Set<() => boolean>()
const navigation = new Set<() => void>()
export const APP_ACTIONS_SETTINGS_DRAFT_SCOPE = Symbol('Settings App Actions draft scope')
export function registerAppAction(id: ActionId, handler: ActionHandler, available: () => string = () => 'available') {
  if (handlers.has(id)) throw new Error(`App Action owner already mounted: ${id}`)
  handlers.set(id, handler)
  availability.set(id, available)
  return () => { if (handlers.get(id) === handler) { handlers.delete(id); availability.delete(id) } }
}
export function appActionHandler(id: ActionId) { return handlers.get(id) }
export function appActionAvailability(id: ActionId) { return availability.get(id)?.() ?? 'unsupported_document' }
export function registerAppActionObservation(owner: 'settings' | 'dock' | 'execution', read: () => Record<string, unknown>) {
  observations.set(owner, read)
  return () => { if (observations.get(owner) === read) observations.delete(owner) }
}
export function appActionObservation() {
  return Object.fromEntries([...observations].map(([owner, read]) => [owner, read()]))
}

type SettingsActionObservation = {
  open: boolean
  tab: string
  devAvailable: boolean
  toolsTab: string | null
  dirty: boolean
  pendingHumanAction: boolean
}
type SettingsActionOwner = {
  observation(): SettingsActionObservation
  openAction: ActionHandler
  closeAction: ActionHandler
  available(id: 'settings.open' | 'settings.close'): string
}
// The sidebar and both composer selectors each mount their own SettingsPanel.
// Keep one paired dispatcher; use the visible panel, or the first mounted panel
// when all are closed. Never open another sheet over an ambiguous human view.
const settingsOwners = new Set<SettingsActionOwner>()
let settingsDispatchCleanup: Array<() => void> | null = null
function settingsOwnerSelection() {
  const opened = [...settingsOwners].filter(owner => owner.observation().open)
  return { ambiguous: opened.length > 1, owner: opened[0] ?? settingsOwners.values().next().value }
}
export function registerSettingsAppActionOwner(owner: SettingsActionOwner) {
  if (settingsOwners.has(owner)) throw new Error('Settings App Action owner already registered')
  settingsOwners.add(owner)
  if (!settingsDispatchCleanup) {
    const cleanup: Array<() => void> = []
    try {
      for (const id of ['settings.open', 'settings.close'] as const) {
        cleanup.push(registerAppAction(id, (args, context) => {
          context.check()
          const selected = settingsOwnerSelection()
          if (selected.ambiguous) refuse('ambiguous_settings_owner')
          if (!selected.owner) refuse('unsupported_document')
          return (id === 'settings.open' ? selected.owner.openAction : selected.owner.closeAction)(args, context)
        }, () => {
          const selected = settingsOwnerSelection()
          return selected.ambiguous ? 'ambiguous_settings_owner'
            : selected.owner?.available(id) ?? 'unsupported_document'
        }))
      }
      cleanup.push(registerAppActionObservation('settings', () => {
        const selected = settingsOwnerSelection()
        if (!selected.ambiguous) return selected.owner?.observation() ?? { open: false }
        const opened = [...settingsOwners].map(entry => entry.observation()).filter(entry => entry.open)
        return { open: true, tab: null, toolsTab: null,
          devAvailable: opened.some(entry => entry.devAvailable),
          dirty: opened.some(entry => entry.dirty),
          pendingHumanAction: opened.some(entry => entry.pendingHumanAction) }
      }))
      settingsDispatchCleanup = cleanup
    } catch (error) {
      for (const remove of cleanup) remove()
      settingsOwners.delete(owner)
      throw error
    }
  }
  return () => {
    if (!settingsOwners.delete(owner)) return
    if (!settingsOwners.size) {
      for (const remove of settingsDispatchCleanup ?? []) remove()
      settingsDispatchCleanup = null
    }
  }
}
export function registerAppActionDraft(read: () => boolean) {
  drafts.add(read)
  return () => { drafts.delete(read) }
}
export function appActionsHaveDrafts() { return [...drafts].some(read => read()) }
export function onAppActionNavigation(callback: () => void) {
  navigation.add(callback)
  return () => { navigation.delete(callback) }
}
export function retireAppActionNavigation() { for (const callback of navigation) callback() }

export type DockPorts = {
  desktop(): 'active' | 'transitioning' | 'inactive'
  confirmed(): boolean
  visible(): boolean
  apply(open: boolean): void
  persist(open: boolean, context: ActionContext): Promise<'saved' | 'failed' | 'unknown'>
  mounted(open: boolean): boolean
}
/** Ordinary Dock only. Refusal and matching-state checks precede visibility and persistence. */
export async function performDockAction(open: boolean, ports: DockPorts, context: ActionContext): Promise<ActionOutcome> {
  context.check()
  const desktop = ports.desktop()
  if (desktop !== 'inactive') refuse(desktop === 'active' ? 'desktop_mode_active' : 'desktop_transitioning')
  if (ports.visible() === open) {
    await context.wait(() => ports.mounted(open) ? true : undefined)
    return { status: 'no_op', visible: 'unchanged', saved: 'not_requested' }
  }
  if (!ports.confirmed()) refuse('settings_unconfirmed')
  if (appActionsHaveDrafts()) refuse('unsaved_changes')
  context.check()
  context.effect()
  ports.apply(open)
  context.report({ status: 'unknown_outcome', visible: 'applied', saved: 'not_requested' })
  context.check()
  // Persistence is requested at dispatch, before its response can be interrupted.
  context.report({ status: 'unknown_outcome', visible: 'applied', saved: 'unknown' })
  const saved = await ports.persist(open, context)
  context.report({ status: 'unknown_outcome', visible: 'applied', saved })
  await context.wait(() => ports.visible() === open && ports.mounted(open) ? true : undefined)
  context.check()
  return { status: saved === 'saved' ? 'completed' : saved === 'failed' ? 'failed' : 'unknown_outcome',
    reason: saved === 'saved' ? undefined : 'dock_preference_unconfirmed', visible: 'applied', saved }
}
