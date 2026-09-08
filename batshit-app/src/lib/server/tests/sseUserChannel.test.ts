import { describe, expect, it } from 'vitest'
import {
  getSessionChannel,
  getUserChannel,
  parseSseChannel
} from '$lib/server/ssePublisher'

/**
 * SA-113 P1 (DL-113-06) — the user channel rides the SAME `batshit:sse:*` pattern
 * subscription as session events. `parseSseChannel` is THE rule that tells the two apart,
 * so a user event can never be handed to session-shaped handling (which would look up a
 * phantom session, run session teardown against a user id, and silently drop the event).
 */

describe('parseSseChannel', () => {
  it('reads a session channel', () => {
    expect(parseSseChannel(getSessionChannel('sess-123'))).toEqual({
      scope: 'session',
      sessionId: 'sess-123'
    })
  })

  it('reads a user channel', () => {
    expect(parseSseChannel(getUserChannel('user-1'))).toEqual({
      scope: 'user',
      userId: 'user-1'
    })
  })

  it('does not treat a session id that merely CONTAINS "user" as a user channel', () => {
    expect(parseSseChannel(getSessionChannel('my-user-notes'))).toEqual({
      scope: 'session',
      sessionId: 'my-user-notes'
    })
  })

  it('routes a colon-bearing session id to the user scope, which is why session ids reject colons', () => {
    // `POST /api/sessions` refuses an id containing ":" precisely so this shape is
    // unreachable. Pinned here so removing that guard fails a test rather than quietly
    // handing one user's channel to a forged session id.
    expect(parseSseChannel('batshit:sse:user:evil')).toEqual({
      scope: 'user',
      userId: 'evil'
    })
  })

  it('rejects anything outside the prefix, and an empty suffix', () => {
    expect(parseSseChannel('batshit:other:x')).toBeNull()
    expect(parseSseChannel('batshit:sse:')).toBeNull()
    expect(parseSseChannel('batshit:sse:user:')).toBeNull()
    expect(parseSseChannel('')).toBeNull()
  })
})

describe('channel builders', () => {
  it('build the shapes the router parses back', () => {
    expect(getSessionChannel('s1')).toBe('batshit:sse:s1')
    expect(getUserChannel('u1')).toBe('batshit:sse:user:u1')
  })
})
