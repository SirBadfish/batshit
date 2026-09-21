import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiCallError } from './redisCore'
import { SessionApiClient } from './sessionApiClient'

/**
 * Bug sweep #3 (2026-09-18): a failed `apiCall` threw `API error: <raw response body>`, so the
 * sidebar's delete toast read `Failed to delete session: API error: {"error":"…","code":"…"}`.
 * The error's message is now what the server said; the answer itself stays on the error.
 * Driven through the real session client's delete, the call that toast shows.
 */
function answerWith(body: string, status: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status }))
  )
}

async function deleteFailure(): Promise<ApiCallError> {
  return new SessionApiClient().deleteSession('chat-1').then(
    () => {
      throw new Error('the delete was expected to fail')
    },
    (error: ApiCallError) => error
  )
}

describe('apiCall failures', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('says the server’s own sentence for a JSON refusal and keeps the answer on the error', async () => {
    const refusal = {
      error: 'This chat’s reply is still stopping, so nothing was deleted. Try again in a moment.',
      code: 'session_turn_still_stopping'
    }
    answerWith(JSON.stringify(refusal), 409)

    const error = await deleteFailure()

    expect(error).toBeInstanceOf(ApiCallError)
    expect(error.message).toBe(refusal.error)
    expect(error.status).toBe(409)
    expect(error.payload).toEqual(refusal)
    expect(error.rawBody).toBe(JSON.stringify(refusal))
  })

  it('reads SvelteKit’s own error shape and a plain-text answer as they are', async () => {
    answerWith(JSON.stringify({ message: 'Not Found' }), 404)
    expect((await deleteFailure()).message).toBe('Not Found')

    answerWith('redis unavailable', 500)
    const plain = await deleteFailure()
    expect(plain.message).toBe('redis unavailable')
    expect(plain.payload).toBeNull()
  })

  it('never shows JSON: an answer with no sentence in it names the HTTP status', async () => {
    answerWith(JSON.stringify({ success: false, error: { code: 'nested' } }), 500)
    const unreadable = await deleteFailure()
    expect(unreadable.message).toBe('Request failed (HTTP 500)')
    expect(unreadable.rawBody).toContain('nested')

    answerWith('', 502)
    expect((await deleteFailure()).message).toBe('Request failed (HTTP 502)')
  })
})
