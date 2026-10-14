import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * A browser send is answered once the server owns its turn (2026-09-18).
 *
 * The rule and its tests live in `respondAsyncSend.ts` and `turnOutcomeRegistry.ts`. These pins
 * are the wiring those tests cannot see: the POST honours `Prefer: respond-async` and nothing
 * else changes for a caller that does not ask; the turn is accepted right after its session-turn
 * lock is registered and its id and stop signal are kept, so every refusal before the lock
 * (400s, 404s, 409 busy or deleting) is still the direct HTTP answer; and a detached turn holds
 * the backup-restore gate, because a restore waits for in-flight requests and the reply's
 * request is no longer one.
 *
 * BL-4 adds the one other place: a send that meets another turn and waits in the chat's line is
 * accepted the moment it is queued, before it waits, because from then on the server owns it
 * (it will run, or be kept at the end of the chat). Its later pass through the post-lock
 * acceptance is a no-op: the acceptance is once per request (`answerWhenTurnAccepted`).
 */
describe('send-routed: respond-async', () => {
  const post = source.indexOf('\nexport const POST: RequestHandler = async (event) => {\n')
  const postSource = source.slice(post, source.indexOf('\n}\n', post) + 3)

  it('the POST asks the rule only when the send asked for it, and otherwise runs as before', () => {
    expect(post).toBeGreaterThan(-1)
    expect(postSource).toContain(
      '\n  if (!prefersRespondAsync(event.request)) {\n    return handleSendRoutedRequest(event)\n  }\n'
    )
    expect(postSource).toContain(
      '\n  return answerWhenTurnAccepted(\n    (acceptTurn) => handleSendRoutedRequest(event, acceptTurn),\n    { holdWork: enterBackupRestoreHttpRequest },\n  )\n'
    )
  })

  it('accepts the turn once, right after its lock is registered and before any of its work', () => {
    const registered = source.indexOf(
      '\n    const sessionTurnId = sessionTurnRegistration.entry.turnId\n    const turnStopSignal = sessionTurnRegistration.entry.stop.signal\n'
    )
    const accepted = source.indexOf(
      '\n    acceptTurn?.({ sessionId, userId: resolvedUserId })\n',
      registered
    )
    const work = source.indexOf('\n    try {\n', registered)
    expect(registered).toBeGreaterThan(-1)
    expect(accepted).toBeGreaterThan(registered)
    expect(work).toBeGreaterThan(accepted)
    // Only bind the registered Stop controller to its request owner before acceptance.
    const between = source.slice(registered, accepted).split('\n').slice(3)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('//'))
    expect(between).toEqual(['planOwner.stop = sessionTurnRegistration.entry.stop'])
  })

  it('accepts a queued send once, the moment it is queued and before it waits (BL-4)', () => {
    // Exactly two call sites: this one and the one after the lock.
    expect(source.split('acceptTurn?.(').length - 1).toBe(2)
    const queued = source.indexOf('\n        const queuedTurn = queueSessionTurn(sessionId, {\n')
    const overflowAnswer = source.indexOf(
      '\n            return json(buildQueuedSendOverflowAnswer(), { status: 409 })\n',
      queued
    )
    const accepted = source.indexOf(
      '\n          acceptTurn?.({ sessionId, userId: resolvedUserId })\n',
      queued
    )
    const waits = source.indexOf('\n          const handover = await queuedTurn.outcome\n', queued)
    const lock = source.indexOf('\n    const sessionTurnRegistration = registerSessionTurn(\n')
    expect(queued).toBeGreaterThan(-1)
    // A send over the cap is answered with today's refusal, never accepted.
    expect(overflowAnswer).toBeGreaterThan(queued)
    expect(accepted).toBeGreaterThan(overflowAnswer)
    expect(waits).toBeGreaterThan(accepted)
    // All of it above the lock block: the queued send's refusals and its wait come before it.
    expect(lock).toBeGreaterThan(waits)
  })

  it('the handler takes the acceptance as an argument, never from the request body', () => {
    expect(source).toContain(
      '\nasync function handleSendRoutedRequest(\n  { request, fetch: eventFetch, locals }: RequestEvent,\n  acceptTurn: AcceptTurn | null = null,\n): Promise<Response> {\n'
    )
  })
})
