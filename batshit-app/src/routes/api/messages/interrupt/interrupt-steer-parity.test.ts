import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * SA-114 P1 (DL-114-15) — interrupt is the hard stop, and it does not change.
 *
 * Josh's two verbs have to stay honest: a steer lands INSIDE a reply, and an interrupt
 * stops it. The simplest way to keep that true is for the interrupt path to know nothing
 * about steering at all, which is what these read.
 */

const interruptRoute = readFileSync('src/routes/api/messages/interrupt/+server.ts', 'utf8')
const abortRegistry = readFileSync(
  'src/lib/server/services/streamAbortRegistry.ts',
  'utf8'
)
const sendRouted = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

describe('the interrupt path is untouched by steering', () => {
  it('the interrupt route mentions steering nowhere', () => {
    expect(interruptRoute.toLowerCase()).not.toContain('steer')
    // And it still does the three things it did before.
    expect(interruptRoute).toContain('abortWokenTurnForInterrupt(sessionId)')
    expect(interruptRoute).toContain("abortStream(sessionId, 'user')")
    expect(interruptRoute).toContain("abortGroupChat(sessionId, 'user')")
  })

  it('the stream abort registry has no steer state (DL-114-02: a separate map)', () => {
    expect(abortRegistry.toLowerCase()).not.toContain('steer')
    expect(abortRegistry).toContain('const activeStreams = new Map<string, StreamAbortEntry>()')
    expect(abortRegistry).toContain('const activeSessionTurns = new Map<string, SessionTurnEntry>()')
  })

  it('the interrupted stamp is unchanged, and the steer stamp cannot reach it', () => {
    const abortBranch = sendRouted.indexOf('if (isAbortError) {')
    const abortBlock = sendRouted.slice(abortBranch, abortBranch + 2200)

    expect(abortBlock).toContain('interrupted: true')
    expect(abortBlock).toContain('interruptionReason: resolveInterruptionReason()')
    expect(abortBlock).toContain('interruptedAt')
    // The steer metadata is written inside `finalizeAssistantMessage`, which this branch
    // calls — it never rewrites the interruption fields itself.
    expect(abortBlock).not.toContain('deliveredSteers')

    const setupAbort = sendRouted.indexOf('interruptedDuringSetup: true')
    expect(setupAbort).toBeGreaterThan(-1)
  })

  it('a steer accepted for a stopped turn is cleared, never promoted', () => {
    const finallyBlock = sendRouted.indexOf('clearSteerInbox(sessionId, {')
    expect(finallyBlock).toBeGreaterThan(-1)

    const promotionLoop = sendRouted.indexOf('while (steerPromotions < MAX_STEER_PROMOTIONS) {')
    expect(sendRouted.slice(promotionLoop, promotionLoop + 900)).toContain('if (interrupted) break')
  })
})
