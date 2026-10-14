/**
 * Gateway Settings save state shared by every mounted card and the MCP Sources panel
 * (BL-1370, BL-1393, BL-1394). It lives in a module, not in a card: the panel unmounts the card
 * when the Tools tab changes, and Settings can close and open again, while saves and reads go on.
 *
 * - Saves on their way, per section and gateway. A card that fills a gateway with saves on their
 *   way is read-only for it until they answer.
 * - Gateways whose failed save of a section may have been stored (an UNKNOWN outcome). A whole
 *   form filled for such a gateway is not a writer until an owned read of the saved gateway,
 *   started after that failure, succeeds (or a save sent after it is stored).
 * - One owned read (`GET /api/mcp/gateways/[id]`) per gateway at a time, with the order it started
 *   in, so a reader can tell whether it began after the copy it holds was installed.
 * - One ordering counter for the window (`nextGatewaySeq`): sent saves, unknown outcomes, save
 *   landings, list reads and owned reads take a number when they happen or start.
 *
 * Every event reaches every listener synchronously; one listener's failure never stops another.
 */
import type { MCPGateway } from '$lib/types/database'

export type GatewaySaveSection = 'settings' | 'grouping'

/** A failed save either surely stored nothing, or may have been stored. */
export type GatewaySaveFailure = 'not-stored' | 'unknown'

/**
 * Why a form filled for a gateway is read-only in a section: a save of it on its way, a read of
 * the saved gateway on its way (or due), or that read failed (then Retry asks again).
 */
export type GatewayLockReason = 'saving' | 'reading' | 'read-failed'

export type GatewaySaveEvent =
  | { kind: 'save-settled'; section: GatewaySaveSection; gatewayId: string; landed: MCPGateway | null; from: object }
  | { kind: 'read'; gatewayId: string; gateway: MCPGateway; startedAt: number }
  | { kind: 'read-failed'; gatewayId: string; message: string }

type Listener = (event: GatewaySaveEvent) => void
type GatewayRead = { startedAt: number; done: Promise<void> }

const SECTIONS: GatewaySaveSection[] = ['settings', 'grouping']
const flights: Record<GatewaySaveSection, Map<string, number>> = { settings: new Map(), grouping: new Map() }
// Per section: gateway -> the order number of its newest unknown outcome.
const unknownOutcome: Record<GatewaySaveSection, Map<string, number>> = { settings: new Map(), grouping: new Map() }
const reads = new Map<string, GatewayRead>()
const readFailures = new Map<string, string>()
const listeners = new Set<Listener>()
let seq = 0

export function nextGatewaySeq() {
  seq += 1
  return seq
}

export function savesOnTheirWay(section: GatewaySaveSection, gatewayId: string) {
  return flights[section].get(gatewayId) ?? 0
}

/** Counts a save as on its way; returns the order it was sent in. */
export function startSave(section: GatewaySaveSection, gatewayId: string) {
  flights[section].set(gatewayId, savesOnTheirWay(section, gatewayId) + 1)
  return nextGatewaySeq()
}

/**
 * Counts a save as answered, then tells every listener synchronously: the caller's `finally`
 * runs after `onGatewayUpdated` and before Svelte handles the landed copy.
 */
export function settleSave(section: GatewaySaveSection, gatewayId: string, landed: MCPGateway | null, from: object) {
  const left = savesOnTheirWay(section, gatewayId) - 1
  if (left > 0) flights[section].set(gatewayId, left)
  else flights[section].delete(gatewayId)
  emit({ kind: 'save-settled', section, gatewayId, landed, from })
}

/**
 * The PUT route answers 409 only while nothing was stored, and 401 before it reads the request.
 * After the gateway is stored every failure is a 500 (BL-1407: its 400/404 come only before the
 * write, but they are still read as unknown here, which only costs a read), and no answer at all
 * can follow a stored write too. So only 409 and 401 prove nothing was stored.
 */
export function classifySaveFailure(status: number | null): GatewaySaveFailure {
  return status === 409 || status === 401 ? 'not-stored' : 'unknown'
}

/**
 * BL-1410: a failed save whose answer vouches, in fields and never in its text, that the gateway
 * record was stored: exactly `gatewaySaved: true` with this gateway's id. It confirms the record
 * only (a token, the profile file or a profile sync it names may still be unknown), so the failure
 * stays an unknown outcome that the owned read settles; only the "may have been saved" hedge goes.
 * Anything else (missing, malformed, another id) is no proof.
 */
export function failureConfirmsGatewaySaved(body: unknown, gatewayId: string): boolean {
  if (!body || typeof body !== 'object') return false
  const answer = body as { gatewaySaved?: unknown; gatewayId?: unknown }
  return answer.gatewaySaved === true && answer.gatewayId === gatewayId
}

/**
 * The text as one sentence: a final period only when it does not already end one (BL-1410). A
 * closing bracket or quote after the end punctuation still ends it (`…saved.)`).
 */
export function asSentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?…]["'”’)\]]*$/.test(trimmed) ? trimmed : `${trimmed}.`
}

export function isOutcomeUnknown(section: GatewaySaveSection, gatewayId: string) {
  return unknownOutcome[section].has(gatewayId)
}

export function markOutcomeUnknown(section: GatewaySaveSection, gatewayId: string) {
  unknownOutcome[section].set(gatewayId, nextGatewaySeq())
}

/**
 * A save of that section sent after the unknown outcome and stored tells what the server holds
 * for it. One sent before can answer later and proves nothing, so it clears nothing.
 */
export function clearOutcomeUnknown(section: GatewaySaveSection, gatewayId: string, sentAt: number) {
  const markedAt = unknownOutcome[section].get(gatewayId)
  if (markedAt !== undefined && sentAt > markedAt) unknownOutcome[section].delete(gatewayId)
}

/** The last owned read failure for a gateway, for a card that mounts after it. */
export function gatewayReadFailure(gatewayId: string) {
  return readFailures.get(gatewayId) ?? null
}

export function isGatewayReadInFlight(gatewayId: string) {
  return reads.has(gatewayId)
}

/** Why a form filled for this gateway must stay read-only in that section, or null when it may write. */
export function gatewayLockReason(section: GatewaySaveSection, gatewayId: string): GatewayLockReason | null {
  if (savesOnTheirWay(section, gatewayId) > 0) return 'saving'
  if (!isOutcomeUnknown(section, gatewayId)) return null
  return gatewayReadFailure(gatewayId) !== null ? 'read-failed' : 'reading'
}

function newestUnknownOutcome(gatewayId: string) {
  return Math.max(0, ...SECTIONS.map((section) => unknownOutcome[section].get(gatewayId) ?? 0))
}

/**
 * Reads the saved gateway. A request while a read is on its way joins it when that read started
 * after the newest unknown outcome; otherwise a new read starts (the one on its way may predate
 * a write that was stored since). Success clears the unknown outcomes that came before the read
 * started and emits the copy with the order it started in; failure of the newest read keeps them
 * and emits the message. There is no automatic retry: Retry asks again.
 */
export function requestGatewayRead(userId: string | null, gatewayId: string): Promise<void> {
  const running = reads.get(gatewayId)
  if (running && running.startedAt > newestUnknownOutcome(gatewayId)) return running.done

  const read: GatewayRead = { startedAt: nextGatewaySeq(), done: Promise.resolve() }
  reads.set(gatewayId, read)
  readFailures.delete(gatewayId)
  read.done = (async () => {
    try {
      const query = userId ? `?userId=${encodeURIComponent(userId)}` : ''
      const response = await fetch(`/api/mcp/gateways/${encodeURIComponent(gatewayId)}${query}`)
      const body = await response.json().catch(() => ({}))
      if (!response.ok || !body?.gateway) {
        throw new Error(body?.error || 'Failed to read the saved gateway')
      }
      for (const section of SECTIONS) {
        const markedAt = unknownOutcome[section].get(gatewayId)
        if (markedAt !== undefined && markedAt < read.startedAt) unknownOutcome[section].delete(gatewayId)
      }
      emit({ kind: 'read', gatewayId, gateway: body.gateway as MCPGateway, startedAt: read.startedAt })
    } catch (error) {
      // A newer read on its way decides; an older one's failure says nothing about it.
      if (reads.get(gatewayId) !== read) return
      const message = error instanceof Error ? error.message : 'Failed to read the saved gateway'
      readFailures.set(gatewayId, message)
      emit({ kind: 'read-failed', gatewayId, message })
    } finally {
      if (reads.get(gatewayId) === read) reads.delete(gatewayId)
    }
  })()
  return read.done
}

export function subscribeGatewaySaveEvents(listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function emit(event: GatewaySaveEvent) {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch (error) {
      console.error('[gatewaySaveState] Error handling a gateway save event:', error)
    }
  }
}

/** Tests only: start a case with no saves, reads, unknown outcomes or listeners. */
export function resetGatewaySaveStateForTest() {
  for (const section of SECTIONS) {
    flights[section].clear()
    unknownOutcome[section].clear()
  }
  reads.clear()
  readFailures.clear()
  listeners.clear()
}
