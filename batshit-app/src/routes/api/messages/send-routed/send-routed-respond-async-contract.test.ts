import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * A browser send is answered once the server owns its turn (2026-09-18).
 *
 * The rule and its tests live in `respondAsyncSend.ts` and `turnOutcomeRegistry.ts`. These pins
 * are the wiring those tests cannot see: the POST honours `Prefer: respond-async` and nothing
 * else changes for a caller that does not ask; the turn is accepted in ONE place, right after
 * its session-turn lock is registered and its id and stop signal are kept, so every refusal
 * before the lock (400s, 404s, 409 busy or deleting) is still the direct HTTP answer; and a
 * detached turn holds the backup-restore gate, because a restore waits for in-flight requests
 * and the reply's request is no longer one.
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
    expect(source.split('acceptTurn?.(').length - 1).toBe(1)
    // Nothing between the lock and the acceptance but comments.
    const between = source.slice(registered, accepted).split('\n').slice(3)
    expect(between.every((line) => line.trim() === '' || line.trim().startsWith('//'))).toBe(true)
  })

  it('the handler takes the acceptance as an argument, never from the request body', () => {
    expect(source).toContain(
      '\nasync function handleSendRoutedRequest(\n  { request, fetch: eventFetch, locals }: RequestEvent,\n  acceptTurn: AcceptTurn | null = null,\n): Promise<Response> {\n'
    )
  })
})
