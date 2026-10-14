import { refuse } from './catalog'
import type { LazyPanelHandle } from './owners'
import { registerSuppliedFileOwner } from './imports/registry'
import type { ImportArgs, ImportOutcome } from './imports/contracts'

export type SettingsFileShell = {
  visible(): boolean
  tab(): string
  panel(): LazyPanelHandle | undefined
  pendingHumanAction(): boolean
}
const shells = new Set<SettingsFileShell>()
let cleanup: Array<() => void> | null = null
function current(tab: string) {
  const visible = [...shells].filter(shell => shell.visible())
  if (visible.length > 1) refuse('ambiguous_settings_owner')
  const shell = visible[0]
  if (!shell) refuse('unsupported_document')
  if (shell.tab() !== tab) refuse('unsupported_target')
  if (shell.pendingHumanAction()) refuse('pending_human_action')
  const lazy = shell.panel()?.readAppActionState()
  if (lazy?.error) refuse('panel_load_failed')
  if (!lazy?.mounted || !lazy.panel) refuse('unsupported_document')
  return lazy.panel
}
function available(read: () => string) {
  try { return read() }
  catch (error) { return error instanceof Error ? error.message : 'unsupported_document' }
}
function avatarTab(args: ImportArgs['avatar.import_file']) {
  return args.entityType === 'user' ? 'user' : args.entityType === 'group' ? 'groups' : 'agents'
}
/** One fixed dispatcher over visible shells; hidden mounted panels never register uploads. */
export function registerSettingsFileShell(shell: SettingsFileShell) {
  if (shells.has(shell)) throw new Error('Settings supplied-file shell already mounted.')
  shells.add(shell)
  if (!cleanup) {
    const created: Array<() => void> = []
    try {
      created.push(registerSuppliedFileOwner('avatar.import_file', {
        available: args => available(() => current(avatarTab(args)).suppliedAvatarAvailability?.(args) ?? 'unsupported_document'),
        execute: async (args, files, context): Promise<ImportOutcome> => {
          context.check()
          const panel = current(avatarTab(args))
          if (!panel.importAppActionAvatar) refuse('unsupported_document')
          return panel.importAppActionAvatar(args, files, context)
        }
      }))
      cleanup = created
    } catch (error) { for (const remove of created) remove(); shells.delete(shell); throw error }
  }
  return () => {
    if (!shells.delete(shell)) return
    if (!shells.size) { for (const remove of cleanup ?? []) remove(); cleanup = null }
  }
}
