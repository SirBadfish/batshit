/**
 * BL-922: a chat's sends reach the server in the order they were made.
 *
 * The server knows a send only once it has answered it: the 202 that says it owns the turn (or
 * holds it in the chat's line), the steer route's answer, or a refusal. Before that, a send made
 * right after it could overtake it: a message sent about 0.25 s after the first message of a turn
 * found no running turn, the steer route answered `reply_finished`, the page posted it as an
 * ordinary send, and it registered first, so it was answered before the message sent before it
 * (`_local/session-d-2026-09-29/bl904/new-a4.json`). Its decision (steer, the chat's line, or a new
 * turn) was also made before the first send had started its run in the tab.
 *
 * So each send of a chat waits, before it decides how to go and before it saves or posts anything,
 * until every earlier send of that chat has its first answer or has ended without one. The wait is
 * bounded (`SEND_ORDER_WAIT_LIMIT_MS`, above the server's 15 s wait for a finishing turn before it
 * answers); past it the send goes and says so in the console. A wait that reached its limit also
 * lets the chat's later sends past the sends it gave up on, so one send that never answers costs
 * the chat one wait, not one for every send after it.
 */
export const SEND_ORDER_WAIT_LIMIT_MS = 20_000

export type SendOrderTurn = {
  /** An earlier send of the chat was still waiting for its first answer when this one was made. */
  waited: boolean
  /** The wait reached its limit and this send went anyway. */
  waitedOut: boolean
  /**
   * Only when the wait reached its limit: the chat's earlier sends still without a first answer,
   * by message id (null: not saved yet). Later sends no longer wait for them.
   */
  gaveUpOn?: Array<string | null>
}

export type SendOrderTicket = {
  /** Resolves when this send may go. */
  turn: Promise<SendOrderTurn>
  /** This send has its first answer, or ended without one. Safe to call more than once. */
  settle: () => void
  /** This send's message id, once it has one, so a later send can name it if it never answers. */
  setMessageId: (messageId: string) => void
}

type UnansweredSend = { order: number; messageId: string | null }

export type SendOrderGateDeps = {
  limitMs?: number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

export function createSendOrderGate(deps: SendOrderGateDeps = {}) {
  const limitMs = deps.limitMs ?? SEND_ORDER_WAIT_LIMIT_MS
  const schedule = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const cancel = deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  /**
   * Each chat's last send: settles when it has its first answer and every send before it has its
   * first answer or was given up on (a later send's wait reached its limit).
   */
  const tails = new Map<string, Promise<void>>()
  /** Each chat's sends that have no first answer yet, in the order they were made. */
  const unanswered = new Map<string, UnansweredSend[]>()
  let made = 0

  const leave = (sessionId: string, send: UnansweredSend) => {
    const list = unanswered.get(sessionId)
    if (!list) return
    const at = list.indexOf(send)
    if (at >= 0) list.splice(at, 1)
    if (list.length === 0) unanswered.delete(sessionId)
  }

  /** The earlier sends this one stopped waiting for; they are no longer kept. */
  const giveUpBefore = (sessionId: string, send: UnansweredSend): Array<string | null> => {
    const list = unanswered.get(sessionId) ?? []
    const earlier = list.filter((other) => other.order < send.order)
    for (const other of earlier) leave(sessionId, other)
    return earlier.map((other) => other.messageId)
  }

  const waitFor = (previous: Promise<void>, giveUp: () => Array<string | null>): Promise<SendOrderTurn> =>
    new Promise((resolve) => {
      let done = false
      const handle = schedule(() => {
        if (done) return
        done = true
        resolve({ waited: true, waitedOut: true, gaveUpOn: giveUp() })
      }, limitMs)
      void previous.then(() => {
        if (done) return
        done = true
        cancel(handle)
        resolve({ waited: true, waitedOut: false })
      })
    })

  return {
    /** A send of this chat was made (call in the order the sends were made). */
    enter(sessionId: string): SendOrderTicket {
      const previous = tails.get(sessionId) ?? null
      const send: UnansweredSend = { order: ++made, messageId: null }
      unanswered.set(sessionId, [...(unanswered.get(sessionId) ?? []), send])
      let release!: () => void
      const own = new Promise<void>((resolve) => {
        release = resolve
      })
      const turn = previous
        ? waitFor(previous, () => giveUpBefore(sessionId, send))
        : Promise.resolve({ waited: false, waitedOut: false })
      // A send that ends early must not let a later one past an earlier one still waiting. The
      // chain follows this send's own wait, not the earlier sends themselves: once that wait
      // reached its limit, the sends it gave up on hold no later send of the chat (BL-922).
      const tail = previous ? Promise.all([turn, own]).then(() => undefined) : own
      tails.set(sessionId, tail)
      let settled = false
      return {
        turn,
        settle: () => {
          if (settled) return
          settled = true
          leave(sessionId, send)
          release()
          void tail.then(() => {
            if (tails.get(sessionId) === tail) tails.delete(sessionId)
          })
        },
        setMessageId: (messageId: string) => {
          send.messageId = messageId
        }
      }
    }
  }
}
