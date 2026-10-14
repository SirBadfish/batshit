/**
 * BL-382: what a tab catches up on after its live connection comes back. The server replays only
 * a turn still running, and a finished turn's buffer goes 5 s after its `end`, so a tab away longer
 * never hears the `end` of a reply that finished meanwhile: the page reads the chat again, and
 * this rule says which replies the tab still marks as streaming have ended on the server.
 *
 * The reload is the server's answer. send-routed stores an assistant reply only when it ends (the
 * finalize) or fails (the error record), and the load keeps this tab's in-progress copy of a reply
 * the server does not hold (`preserveLocalInProgress`) and a newer local approval-resume copy
 * (`keepNewerLocalApprovalResume`). So a reply that is finished (or failed) in the store after the
 * reload has ended on the server; one still in progress keeps running, and its replay goes on.
 */
export function resolveRepliesEndedWhileAway(params: {
  activeMessageIds: readonly string[]
  messages: ReadonlyArray<{ id: string; status?: string | null }>
}): string[] {
  const statusById = new Map(params.messages.map((message) => [message.id, message.status ?? null]))
  return params.activeMessageIds.filter((id) => {
    const status = statusById.get(id)
    return status === 'complete' || status === 'error'
  })
}

/**
 * A chat subscription came back: catch up the chat on screen (read it again) and any chat still
 * streaming a reply in this tab. A busy background chat keeps its live subscription, so it is
 * exactly the one that reconnects; an idle background chat is read when it is opened.
 */
export function shouldCatchUpChatAfterReconnect(params: {
  onScreen: boolean
  streamingReplyIds: readonly string[]
}): boolean {
  return params.onScreen || params.streamingReplyIds.length > 0
}

/**
 * The user channel came back: what it said during the drop is gone (a woken turn's
 * `session_run_status` of `complete`, for one). Catch up every chat still streaming a reply that
 * has no chat subscription of its own; a chat with one catches up on that subscription's return,
 * so the chat on screen is never read twice.
 */
export function resolveChatsToCatchUpAfterUserChannelReturn(params: {
  runStates: ReadonlyArray<{ sessionId: string; activeStreamMessageIds: readonly string[] }>
  chatsWithOwnSubscription: ReadonlySet<string>
}): string[] {
  return params.runStates
    .filter((state) => state.activeStreamMessageIds.length > 0)
    .map((state) => state.sessionId)
    .filter((sessionId) => !params.chatsWithOwnSubscription.has(sessionId))
}
