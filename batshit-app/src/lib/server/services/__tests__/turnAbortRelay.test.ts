import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { relayAbort } from '../turnAbortRelay'

/**
 * BL-246: send-routed's abort relays must forward an abort AND be taken back when the turn is
 * over. An inline listener left on the HTTP request's signal kept the whole handler (every model
 * step, each with its full request body) alive after the reply; the app died of a heap
 * out-of-memory after about 25 long benchmark chats.
 */
describe('relayAbort', () => {
  it('forwards an abort with its reason', () => {
    const from = new AbortController()
    const to = new AbortController()
    const until = new AbortController()
    relayAbort({ from: from.signal, to, reason: 'request', until: until.signal })
    expect(to.signal.aborted).toBe(false)
    from.abort('whatever')
    expect(to.signal.aborted).toBe(true)
    expect(to.signal.reason).toBe('request')
  })

  it('reads the reason from the source when given a function', () => {
    const from = new AbortController()
    const to = new AbortController()
    relayAbort({ from: from.signal, to, reason: (source: AbortSignal) => `seen:${String(source.reason)}`, until: new AbortController().signal })
    from.abort('wake_timeout')
    expect(to.signal.reason).toBe('seen:wake_timeout')
  })

  it('aborts at once for a source that is already aborted, and leaves no listener', () => {
    const from = new AbortController()
    from.abort('user')
    const to = new AbortController()
    relayAbort({ from: from.signal, to, reason: (s: AbortSignal) => s.reason, until: new AbortController().signal })
    expect(to.signal.reason).toBe('user')
    expect(getEventListeners(from.signal, 'abort')).toHaveLength(0)
  })

  it('takes the listener back when the turn is over, and then forwards nothing', () => {
    const from = new AbortController()
    const to = new AbortController()
    const until = new AbortController()
    relayAbort({ from: from.signal, to, reason: 'request', until: until.signal })
    expect(getEventListeners(from.signal, 'abort')).toHaveLength(1)
    until.abort()
    expect(getEventListeners(from.signal, 'abort')).toHaveLength(0)
    from.abort('late')
    expect(to.signal.aborted).toBe(false)
  })

  it('adds nothing for a missing source or a turn that is already over', () => {
    const to = new AbortController()
    relayAbort({ from: null, to, reason: 'x', until: new AbortController().signal })
    relayAbort({ from: undefined, to, reason: 'x', until: new AbortController().signal })
    const from = new AbortController()
    const over = new AbortController()
    over.abort()
    relayAbort({ from: from.signal, to, reason: 'x', until: over.signal })
    expect(getEventListeners(from.signal, 'abort')).toHaveLength(0)
    from.abort()
    expect(to.signal.aborted).toBe(false)
  })

  it('many turns on one long-lived signal leave no listener behind', () => {
    const requestLike = new AbortController()
    for (let i = 0; i < 50; i += 1) {
      const turnListeners = new AbortController()
      relayAbort({ from: requestLike.signal, to: new AbortController(), reason: 'request', until: turnListeners.signal })
      turnListeners.abort()
    }
    expect(getEventListeners(requestLike.signal, 'abort')).toHaveLength(0)
  })
})
