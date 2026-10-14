/**
 * Forward one abort signal to a turn's own AbortController, and take the listener back when the
 * turn is over (BL-246, 2026-09-24).
 *
 * send-routed relays four outside signals into a turn's stream controller: the HTTP request's
 * signal, a group run's signal, a woken turn's signal, and the turn's Stop signal. It used to add
 * those listeners inline and never remove them. An inline arrow function shares the handler's one
 * closure scope, so each listener kept the WHOLE handler alive (every model step, each with its
 * full request body), and the request object outlives the handler (Node keeps it reachable
 * through an async-context frame). On the SA-126 benchmark instance the app held 810 MB after a
 * forced GC with no reply running, 660 MB of it reachable only through these listeners, and it
 * died of a heap out-of-memory after about 25 long chats.
 *
 * The relay is created HERE, so its closure holds only the target controller and the reason; and
 * it is registered with `until`, so aborting the turn's own `until` controller in the handler's
 * `finally` removes every relay at once (a `once` listener is removed only if the abort fires).
 */
export function relayAbort(input: {
  /** The outside signal; nothing happens for a missing one. */
  from: AbortSignal | null | undefined
  /** The turn's controller that the abort is forwarded to. */
  to: AbortController
  /** The reason passed on, or a function that reads it from the source when it fires. */
  reason: unknown | ((source: AbortSignal) => unknown)
  /** Aborting this removes the listener (the turn is over). */
  until: AbortSignal
}): void {
  const { from, to, reason, until } = input
  if (!from || until.aborted) return
  const reasonFor = (source: AbortSignal) =>
    typeof reason === 'function' ? (reason as (source: AbortSignal) => unknown)(source) : reason
  if (from.aborted) {
    to.abort(reasonFor(from))
    return
  }
  from.addEventListener('abort', () => to.abort(reasonFor(from)), { once: true, signal: until })
}
