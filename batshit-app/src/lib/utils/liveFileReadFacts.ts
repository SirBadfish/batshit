/**
 * SA-137 P4 (D10): what live file reads did for a chat's newest turn, as `/api/zips/dead-copies`
 * reports it to the zip badges and the Zip Manager (`DatabaseService.findSessionZipFacts`, from the
 * chat's `live_file_reads:{sessionId}` receipt). Facts about one reply, never about the next prompt.
 *
 * - `current`: the receipt's reply is still the chat's newest reply and live file reads are still on
 *   for its agent. `copies` says, per zip, whether that reply's compile showed today's file
 *   (`refreshed`, with the refreshed size the size guard used) or the stored text (`static`, why).
 * - `changed`: the receipt describes an earlier reply, or the setting changed since; `copies` is
 *   empty and the badges show the stored copy's own state.
 * - `unknown`: the newest reply's agent has live file reads on, but no usable record names that
 *   reply; that agent's live-capable reads say so (`{ status: 'unknown' }`) instead of a guessed state.
 *
 * `delivery` is `prepared` (the compile froze the snapshot; no model request was seen) or `issued`
 * (the reply's first model request was sent with it). Neither says the model read anything.
 */
export type LiveReadDeliveryFact = 'prepared' | 'issued'

/** At most this many per-copy facts in one answer (the receipt's own bound). */
export const LIVE_FILE_READ_FACTS_MAX_COPIES = 512

export type LiveReadCopyFact =
  | { status: 'refreshed'; promptTokens: number }
  | { status: 'static'; reason: string }
  /** Whether the newest reply showed this copy as a fresh snapshot is not known (no usable record). */
  | { status: 'unknown' }

export type SessionLiveReadFacts =
  | {
      state: 'current' | 'changed'
      replyId: string
      agentId: string
      delivery: LiveReadDeliveryFact
      /** When the receipt last advanced (sent, else prepared). */
      at: string
      /** An approval resume that had no usable snapshot of its paused call, and why. */
      replayUnavailable?: 'replay-missing' | 'replay-expired' | 'replay-unverifiable'
      /**
       * Round 2 (strict freshness): that reply's compile showed a Read File copy only when it
       * refreshed it, so a `static` copy here was not shown to the agent (zipped that turn).
       */
      strict?: boolean
      copies: Record<string, LiveReadCopyFact>
      /** Copies the receipt could not hold (over its bounds); their facts are `unknown`. */
      overflow: number
    }
  | {
      /**
       * The newest reply's agent has live file reads on, but no usable record names that reply
       * (`missing`: absent, expired, from an earlier app process, or never prepared; `unreadable`:
       * the read failed). `copies` names that agent's live-capable reads as `unknown`.
       */
      state: 'unknown'
      replyId: string
      agentId: string
      unknownReason: 'missing' | 'unreadable'
      copies: Record<string, LiveReadCopyFact>
      overflow: number
    }

function readCopies(value: unknown): Record<string, LiveReadCopyFact> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const copies: Record<string, LiveReadCopyFact> = {}
  let count = 0
  for (const [zipId, copy] of Object.entries(value as Record<string, any>)) {
    if (count >= LIVE_FILE_READ_FACTS_MAX_COPIES) break
    if (copy?.status === 'refreshed' && Number.isSafeInteger(copy.promptTokens) && copy.promptTokens >= 0) {
      copies[zipId] = { status: 'refreshed', promptTokens: copy.promptTokens }
    } else if (copy?.status === 'static' && typeof copy.reason === 'string') {
      copies[zipId] = { status: 'static', reason: copy.reason }
    } else if (copy?.status === 'unknown') {
      copies[zipId] = { status: 'unknown' }
    } else {
      continue
    }
    count += 1
  }
  return copies
}

/** The route's `liveReads`, or null for anything else (the store's only reader). */
export function readSessionLiveReadFacts(value: unknown): SessionLiveReadFacts | null {
  const facts = value as Record<string, any> | null
  if (!facts || typeof facts !== 'object') return null
  if (typeof facts.replyId !== 'string' || typeof facts.agentId !== 'string') return null
  const copies = readCopies(facts.copies)
  if (!copies) return null
  const overflow = Number.isSafeInteger(facts.overflow) && facts.overflow > 0 ? facts.overflow : 0
  if (facts.state === 'unknown') {
    if (facts.unknownReason !== 'missing' && facts.unknownReason !== 'unreadable') return null
    return { state: 'unknown', replyId: facts.replyId, agentId: facts.agentId, unknownReason: facts.unknownReason, copies, overflow }
  }
  if (facts.state !== 'current' && facts.state !== 'changed') return null
  if (typeof facts.at !== 'string' || (facts.delivery !== 'prepared' && facts.delivery !== 'issued')) return null
  return {
    state: facts.state,
    replyId: facts.replyId,
    agentId: facts.agentId,
    delivery: facts.delivery,
    at: facts.at,
    ...(facts.replayUnavailable === 'replay-missing' || facts.replayUnavailable === 'replay-expired' || facts.replayUnavailable === 'replay-unverifiable' ? { replayUnavailable: facts.replayUnavailable } : {}),
    ...(facts.strict === true ? { strict: true } : {}),
    copies,
    overflow
  }
}
