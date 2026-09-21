import { describe, expect, it } from 'vitest'
import { StreamStoppedError, isStopError, judgeStreamEnd } from '../streamStop'

/**
 * A stopped stream is INTERRUPTED, whatever else it ended with (2026-09-18).
 *
 * The AI SDK ends an aborted stream in one of two ways: its `stream` throws the abort reason
 * (the string `'user'`), or it enqueues an `abort` part and completes. In the second case
 * send-routed's post-loop code read the result's `steps` (which reject with the reason: the log
 * said `Failed to parse tool approval requests user`) and then judged a reply with no words yet
 * as a provider failure (`The model provider returned an empty response`), and only the catch's
 * abort check turned it back into the interrupted answer. Every Stop also logged
 * `Batshit agent streaming error: …` (the reason, or the Codex lane's `AbortError`). The stored
 * message and the answer were right; the log said the provider failed.
 */

describe('judgeStreamEnd', () => {
  it('a stopped stream is stopped, even if it also reported an error', () => {
    expect(judgeStreamEnd({ stopped: true, runtimeError: null })).toEqual({ kind: 'stopped' })
    expect(judgeStreamEnd({ stopped: true, runtimeError: new Error('Stream failed before producing output') })).toEqual({
      kind: 'stopped'
    })
  })

  it('a stream that was not stopped and reported an error failed, with that error', () => {
    const error = new Error('provider blew up')
    expect(judgeStreamEnd({ stopped: false, runtimeError: error })).toEqual({ kind: 'failed', error })
  })

  it('otherwise it finished, and its output is judged as before (a real empty reply is still reported)', () => {
    expect(judgeStreamEnd({ stopped: false, runtimeError: null })).toEqual({ kind: 'finished' })
  })
})

describe('isStopError', () => {
  it('reads a Stop from the stream’s signal, whatever was thrown', () => {
    const stopped = new AbortController()
    stopped.abort('user')
    expect(isStopError('user', [stopped.signal])).toBe(true)
    expect(isStopError(new Error('The model provider returned an empty response.'), [stopped.signal])).toBe(true)
  })

  it('reads the AbortError a lane throws (the Codex lane’s “Codex run aborted by user”)', () => {
    const codexAbort = new Error('Codex run aborted by user')
    codexAbort.name = 'AbortError'
    expect(isStopError(codexAbort, [new AbortController().signal])).toBe(true)
    expect(isStopError(new StreamStoppedError(), [])).toBe(true)
  })

  it('a provider failure with no Stop is not one', () => {
    expect(isStopError(new Error('The model provider returned an empty response.'), [new AbortController().signal, null])).toBe(false)
    expect(isStopError('user', [undefined])).toBe(false)
  })
})
