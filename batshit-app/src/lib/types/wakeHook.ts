/**
 * SA-113 P3 (DL-113-09) — the wake-up webhook record.
 *
 * A hook is the ONE inbound door into Batshit's wake-up primitive for anything that is not
 * an agent: n8n, a schedule, a Slack or Discord bridge, a CI job. Josh's instinct was not
 * to integrate with everything, so Batshit builds one token-scoped route and lets n8n be
 * the door to the rest.
 *
 * Browser-safe: the Admin "Wake-up webhooks" card reads these shapes.
 */

/** What a hook does by default when the caller does not say. */
export const WAKE_HOOK_DELIVERY_MODES = ['wait', 'wake'] as const
export type WakeHookDeliveryMode = (typeof WAKE_HOOK_DELIVERY_MODES)[number]

/** What a caller may ask a hook to write. A hook never creates a `result`. */
export const WAKE_HOOK_KINDS = ['info', 'assignment'] as const
export type WakeHookKind = (typeof WAKE_HOOK_KINDS)[number]

export interface WakeHookRecord {
  id: string
  userId: string
  /** The agent this hook writes to. One hook, one recipient — never "whoever is free". */
  agentId: string
  name: string
  /**
   * sha256 of the bearer token. The plain token is shown ONCE at creation and never
   * stored, the same posture as a Portable Skill Token: a leaked backup must not be a
   * leaked credential.
   */
  tokenHash: string
  /** For the Admin list, so a user can tell two tokens apart without seeing either. */
  tokenPrefix: string
  tokenSuffix: string
  deliverDefault: WakeHookDeliveryMode
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
  useCount: number
  /**
   * Optional hard end date. Default none — a hook lives until it is revoked.
   *
   * There is deliberately no `revokedAt`: revoke DELETES the record and its index entry,
   * so a revoked hook has no state to be in (F-P3-5). If a soft revoke is ever wanted,
   * it is a new field plus a new refusal reason, not a resurrected one.
   */
  expiresAt: string | null
}

/** The Admin card's row. Never carries `tokenHash`. */
export type WakeHookSummary = Omit<WakeHookRecord, 'tokenHash'>

export function toWakeHookSummary(record: WakeHookRecord): WakeHookSummary {
  const { tokenHash: _tokenHash, ...summary } = record
  return summary
}

/**
 * Why a bearer token was refused. The route says `403` for every one of these on purpose,
 * so a caller cannot tell "no such hook" from "wrong token".
 *
 * `invalid` covers a missing record, a wrong token, and a revoked hook alike, because
 * revoke deletes the record (F-P3-5).
 */
export type WakeHookRejectionReason = 'missing' | 'invalid' | 'disabled' | 'expired'

export type WakeHookValidation =
  | { valid: true; record: WakeHookRecord }
  | { valid: false; reason: WakeHookRejectionReason }
