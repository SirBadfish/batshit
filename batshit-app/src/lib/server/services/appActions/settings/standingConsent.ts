/** A short-lived, in-process proof of an exact saved user policy decision, not an approval id.
 * JSON/tool arguments cannot recreate WeakMap membership. The final writer also compares the
 * captured authority preimages atomically. Only the reviewed Settings controls accept it.
 */
declare const standingConsentBrand: unique symbol
export type SettingsStandingConsent = { readonly [standingConsentBrand]: true }
type BoundConsent = { userId: string; agentId: string; controlId: string; inputHash: string; expiresAt: number }
const issued = new WeakMap<object, BoundConsent>()
const controls = new Set(['sys.app_settings.native.change', 'sys.ui.settings_agent_memory_update', 'sys.ui.settings_agent_identity_update'])
export function issueSettingsStandingConsent(binding: BoundConsent): SettingsStandingConsent {
  if (!controls.has(binding.controlId) || !binding.userId || !binding.agentId || !/^[a-f0-9]{64}$/.test(binding.inputHash) ||
    !Number.isFinite(binding.expiresAt) || binding.expiresAt <= Date.now()) throw new Error('Invalid Settings policy consent binding.')
  const proof = Object.freeze({}) as SettingsStandingConsent
  issued.set(proof, { ...binding })
  return proof
}
export function hasSettingsStandingConsent(value: unknown, binding: Omit<BoundConsent, 'expiresAt'>): boolean {
  if (!value || typeof value !== 'object') return false
  const saved = issued.get(value)
  return !!saved && saved.expiresAt > Date.now() && saved.userId === binding.userId && saved.agentId === binding.agentId &&
    saved.controlId === binding.controlId && saved.inputHash === binding.inputHash
}
