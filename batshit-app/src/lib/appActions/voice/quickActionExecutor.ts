import type { AppActionDescriptor } from '../family'
import {
  isQuickActionId,
  type QuickActionId,
  type QuickActionSettingsTab,
  type QuickActionVerdict
} from '../../utils/jevJuiceQuickActions'

/** Names only. QUICK_ACTIONS remains the sole speech judgment/mark/tell catalog. */
export const VOICE_QUICK_ACTION_PROJECTION = Object.freeze({
  stop: 'reply.stop',
  end_voice_mode: 'voice.end',
  open_goon_dock: 'goon.show',
  close_goon_dock: 'goon.hide',
  open_settings: 'settings.open',
  show_execution_viewer: 'execution.open'
} as const satisfies Record<QuickActionId, string>)

/** Metadata is not an execution grant: these never enter the developer/Fabric view bus. */
export const VOICE_ONLY_ACTION_DESCRIPTORS = [
  {
    id: 'reply.stop', label: 'Stop Reply', owner: 'browser', callers: ['speech'], risk: 'restricted',
    effects: ['stop spoken audio and queued speech', 'request current work Stop when busy'],
    undo: 'Stopped work has no lossless undo.',
    postcondition: 'Audio Stop and the current work owner are requested; a finished run is not implied.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    id: 'voice.end', label: 'End Voice Mode', owner: 'browser', callers: ['speech'], risk: 'restricted',
    effects: ['end current Direct Voice Mode', 'preserve the intentional hang-up marked turn'],
    undo: 'The user can start Voice Mode again.',
    postcondition: 'The existing Voice Mode owner ends its session and retains this commit for storage.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
] as const satisfies readonly AppActionDescriptor[]

export type VoiceQuickActionOwners = {
  stopPlayback(): void
  workBusy(): boolean
  requestWorkStop(): void
  endVoiceMode(options: { notify: true; preservePendingCommit: true }): void
  openExecutionViewer(): void
  openSettings(tab: QuickActionSettingsTab | null): void
  requestDock(id: 'open_goon_dock' | 'close_goon_dock'): void
}

/**
 * The captured Voice Mode commit admits this synchronously, before storage/send. This fixed
 * projection invokes the same owner clicks; it cannot execute an arbitrary App Action, callback,
 * settings body or Fabric control from speech. A true result means owner dispatch, not completion.
 */
export function executeVoiceQuickAction(verdict: QuickActionVerdict, owners: VoiceQuickActionOwners): boolean {
  if (!isQuickActionId(verdict.action)) return false
  switch (VOICE_QUICK_ACTION_PROJECTION[verdict.action]) {
    case 'reply.stop':
      owners.stopPlayback()
      if (owners.workBusy()) owners.requestWorkStop()
      return true
    case 'voice.end':
      owners.endVoiceMode({ notify: true, preservePendingCommit: true })
      return true
    case 'execution.open':
      owners.openExecutionViewer()
      return true
    case 'settings.open':
      owners.openSettings(verdict.tab)
      return true
    case 'goon.show':
      owners.requestDock('open_goon_dock')
      return true
    case 'goon.hide':
      owners.requestDock('close_goon_dock')
      return true
  }
}
