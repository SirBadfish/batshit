/**
 * The Token Panel's live preview sends at most ONE request per chat at a time (2026-09-18).
 *
 * `POST /api/messages/context-preview` compiles the whole chat on the server to count its
 * tokens. The page asks for one on a timer while a reply streams, after a tool result, after a
 * zip change, and three times when a reply ends (`complete_message`, `end`, `complete`). Its
 * timer was debounced but its requests were not: every ask started a request at once, and a
 * counter only threw away the older answers. Measured on the smoke stack
 * (`_local/queued-send-proof/`): three or four previews open at the end of a reply, each for 1
 * to 7 s, beside the two event streams the chat page always holds. Chrome opens at most six
 * HTTP/1.1 connections to one server, so the next send's `generate-id` waited 5.1 s and 6.4 s
 * in the browser while the server answered it in 6 to 10 ms.
 *
 * The rule: an ask for a chat with no preview in flight is sent at once. An ask made while one
 * is in flight becomes that chat's ONE trailing refresh, and a newer ask replaces an older one,
 * so the last answer shown is still the one for the latest ask. The trailing refresh is sent
 * when the flight ends, succeeded or not. A chat that is not on screen is never asked about: the
 * page throws a preview away unless its chat is on screen when the answer lands.
 *
 * The runner builds its request when it runs, not when it was asked for, so a trailing refresh
 * counts the chat as it is then.
 */

export type ContextPreviewGateDeps<T> = {
  /** Sends one preview and resolves once its answer is handled. It reports its own failures. */
  run: (sessionId: string, ask: T) => Promise<void>
  /** Is this chat the one on screen now? */
  isOnScreen: (sessionId: string) => boolean
}

export type ContextPreviewGate<T> = {
  /** Asks for a preview of this chat: sent now, or kept as its one trailing refresh. */
  request: (sessionId: string, ask: T) => void
  /** Drops the chat's trailing refresh. A preview already in flight still finishes. */
  forget: (sessionId: string) => void
}

export function createContextPreviewGate<T>(deps: ContextPreviewGateDeps<T>): ContextPreviewGate<T> {
  const inFlight = new Set<string>()
  const trailing = new Map<string, T>()

  const send = (sessionId: string, ask: T) => {
    inFlight.add(sessionId)
    // An async wrapper, so a runner that throws before its first await still frees the chat.
    void (async () => deps.run(sessionId, ask))()
      .catch((error) => {
        console.error('[TokenPanel] Live context preview failed:', error)
      })
      .finally(() => {
        inFlight.delete(sessionId)
        if (!trailing.has(sessionId)) return
        const next = trailing.get(sessionId) as T
        trailing.delete(sessionId)
        if (deps.isOnScreen(sessionId)) send(sessionId, next)
      })
  }

  return {
    request(sessionId, ask) {
      if (!deps.isOnScreen(sessionId)) return
      if (inFlight.has(sessionId)) {
        trailing.set(sessionId, ask)
        return
      }
      send(sessionId, ask)
    },
    forget(sessionId) {
      trailing.delete(sessionId)
    }
  }
}
