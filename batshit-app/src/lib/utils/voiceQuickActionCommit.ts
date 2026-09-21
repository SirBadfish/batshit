export interface VoiceQuickActionCommitContext {
  sessionId: string | null
  agentId: string | null
}

export interface VoiceQuickActionCommitToken {
  generation: number
  context: VoiceQuickActionCommitContext
  signal: AbortSignal
}

export interface VoiceQuickActionCommitCoordinator {
  begin(context: VoiceQuickActionCommitContext): VoiceQuickActionCommitToken
  isCurrent(token: VoiceQuickActionCommitToken, context: VoiceQuickActionCommitContext): boolean
  ownsLatestGeneration(token: VoiceQuickActionCommitToken): boolean
  finish(token: VoiceQuickActionCommitToken): boolean
  invalidate(): boolean
  invalidateContext(context: VoiceQuickActionCommitContext): boolean
}

export interface VoiceQuickActionCommitDecision<Mark> {
  mark: Mark | null
  onlyThis: boolean
}

export interface RunVoiceQuickActionCommitOptions<Verdict, Mark> {
  coordinator: VoiceQuickActionCommitCoordinator
  token: VoiceQuickActionCommitToken
  currentContext: () => VoiceQuickActionCommitContext
  requestVerdict: () => Promise<Verdict | null>
  decide: (verdict: Verdict | null) => VoiceQuickActionCommitDecision<Mark>
  applyAction: (verdict: Verdict, mark: Mark) => void
  persistOnly: (mark: Mark) => Promise<void>
  send: (mark: Mark | null, beforeSend: () => boolean) => Promise<boolean>
  releasePending: () => void
}

function sameContext(left: VoiceQuickActionCommitContext, right: VoiceQuickActionCommitContext) {
  return left.sessionId === right.sessionId && left.agentId === right.agentId
}

export function voiceQuickActionSnapshotMatches(
  capturedContext: VoiceQuickActionCommitContext,
  currentContext: VoiceQuickActionCommitContext,
  capturedText: string,
  currentText: string
) {
  return sameContext(capturedContext, currentContext) && capturedText === currentText
}

/**
 * Owns the browser-side interval between a Voice Mode transcript becoming final and Batshit
 * committing that turn. Jev can make that interval last for the user's full In-Chat Wait Limit,
 * so a result belongs only to the chat and agent that began it.
 */
export function createVoiceQuickActionCommitCoordinator(): VoiceQuickActionCommitCoordinator {
  let generation = 0
  let active: { token: VoiceQuickActionCommitToken; controller: AbortController } | null = null
  let latestToken: VoiceQuickActionCommitToken | null = null

  const invalidate = () => {
    generation += 1
    if (!active) return false
    active.controller.abort()
    active = null
    return true
  }

  return {
    begin(context) {
      active?.controller.abort()
      const controller = new AbortController()
      const token: VoiceQuickActionCommitToken = {
        generation: ++generation,
        context: { ...context },
        signal: controller.signal
      }
      latestToken = token
      active = { token, controller }
      return token
    },
    isCurrent(token, context) {
      return active?.token === token && !token.signal.aborted && sameContext(token.context, context)
    },
    ownsLatestGeneration(token) {
      return generation === token.generation && !token.signal.aborted
    },
    finish(token) {
      if (active?.token !== token) return false
      active = null
      return true
    },
    invalidate,
    invalidateContext(context) {
      if (
        !latestToken ||
        latestToken.generation !== generation ||
        !sameContext(latestToken.context, context)
      ) return false
      if (active) return invalidate()
      // The token can be retired just before a delayed accepted/persist callback. A context
      // cleanup still has to retire that callback's reset authority even though no verdict is active.
      generation += 1
      return true
    }
  }
}

/**
 * Commits one delayed Voice Mode turn while keeping every effect behind the captured context.
 * `send` returns whether the page accepted the turn; a refusal or exception releases Voice Mode's
 * waiting state even when `beforeSend` already retired the coordinator token.
 */
export async function runVoiceQuickActionCommit<Verdict, Mark>(
  options: RunVoiceQuickActionCommitOptions<Verdict, Mark>
): Promise<'stale' | 'only-this' | 'sent' | 'refused'> {
  let released = false
  const releasePending = () => {
    if (released) return
    if (!options.coordinator.ownsLatestGeneration(options.token)) return
    released = true
    options.releasePending()
  }

  try {
    const verdict = await options.requestVerdict()
    if (!options.coordinator.isCurrent(options.token, options.currentContext())) {
      return 'stale'
    }

    const decision = options.decide(verdict)
    if (verdict !== null && decision.mark !== null) {
      options.applyAction(verdict, decision.mark)
      if (decision.onlyThis) {
        options.coordinator.finish(options.token)
        releasePending()
        await options.persistOnly(decision.mark)
        return 'only-this'
      }
    }

    const accepted = await options.send(decision.mark, () => {
      if (!options.coordinator.isCurrent(options.token, options.currentContext())) return false
      options.coordinator.finish(options.token)
      return true
    })
    if (!accepted) releasePending()
    return accepted ? 'sent' : 'refused'
  } catch (error) {
    releasePending()
    throw error
  } finally {
    if (options.coordinator.finish(options.token)) releasePending()
  }
}
