/** The existing request/turn restore-work owner. Importing it performs no I/O. */
let backupRestoreMaintenanceActive = false
let backupRestoreHttpRequestCount = 0
const backupRestoreRequestDrainWaiters = new Set<() => void>()

/** Only the existing maintenance wrapper changes the flag; request/turn callers own releases. */
export const backupRestoreActivity = {
  get maintenanceActive() { return backupRestoreMaintenanceActive },
  set maintenanceActive(value: boolean) { backupRestoreMaintenanceActive = value },
  get httpRequestCount() { return backupRestoreHttpRequestCount }
}

export function notifyBackupRestoreRequestDrainWaiters() {
  for (const waiter of backupRestoreRequestDrainWaiters) waiter()
  backupRestoreRequestDrainWaiters.clear()
}

export function enterBackupRestoreHttpRequest() {
  if (backupRestoreMaintenanceActive) return null
  backupRestoreHttpRequestCount += 1
  let released = false
  return () => {
    if (released) return
    released = true
    backupRestoreHttpRequestCount = Math.max(0, backupRestoreHttpRequestCount - 1)
    notifyBackupRestoreRequestDrainWaiters()
  }
}

export function waitForBackupRestoreRequestDrain(timeoutMs: number) {
  return new Promise<void>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      backupRestoreRequestDrainWaiters.delete(finish)
      resolve()
    }
    timer = setTimeout(finish, timeoutMs)
    backupRestoreRequestDrainWaiters.add(finish)
  })
}
