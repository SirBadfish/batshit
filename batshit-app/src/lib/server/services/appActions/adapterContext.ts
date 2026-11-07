import type { AdapterContext } from './managementTypes'
import {
  nativeSettingsSignal, refreshSettingsOperationAuthority,
  type SettingsManagementAdmission, type SettingsManagementContext
} from './settings/managementActor'
import { AppActionsManagementRefusal } from './settings/authority'
import { assertSettingsLifecycle } from './settings/lifecycle'

/** Server-only bridge from the admitted operation/request to finite domain leaves. */
export function createManagementAdapterContext(
  admission: SettingsManagementAdmission,
  currentContext: () => SettingsManagementContext,
  deadlineAt: number,
  extra?: { signal?: AbortSignal; assertCurrent?(): void; assertPermission?(): void }
): AdapterContext {
  const signal = extra?.signal ?? admission.signal
  function assertCurrent() {
    if (!admission.fence.lifecycle) throw new AppActionsManagementRefusal('AUTHORITY_LIFECYCLE_REQUIRED', 'Current server authority is unavailable.', 409)
    assertSettingsLifecycle(admission.fence.lifecycle)
    if (signal?.aborted || Date.now() >= deadlineAt || Date.now() >= (admission.expiresAt ?? Infinity)) {
      throw new AppActionsManagementRefusal('OPERATION_ENDED', 'The admitted request or operation has ended.', 409)
    }
    if (admission.actor.kind === 'native') nativeSettingsSignal(currentContext())
    extra?.assertPermission?.()
    extra?.assertCurrent?.()
  }
  return Object.freeze({ admission, ...(signal ? { signal } : {}), deadlineAt,
    assertCurrent,
    async refreshAuthority() {
      assertCurrent()
      await refreshSettingsOperationAuthority(admission)
      assertCurrent()
    }
  })
}
