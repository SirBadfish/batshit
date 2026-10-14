/**
 * The stored decision of where each outside picture address of one reply came from (BL-474 step 2).
 * The server writes it (`imageAddressOrigins.ts`); the page only reads it, and a browser's save of
 * the reply never touches it. Pure, so the server, the route, and the page read one shape.
 *
 * - `pending`: written when the reply's run starts. A reply whose end step failed stays pending, so
 *   its outside pictures have no Load action.
 * - `decided`: written at the reply's end, before `end` is published. `textHashes` are the SHA-256
 *   (`sha256.ts`) of each text it judged: the text as saved and, when it differs, the text `end`
 *   carries (the save trims a reply's edges and blank lines). The page uses the decision only while
 *   the text on screen has one of them. `addresses` is keyed by each picture's address as the reply's
 *   parser read it (entity-decoded once).
 *
 * `version` orders the ends of one reply: 1 for its first end, an approval resume's own
 * `approvalResumeVersion` (larger) for the next. An older end never writes over a newer one.
 */
import {
  decideImageAddressOrigin,
  type ImageAddressEvidence,
  type ImageAddressOriginRule,
  type ImageAddressOriginState
} from '$lib/utils/imageAddressOrigin'

export type ImageOriginLane = 'api' | 'codex' | 'claude'

export type ImageOriginAddressDecision = {
  state: ImageAddressOriginState
  rule: ImageAddressOriginRule
  evidence: ImageAddressEvidence
}

export type PendingImageOriginRecord = {
  messageId: string
  version: number
  state: 'pending'
}

export type DecidedImageOriginRecord = {
  messageId: string
  version: number
  state: 'decided'
  textHashes: string[]
  lane: ImageOriginLane
  complete: boolean
  addresses: Record<string, ImageOriginAddressDecision>
}

export type ImageOriginRecord = PendingImageOriginRecord | DecidedImageOriginRecord

const LANES = new Set(['api', 'codex', 'claude'])

/**
 * A stored record as it may be used, or `null` for anything malformed. The four measured evidence
 * values are durable; derive the outcome with today's table rather than requiring the outcome
 * saved by an older table to still agree (BL-1023).
 */
export function readImageOriginRecord(value: unknown, messageId: string): ImageOriginRecord | null {
  return readRecord(value, messageId, false)
}

/** A checked GET response keeps its server-projected state/rule authoritative in older tabs. */
export function readImageOriginResponseRecord(value: unknown, messageId: string): ImageOriginRecord | null {
  return readRecord(value, messageId, true)
}

function readRecord(value: unknown, messageId: string, serverProjected: boolean): ImageOriginRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.messageId !== messageId) return null
  const version = record.version
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) return null
  if (record.state === 'pending') return { messageId, version, state: 'pending' }
  if (record.state !== 'decided') return null
  const hashes = record.textHashes
  if (
    !Array.isArray(hashes) ||
    hashes.length < 1 ||
    hashes.length > 2 ||
    !hashes.every((hash) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash))
  ) return null
  if (typeof record.lane !== 'string' || !LANES.has(record.lane)) return null
  if (typeof record.complete !== 'boolean') return null
  const raw = record.addresses
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const addresses: Record<string, ImageOriginAddressDecision> = {}
  for (const [address, decision] of Object.entries(raw as Record<string, unknown>)) {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return null
    const item = decision as Record<string, unknown>
    const evidenceValue = item.evidence
    if (!evidenceValue || typeof evidenceValue !== 'object' || Array.isArray(evidenceValue)) return null
    const rawEvidence = evidenceValue as Record<string, unknown>
    if (
      typeof rawEvidence.inRecord !== 'boolean' ||
      typeof rawEvidence.startInRecord !== 'boolean' ||
      typeof rawEvidence.sharesChatRun !== 'boolean' ||
      typeof rawEvidence.complete !== 'boolean' ||
      rawEvidence.complete !== record.complete
    ) return null
    const evidence: ImageAddressEvidence = {
      inRecord: rawEvidence.inRecord,
      startInRecord: rawEvidence.startInRecord,
      sharesChatRun: rawEvidence.sharesChatRun,
      complete: rawEvidence.complete
    }
    if (serverProjected && (
      !['as_read','blocked','unknown'].includes(item.state as string) ||
      ![1,2,3,4,5].includes(item.rule as number)
    )) return null
    const expected = serverProjected
      ? { state:item.state as ImageAddressOriginState, rule:item.rule as ImageAddressOriginRule }
      : decideImageAddressOrigin(evidence)
    addresses[address] = {
      state: expected.state,
      rule: expected.rule,
      evidence
    }
  }
  return {
    messageId,
    version,
    state: 'decided',
    textHashes: [...(hashes as string[])],
    lane: record.lane as ImageOriginLane,
    complete: record.complete,
    addresses
  }
}
