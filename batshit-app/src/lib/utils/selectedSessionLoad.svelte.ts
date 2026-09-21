import { untrack } from 'svelte'

/**
 * What the chat page does when the selected chat changes.
 *
 * The page used to run this as one `$effect` whose body also READ the stores it then wrote:
 * `messageStore.setActiveSession` reads `messagesBySession`, and the tool-state sync reads the
 * run registry. Both became dependencies, so the load's own `setMessagesForSession` (and every
 * streamed chunk, tool event, or run-state change in between) re-ran the effect, which loaded
 * again. From 2026-06-06 (`cb7f6be05`) the selected chat was re-fetched about ten times a
 * second, forever: messages, the execution log, and the Jev Juice after-reply notes.
 *
 * The rule now: a load happens because the SELECTED CHAT changed, or because its "still being
 * created" hold lifted. Nothing the load itself reads or writes can start another one.
 */
export type SelectedSessionLoadStep =
  /** No chat is selected. Nothing to load. */
  | 'none'
  /** The selected chat was found deleted earlier; clear it instead of asking again. */
  | 'clear_missing'
  /** The chat is still being created: show it, but do not load until its first reply lands. */
  | 'hold_for_creation'
  /** Load it: messages, execution log, zip state. */
  | 'load'

export function resolveSelectedSessionLoadStep(input: {
  sessionId: string | null
  missing: boolean
  creating: boolean
}): SelectedSessionLoadStep {
  if (!input.sessionId) return 'none'
  // A missing chat wins over a creating one: the page must stop asking the server about it.
  if (input.missing) return 'clear_missing'
  if (input.creating) return 'hold_for_creation'
  return 'load'
}

export type SelectedSessionLoadHandlers = {
  /** The selected chat id. The ONLY value, with `isCreating`, that re-runs the load. */
  selectedSessionId: () => string | null
  /** Whether that chat is still being created. Tracked, but only its answer for the selected chat counts. */
  isCreating: (sessionId: string) => boolean
  /** Read without tracking: a chat found missing is cleared the next time it is selected. */
  isMissing: (sessionId: string) => boolean
  clearMissing: (sessionId: string) => void
  holdForCreation: (sessionId: string) => void
  load: (sessionId: string) => void
}

/**
 * Wire the page's load to the selected chat. Call once, during component setup (it creates
 * an `$effect`, so it lives and dies with the component).
 *
 * The two inputs go through `$derived` so the effect only hears about a CHANGED answer: a
 * different chat, or this chat's creating hold turning on or off. Another chat being created
 * does not reload the one on screen. Everything the handlers do runs inside `untrack`.
 */
export function watchSelectedSessionLoad(handlers: SelectedSessionLoadHandlers) {
  const sessionId = $derived(handlers.selectedSessionId())
  const creating = $derived(sessionId ? handlers.isCreating(sessionId) : false)

  $effect(() => {
    const selected = sessionId
    const selectedIsCreating = creating
    untrack(() => runSelectedSessionLoadStep(selected, selectedIsCreating, handlers))
  })
}

/**
 * One load at a time per chat, and never a dropped request.
 *
 * The old in-flight guard simply RETURNED while a chat was loading, which was safe only
 * because the loop asked again 100 ms later. A request that arrives mid-load knows
 * something the answer in flight cannot (a woken turn finished, the server settled an
 * approval card), so it is remembered and runs exactly once when that load lands — one
 * catch-up load, never a queue of them.
 */
export function createChatLoadQueue(load: (sessionId: string) => Promise<void>) {
  const inFlight = new Set<string>()
  const wantedAgain = new Set<string>()

  const request = async (sessionId: string): Promise<void> => {
    if (inFlight.has(sessionId)) {
      wantedAgain.add(sessionId)
      return
    }
    inFlight.add(sessionId)
    try {
      await load(sessionId)
    } finally {
      inFlight.delete(sessionId)
      if (wantedAgain.delete(sessionId)) await request(sessionId)
    }
  }

  return {
    request,
    /** A chat that is gone owes no catch-up load. */
    forget(sessionId: string) {
      wantedAgain.delete(sessionId)
    },
    isLoading(sessionId: string) {
      return inFlight.has(sessionId)
    }
  }
}

function runSelectedSessionLoadStep(
  sessionId: string | null,
  creating: boolean,
  handlers: SelectedSessionLoadHandlers
) {
  if (!sessionId) return
  const step = resolveSelectedSessionLoadStep({
    sessionId,
    missing: handlers.isMissing(sessionId),
    creating
  })
  if (step === 'clear_missing') handlers.clearMissing(sessionId)
  else if (step === 'hold_for_creation') handlers.holdForCreation(sessionId)
  else if (step === 'load') handlers.load(sessionId)
}
