import { SETTINGS_FABRIC_CONTROLS, parseSettingsAction } from '$lib/appActions/settingsContract'
import type { SettingsActionId } from '$lib/appActions/settingsContract'

type Refusal = { code: 'CONTROL_INPUT_INVALID' | 'CONTROL_CANCELLATION_REQUIRED'; message: string }
const fixedActions = Object.entries(SETTINGS_FABRIC_CONTROLS) as Array<[SettingsActionId, string]>

/** Shared only by fixed Settings Fabric execution and its earlier API approval policy.
 * Null is no refusal, never a grant: normal scope, identity, consent and owner checks remain.
 * Signal comes from the originating server-owned run, never tool/body fields: the API lane's own
 * SDK turn signal, or on a request lane the Stop of the exact reply its run credential names
 * (BL-1314, chosen by `useControl`; a chat's running reply alone is not proof of the caller).
 */
export function settingsControlAdmission(options: {
  controlId: string
  input: unknown
  dryRun?: boolean
  abortSignal?: AbortSignal
}): Refusal | null {
  const action = fixedActions.find(([, controlId]) => controlId === options.controlId)?.[0]
  if (!action) return null
  try { parseSettingsAction(action, options.input) }
  catch { return { code: 'CONTROL_INPUT_INVALID', message: `Invalid input for "${options.controlId}".` } }
  if (!options.dryRun && action.endsWith('.update') &&
    (!(options.abortSignal instanceof AbortSignal) || options.abortSignal.aborted)) {
    return { code: 'CONTROL_CANCELLATION_REQUIRED',
      message: 'This Settings change requires the active reply’s server-owned Stop signal. Call from the running Primary Agent; a retired call cannot save.' }
  }
  return null
}
