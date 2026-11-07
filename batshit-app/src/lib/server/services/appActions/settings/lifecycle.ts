import { randomBytes } from 'node:crypto'

// Settings authority is process-local. Dates and caller-selected IDs are only data
// preimages: create/delete/restore owners invalidate these revisions independently.
export type SettingsLifecycleSnapshot = { epoch: string; records: Array<[string, string]> }
export class SettingsLifecycleRefusal extends Error {
  readonly status = 409
  readonly code = 'SETTINGS_LIFECYCLE_CHANGED'
}
const nonce = () => randomBytes(16).toString('hex')
let epoch = nonce()
let restoring = false
const revisions = new Map<string, string>()
const replacing = new Set<string>()
const replacements = new Set<Promise<unknown>>()
type Lease = { keys: string[]; unknown: boolean; done: Promise<void>; finish: () => void }
const leases = new Set<Lease>()
const globalUnknown = () => [...leases].some(lease => lease.unknown && lease.keys.includes('*'))
export const settingsRestoreAuthorityUncertain = () => globalUnknown()
function refusal(message = 'Settings identity changed or is being replaced. Reload before continuing.'): never {
  throw new SettingsLifecycleRefusal(message)
}
function revision(key: string) {
  let value = revisions.get(key)
  if (!value) { value = nonce(); revisions.set(key, value) }
  return value
}
export function captureSettingsLifecycle(keys: string[]): SettingsLifecycleSnapshot {
  if (globalUnknown()) refusal('An App Actions restore authority write has an unknown outcome. Its custody is still held.')
  if (restoring || keys.some(key => replacing.has(key))) refusal()
  return { epoch, records: [...new Set(keys)].sort().map(key => [key, revision(key)]) }
}
export function assertSettingsLifecycle(value: SettingsLifecycleSnapshot): void {
  if (globalUnknown() || restoring || value.epoch !== epoch || value.records.some(([key, saved]) => replacing.has(key) || revision(key) !== saved)) refusal()
}
/** Acquire synchronously, after awaited client acquisition and before command issue.
 * An ambiguous issued command keeps custody; replacement must not pass it. */
export function acquireSettingsMutation(value: SettingsLifecycleSnapshot) {
  assertSettingsLifecycle(value)
  return mutationLease(value.records.map(([key]) => key), () => assertSettingsLifecycle(value))
}
/** Only the already-admitted destructive/recovery owner may fence portable grants. */
export function acquireSettingsRestoreMutation() {
  if (!restoring || globalUnknown()) refusal('The confirmed Settings restore fence is not admitted.')
  return mutationLease(['*'], () => { if (!restoring) refusal() })
}
/** Only an actual, already-admitted record replacement may issue its physical write. */
export function assertSettingsRecordReplacement(key: string): void {
  if (restoring || globalUnknown() || !replacing.has(key)) refusal('This Settings record replacement is not admitted.')
}
export function acquireSettingsReplacementMutation(key: string) {
  assertSettingsRecordReplacement(key)
  return mutationLease([key], () => {
    if (restoring || !replacing.has(key)) refusal('This Settings record replacement is no longer admitted.')
  })
}
export function assertSettingsRestoreAdmitted() {
  if (!restoring || globalUnknown()) refusal('The confirmed Settings restore fence is not admitted.')
}
function mutationLease(keys: string[], check: () => void) {
  let finish!: () => void
  const lease: Lease = { keys, unknown: false,
    done: new Promise<void>(resolve => { finish = resolve }), finish: () => finish() }
  leases.add(lease)
  return {
    check,
    settle() { leases.delete(lease); lease.finish() },
    unknown() { lease.unknown = true; lease.finish() }
  }
}
async function drain(keys?: string[], owners: Promise<unknown>[] = []) {
  const relevant = () => [...leases].filter(lease => !keys || lease.keys.includes('*') || lease.keys.some(key => keys.includes(key)))
  if (relevant().some(lease => lease.unknown)) refusal('An issued Settings write has an unknown outcome. Replacement is held until its custody is resolved or the app restarts.')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([Promise.all([Promise.allSettled(owners), ...relevant().map(lease => lease.done)]), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SettingsLifecycleRefusal('A Settings write is still settling. Replacement did not start.')), 30_000)
    })])
    if (relevant().some(lease => lease.unknown)) refusal('An issued Settings write has an unknown outcome. Replacement did not start.')
  } finally { clearTimeout(timer) }
}
/** Actual record lifecycle owner only; no policy or actor can acquire this boundary. */
export function withSettingsRecordReplacement<T>(key: string, replace: () => Promise<T>,
  completed?: (value: T, lifecycle: SettingsLifecycleSnapshot) => void): Promise<T> {
  if (globalUnknown()) return Promise.reject(new SettingsLifecycleRefusal('An App Actions restore authority write has an unknown outcome. Replacement is held.'))
  if (restoring || replacing.has(key)) return Promise.reject(new SettingsLifecycleRefusal('This Settings record is already being replaced.'))
  replacing.add(key); revisions.set(key, nonce())
  const pending = (async () => {
    let value: T | undefined, known = false
    try { await drain([key]); value = await replace(); known = true; return value }
    finally {
      replacing.delete(key); revisions.set(key, nonce())
      // Only the actual successful replacement owner gets this synchronous post-generation
      // handoff. No await/fresh read can substitute a later same-ID incarnation.
      if (known && completed) completed(value as T, captureSettingsLifecycle([key]))
    }
  })()
  replacements.add(pending)
  return pending.finally(() => replacements.delete(pending))
}
/** Covers restore, rollback and journal recovery. No saved record can restore a lease. */
export function withSettingsRestoreFence<T>(restore: () => Promise<T>): Promise<T> {
  if (restoring) return Promise.reject(new SettingsLifecycleRefusal('A Settings restore is already running.'))
  restoring = true; epoch = nonce()
  return (async () => {
    try {
      await drain(undefined, [...replacements])
      return await restore()
    } finally { restoring = false; epoch = nonce() }
  })()
}
