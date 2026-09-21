import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContextPreviewGate } from './contextPreviewGate'

/**
 * The Token Panel's live preview (`POST /api/messages/context-preview`) may have ONE request in
 * flight per chat. Measured on the smoke stack on 2026-09-18 (`_local/queued-send-proof/`): a
 * reply's end asked for three or four previews at once, each open 1 to 7 s, beside the two event
 * streams the chat page always holds. That filled Chrome's six connections to the server, and the
 * next send's `generate-id` waited 5.1 s and 6.4 s in the browser for a free one while the
 * server answered it in 6 to 10 ms.
 */

type Ask = { reason: string; stored?: boolean }

/** A runner whose previews end only when the test says so, one deferred answer per request. */
function fakeRunner() {
  const calls: Array<{ sessionId: string; ask: Ask }> = []
  const answers: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
  let inFlight = 0
  let maxInFlight = 0
  const run = (sessionId: string, ask: Ask) => {
    calls.push({ sessionId, ask })
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    return new Promise<void>((resolve, reject) => {
      answers.push({
        resolve: () => {
          inFlight -= 1
          resolve()
        },
        reject: (error) => {
          inFlight -= 1
          reject(error)
        }
      })
    })
  }
  return {
    run,
    calls,
    reasons: () => calls.map((call) => call.ask.reason),
    maxInFlight: () => maxInFlight,
    /** Ends the request with this index, then lets the gate react. */
    async answer(index: number) {
      answers[index].resolve()
      await flush()
    },
    async fail(index: number, error: unknown) {
      answers[index].reject(error)
      await flush()
    }
  }
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createContextPreviewGate', () => {
  it('sends a preview at once when the chat has none in flight', () => {
    const runner = fakeRunner()
    const gate = createContextPreviewGate<Ask>({ run: runner.run, isOnScreen: () => true })

    gate.request('chat_a', { reason: 'zip-state' })

    expect(runner.reasons()).toEqual(['zip-state'])
  })

  it('never has two previews in flight for one chat', () => {
    const runner = fakeRunner()
    const gate = createContextPreviewGate<Ask>({ run: runner.run, isOnScreen: () => true })

    gate.request('chat_a', { reason: 'active-stream' })
    gate.request('chat_a', { reason: 'tool-result' })
    gate.request('chat_a', { reason: 'zip-state' })

    expect(runner.calls).toHaveLength(1)
    expect(runner.maxInFlight()).toBe(1)
  })

  it('asks made during a flight become ONE trailing refresh, sent when the flight ends, with the latest ask', async () => {
    const runner = fakeRunner()
    const gate = createContextPreviewGate<Ask>({ run: runner.run, isOnScreen: () => true })

    gate.request('chat_a', { reason: 'active-stream' })
    gate.request('chat_a', { reason: 'tool-result' })
    gate.request('chat_a', { reason: 'message-finalized', stored: true })
    expect(runner.calls).toHaveLength(1)

    await runner.answer(0)

    expect(runner.reasons()).toEqual(['active-stream', 'message-finalized'])
    expect(runner.calls[1].ask.stored).toBe(true)
    expect(runner.maxInFlight()).toBe(1)
  })

  it('stops after the trailing refresh when nothing new was asked', async () => {
    const runner = fakeRunner()
    const gate = createContextPreviewGate<Ask>({ run: runner.run, isOnScreen: () => true })

    gate.request('chat_a', { reason: 'active-stream' })
    gate.request('chat_a', { reason: 'zip-state' })
    await runner.answer(0)
    await runner.answer(1)

    expect(runner.reasons()).toEqual(['active-stream', 'zip-state'])
    // The chat is free again: the next ask is sent at once, not held as a trailing refresh.
    gate.request('chat_a', { reason: 'manual-trim' })
    expect(runner.reasons()).toEqual(['active-stream', 'zip-state', 'manual-trim'])
  })

  it('a failed preview still frees the chat and sends the trailing refresh, and says so', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runner = fakeRunner()
    const gate = createContextPreviewGate<Ask>({ run: runner.run, isOnScreen: () => true })

    gate.request('chat_a', { reason: 'active-stream' })
    gate.request('chat_a', { reason: 'zip-state' })
    await runner.fail(0, new Error('network down'))

    expect(runner.reasons()).toEqual(['active-stream', 'zip-state'])
    expect(reported).toHaveBeenCalledTimes(1)
    expect(String(reported.mock.calls[0].join(' '))).toContain('network down')
  })

  it('a runner that throws before it starts still frees the chat', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runner = fakeRunner()
    let first = true
    const gate = createContextPreviewGate<Ask>({
      run: (sessionId, ask) => {
        if (first) {
          first = false
          throw new Error('bad request body')
        }
        return runner.run(sessionId, ask)
      },
      isOnScreen: () => true
    })

    gate.request('chat_a', { reason: 'active-stream' })
    await flush()
    gate.request('chat_a', { reason: 'zip-state' })

    expect(runner.reasons()).toEqual(['zip-state'])
    expect(reported).toHaveBeenCalledTimes(1)
  })

  it('chats do not wait on each other', () => {
    const runner = fakeRunner()
    const gate = createContextPreviewGate<Ask>({ run: runner.run, isOnScreen: () => true })

    gate.request('chat_a', { reason: 'active-stream' })
    gate.request('chat_b', { reason: 'message-finalized' })

    expect(runner.calls.map((call) => call.sessionId)).toEqual(['chat_a', 'chat_b'])
  })

  it('never sends a preview for a chat that is not on screen (its answer would be thrown away)', () => {
    const runner = fakeRunner()
    const gate = createContextPreviewGate<Ask>({
      run: runner.run,
      isOnScreen: (sessionId) => sessionId === 'chat_on_screen'
    })

    // A background chat's reply ending asks for its saved-response preview.
    gate.request('chat_background', { reason: 'message-finalized', stored: true })

    expect(runner.calls).toHaveLength(0)
  })

  it('drops the trailing refresh when its chat left the screen during the flight', async () => {
    let onScreen = 'chat_a'
    const runner = fakeRunner()
    const gate = createContextPreviewGate<Ask>({
      run: runner.run,
      isOnScreen: (sessionId) => sessionId === onScreen
    })

    gate.request('chat_a', { reason: 'active-stream' })
    gate.request('chat_a', { reason: 'message-finalized', stored: true })
    onScreen = 'chat_b'
    await runner.answer(0)

    expect(runner.reasons()).toEqual(['active-stream'])
  })

  it('forget drops the chat’s trailing refresh (an emptied chat is not asked about again)', async () => {
    const runner = fakeRunner()
    const gate = createContextPreviewGate<Ask>({ run: runner.run, isOnScreen: () => true })

    gate.request('chat_a', { reason: 'active-stream' })
    gate.request('chat_a', { reason: 'zip-state' })
    gate.forget('chat_a')
    await runner.answer(0)

    expect(runner.reasons()).toEqual(['active-stream'])
  })

  it('the measured reply end: five asks inside one flight make two requests, never two at once', async () => {
    // What the page asked for when a Codex reply ended on the smoke stack: the streamed-text
    // timer, a zip-state change, and the saved-response preview from `end`, `complete`, and the
    // `complete_message` save. Before, each was its own request, started at once.
    const runner = fakeRunner()
    const gate = createContextPreviewGate<Ask>({ run: runner.run, isOnScreen: () => true })

    gate.request('chat_a', { reason: 'active-stream' })
    gate.request('chat_a', { reason: 'zip-state' })
    gate.request('chat_a', { reason: 'message-finalized', stored: true })
    gate.request('chat_a', { reason: 'message-finalized', stored: true })
    gate.request('chat_a', { reason: 'message-finalized', stored: true })
    await runner.answer(0)
    await runner.answer(1)

    expect(runner.calls).toHaveLength(2)
    expect(runner.maxInFlight()).toBe(1)
    expect(runner.calls[1].ask).toEqual({ reason: 'message-finalized', stored: true })
  })
})
