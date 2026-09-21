/**
 * A browser send is answered once the server owns its turn (2026-09-18).
 *
 * The page awaited `POST /api/messages/send-routed` until the whole turn was over: the reply, a
 * context-exhaustion continuation, a queued message the server promotes, the after-reply work,
 * and the `finally` that lets go of the lock. Each running reply therefore held one of the
 * browser's six HTTP/1.1 connections to the server, shared by every tab, and the live hub
 * already holds one. Measured with five tabs of one browser each running a reply: a tiny
 * request from every tab gave up after 20 s, and a Stop waited 18.8 s in the browser before it
 * could even be sent (`_local/sconn-proof/fivetabs-before.json`).
 *
 * The rule: a send that asks (RFC 7240 `Prefer: respond-async`) is answered
 * `202 {accepted, turnId, sessionId}` the moment send-routed has registered its session-turn
 * lock, and the turn runs on in this process exactly as it did. When the turn ends, its answer
 * (the very `Response` the route would have sent) is kept in `turnOutcomeRegistry.ts`, and the
 * tab reads it over the live hub. A run that ends before it accepts (every refusal before the
 * lock: a bad body, a chat that is gone, `session_turn_in_progress`) is answered directly, as
 * before. A send that does not ask is untouched: woken turns, the voice turn route, artifact
 * share, the dev smoke runner, and the proof drivers all read the end-of-turn answer.
 *
 * A turn that outlives its request must hold the backup-restore gate itself
 * (`enterBackupRestoreHttpRequest`): a restore waits for in-flight HTTP requests, and the
 * reply's request used to be one. When a restore is already draining, the gate cannot be
 * held, and the request keeps the turn as it always did.
 */

import { json } from '@sveltejs/kit'
import { openTurnOutcome, settleTurnOutcome, type TurnOutcome } from './turnOutcomeRegistry'

export const RESPOND_ASYNC_PREFERENCE = 'respond-async'

/** Who owns the turn the route has just accepted. */
export type TurnAcceptance = { sessionId: string; userId: string }

/** Called by send-routed once, right after its session-turn lock is registered. */
export type AcceptTurn = (acceptance: TurnAcceptance) => void

export type RespondAsyncDeps = {
  /** Hold the backup-restore gate for a turn that outlives its request; `null` while a restore drains. */
  holdWork: () => (() => void) | null
}

/** Did this request ask to be answered once its turn is accepted (RFC 7240)? */
export function prefersRespondAsync(request: Request): boolean {
  const header = request.headers.get('prefer')
  if (!header) return false
  return header
    .split(',')
    .some((preference) => preference.split(';')[0].trim().toLowerCase() === RESPOND_ASYNC_PREFERENCE)
}

async function readTurnOutcome(response: Response): Promise<TurnOutcome> {
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: await response.text()
  }
}

/** The answer send-routed's own catch gives to anything that escapes it. */
function failedTurnOutcome(error: unknown): TurnOutcome {
  const details = error instanceof Error ? error.message : String(error)
  return {
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Failed to send message', details })
  }
}

/**
 * Run send-routed's handler and answer as soon as it accepts its turn, or with its own answer
 * if it ends first. After an early answer the handler's final answer becomes the turn's outcome.
 */
export function answerWhenTurnAccepted(
  run: (accept: AcceptTurn) => Promise<Response>,
  deps: RespondAsyncDeps
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let answered = false
    let turnId: string | null = null
    let releaseWork: (() => void) | null = null

    const accept: AcceptTurn = (acceptance) => {
      if (answered) return
      const release = deps.holdWork()
      if (!release) return
      answered = true
      releaseWork = release
      turnId = openTurnOutcome({ userId: acceptance.userId })
      resolve(
        json(
          { accepted: true, turnId, sessionId: acceptance.sessionId },
          { status: 202, headers: { 'Preference-Applied': RESPOND_ASYNC_PREFERENCE } }
        )
      )
    }

    const settle = async (outcome: () => Promise<TurnOutcome>) => {
      try {
        settleTurnOutcome(turnId as string, await outcome())
      } catch (error) {
        settleTurnOutcome(turnId as string, failedTurnOutcome(error))
      } finally {
        releaseWork?.()
      }
    }

    run(accept).then(
      (response) => {
        if (turnId === null) {
          answered = true
          resolve(response)
          return
        }
        void settle(() => readTurnOutcome(response))
      },
      (error) => {
        if (turnId === null) {
          answered = true
          reject(error)
          return
        }
        void settle(async () => failedTurnOutcome(error))
      }
    )
  })
}
