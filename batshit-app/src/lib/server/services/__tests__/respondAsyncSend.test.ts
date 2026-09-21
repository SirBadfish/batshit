import { afterEach, describe, expect, it, vi } from 'vitest'
import { json } from '@sveltejs/kit'
import {
  answerWhenTurnAccepted,
  prefersRespondAsync,
  type AcceptTurn
} from '../respondAsyncSend'
import {
  __resetTurnOutcomesForTests,
  watchTurnOutcome,
  type TurnOutcome
} from '../turnOutcomeRegistry'

/**
 * A browser send is answered once the server owns its turn (2026-09-18).
 *
 * The page awaited `POST /api/messages/send-routed` until the whole turn was over, so each
 * running reply held one of the browser's six HTTP/1.1 connections to the server. Five replies
 * at once, plus the live hub's one stream, held all six, and every other request of every tab
 * waited: measured, a tiny request from each of five tabs gave up after 20 s and a Stop waited
 * 18.8 s in the browser (`_local/sconn-proof/fivetabs-before.json`). A send that asks
 * (`Prefer: respond-async`) is now answered `202` the moment its session-turn lock is
 * registered; the turn runs on exactly as before, and its FINAL answer is kept for the tab to
 * read over the live hub.
 */

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function holdWork() {
  const state = { held: 0, released: 0 }
  const deps = {
    holdWork: vi.fn(() => {
      state.held += 1
      return () => {
        state.released += 1
      }
    })
  }
  return { state, deps }
}

function outcomeOf(turnId: string, userId = 'user-1') {
  const seen: TurnOutcome[] = []
  const stop = watchTurnOutcome(turnId, userId, (outcome) => seen.push(outcome))
  return { seen, stop }
}

const ACCEPTANCE = { sessionId: 'session-1', userId: 'user-1' }

afterEach(() => {
  __resetTurnOutcomesForTests()
})

describe('prefersRespondAsync', () => {
  function request(prefer?: string) {
    return new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: prefer === undefined ? {} : { prefer }
    })
  }

  it('reads the RFC 7240 preference, in any case and beside others', () => {
    expect(prefersRespondAsync(request('respond-async'))).toBe(true)
    expect(prefersRespondAsync(request('Respond-Async'))).toBe(true)
    expect(prefersRespondAsync(request('return=minimal, respond-async'))).toBe(true)
    expect(prefersRespondAsync(request('respond-async; x=1, wait=10'))).toBe(true)
  })

  it('is off without the header, and for any other preference', () => {
    expect(prefersRespondAsync(request())).toBe(false)
    expect(prefersRespondAsync(request('wait=10'))).toBe(false)
    expect(prefersRespondAsync(request('respond-asynchronously'))).toBe(false)
    expect(prefersRespondAsync(request('return=respond-async'))).toBe(false)
  })
})

describe('answerWhenTurnAccepted', () => {
  it('answers 202 the moment the turn is accepted, while the turn is still running', async () => {
    const { state, deps } = holdWork()
    const turnEnds = deferred<Response>()
    let accept!: AcceptTurn
    const answering = answerWhenTurnAccepted((acceptTurn) => {
      accept = acceptTurn
      return turnEnds.promise
    }, deps)

    accept(ACCEPTANCE)
    const answer = await answering

    expect(answer.status).toBe(202)
    expect(answer.headers.get('preference-applied')).toBe('respond-async')
    const body = await answer.json()
    expect(body).toEqual({ accepted: true, turnId: expect.any(String), sessionId: 'session-1' })
    // The turn has not ended: its answer is not there yet, and the restore gate is still held.
    const { seen } = outcomeOf(body.turnId)
    expect(seen).toEqual([])
    expect(state).toEqual({ held: 1, released: 0 })

    turnEnds.resolve(json({ success: true, messageId: 'm-1' }))
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(state).toEqual({ held: 1, released: 1 })
  })

  it('keeps the turn’s final answer exactly: status, content type, and body text', async () => {
    const { deps } = holdWork()
    let accept!: AcceptTurn
    const turnEnds = deferred<Response>()
    const answering = answerWhenTurnAccepted((acceptTurn) => {
      accept = acceptTurn
      return turnEnds.promise
    }, deps)
    accept(ACCEPTANCE)
    const { turnId } = await (await answering).json()
    const { seen } = outcomeOf(turnId)

    const finalBody = { error: 'Failed to stream response', details: 'The provider said "no".' }
    turnEnds.resolve(json(finalBody, { status: 502 }))

    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify(finalBody)
    })
  })

  it('returns the run’s own answer when it ends before accepting (a refusal before the lock)', async () => {
    const { state, deps } = holdWork()
    const refusal = json({ error: 'Another response is already in progress for this session.', code: 'session_turn_in_progress' }, { status: 409 })

    const answer = await answerWhenTurnAccepted(async () => refusal, deps)

    expect(answer).toBe(refusal)
    expect(state).toEqual({ held: 0, released: 0 })
  })

  it('accepts once: a second call changes nothing', async () => {
    const { state, deps } = holdWork()
    const turnEnds = deferred<Response>()
    let accept!: AcceptTurn
    const answering = answerWhenTurnAccepted((acceptTurn) => {
      accept = acceptTurn
      return turnEnds.promise
    }, deps)
    accept(ACCEPTANCE)
    accept({ sessionId: 'session-2', userId: 'user-1' })
    const body = await (await answering).json()
    expect(body.sessionId).toBe('session-1')
    expect(state.held).toBe(1)
    turnEnds.resolve(json({ success: true }))
    await vi.waitFor(() => expect(state.released).toBe(1))
  })

  it('keeps the request open, as before, when the restore gate cannot be held (a restore is draining)', async () => {
    const deps = { holdWork: vi.fn(() => null) }
    const turnEnds = deferred<Response>()
    let accept!: AcceptTurn
    let answered = false
    const answering = answerWhenTurnAccepted((acceptTurn) => {
      accept = acceptTurn
      return turnEnds.promise
    }, deps).then((response) => {
      answered = true
      return response
    })

    accept(ACCEPTANCE)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(answered).toBe(false)

    const final = json({ success: true, messageId: 'm-1' })
    turnEnds.resolve(final)
    expect(await answering).toBe(final)
  })

  it('records a failure and lets go of the gate when the run throws after accepting', async () => {
    const { state, deps } = holdWork()
    const turnEnds = deferred<Response>()
    let accept!: AcceptTurn
    const answering = answerWhenTurnAccepted((acceptTurn) => {
      accept = acceptTurn
      return turnEnds.promise
    }, deps)
    accept(ACCEPTANCE)
    const { turnId } = await (await answering).json()
    const { seen } = outcomeOf(turnId)

    turnEnds.reject(new Error('boom'))

    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0].status).toBe(500)
    expect(JSON.parse(seen[0].body)).toEqual({ error: 'Failed to send message', details: 'boom' })
    expect(state).toEqual({ held: 1, released: 1 })
  })

  it('passes a failure before accepting straight through', async () => {
    const { deps } = holdWork()
    await expect(answerWhenTurnAccepted(async () => Promise.reject(new Error('early')), deps)).rejects.toThrow('early')
  })
})
