import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * BL-246: no abort listener outlives its turn. send-routed used to add inline listeners on the
 * HTTP request's signal (and on the group, wake, and Stop signals) and never remove them; the
 * request outlives the handler, so each listener kept the whole handler scope, every model step
 * with its full request body, alive (660 MB after about 25 long chats, then a heap out-of-memory).
 * The rule is `turnAbortRelay.ts` (tested there); these pins are where the handlers use it.
 */
describe('send-routed: abort relays are taken back when the turn ends', () => {
  const handler = source.indexOf('\nasync function handleBatshitAgentStream({')
  const handlerSource = source.slice(handler, source.indexOf('\nfunction resolveGroupSpeakerAbout(', handler))
  const group = source.indexOf('\nasync function handleGroupChatStream({')
  const groupSource = source.slice(group, source.indexOf('\nfunction sessionDeletedResponse(', group))

  it('has no inline abort listener anywhere in the file', () => {
    expect(source).not.toMatch(/\.addEventListener\(\s*'abort'/)
  })

  it('relays the four outside signals of a single-agent turn through relayAbort, until the turn ends', () => {
    expect(handler).toBeGreaterThan(-1)
    for (const from of ['externalAbortSignal', 'request.signal', 'getWakeAbortSignal(sessionId)', 'turnStopSignal']) {
      expect(handlerSource).toMatch(new RegExp(`relayAbort\\(\\{\\s*from: ${from.replace(/[.()]/g, '\\$&')},[^}]*until: turnListeners\\.signal`))
    }
  })

  // BL-413: a group member's run is stopped through the group's signal. Relayed with a fixed
  // reason, a delete of the group chat lost `session_deleted`, so the member's `end` carried no
  // `chatDeleted` and every tab showed a false save failure.
  it('BL-413: relays the group signal with its own reason, so a deleted group chat stays a deleted chat', () => {
    expect(handlerSource).toContain(
      '\n  relayAbort({ from: externalAbortSignal, to: streamAbortController, reason: sourceAbortReason, until: turnListeners.signal })\n',
    )
    expect(handlerSource).not.toContain("reason: 'external'")
  })

  it('takes the relays back first thing in the main finally', () => {
    const finallies = [...handlerSource.matchAll(/\n {2}\} finally \{\n/g)].map((m) => m.index ?? -1)
    const mainFinally = finallies.at(-1) ?? -1
    expect(mainFinally).toBeGreaterThan(-1)
    expect(handlerSource.slice(mainFinally, mainFinally + 200)).toMatch(/\} finally \{\n\s*\/\/ BL-246[^\n]*\n\s*turnListeners\.abort\(\)\n/)
  })

  it('the group run relays its Stop the same way and takes it back in its finally', () => {
    expect(group).toBeGreaterThan(-1)
    expect(groupSource).toContain('relayAbort({ from: turnStopSignal, to: groupAbortController, reason: sourceAbortReason, until: groupListeners.signal })')
    expect(groupSource).toMatch(/\} finally \{\n\s*groupListeners\.abort\(\)\n\s*clearGroupAbort\(sessionId\)/)
  })

  it('the reason functions live outside the handlers, so a relay cannot capture a handler scope', () => {
    expect(source).toMatch(/\nfunction wakeAbortReason\(source: AbortSignal\)/)
    expect(source).toMatch(/\nfunction sourceAbortReason\(source: AbortSignal\)/)
  })
})
