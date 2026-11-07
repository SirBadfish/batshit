import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSendOrderGate, SEND_ORDER_WAIT_LIMIT_MS } from '../sendOrderGate'

/**
 * BL-922: a message sent right after the first message of a turn could reach the server first and
 * be answered first. A send of a chat now waits until the chat's earlier sends have their first
 * answers (the 202, the steer route's answer, or a refusal) before it decides and posts.
 */
describe('a chat\'s sends reach the server in the order they were made (BL-922)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * Two sends of one chat, the way the page makes them: each does its own work first (the agent
   * read, the save), then posts; the server registers a post when it arrives and answers 202. The
   * first send's work is slow (its agent read took 200 ms), the second's is quick.
   */
  function runTwoSends(useGate: boolean) {
    const gate = createSendOrderGate()
    const registered: string[] = []
    const send = async (id: string, workMs: number) => {
      const ticket = useGate ? gate.enter('chat-a') : null
      try {
        await ticket?.turn
        await new Promise((resolve) => setTimeout(resolve, workMs))
        // The post: the server registers it 20 ms later and answers 202 at once.
        await new Promise((resolve) => setTimeout(resolve, 20))
        registered.push(id)
        ticket?.settle()
      } finally {
        ticket?.settle()
      }
    }
    return { registered, send }
  }

  it('two sends 10 ms apart: the second registers after the first', async () => {
    const { registered, send } = runTwoSends(true)
    const first = send('first', 200)
    await vi.advanceTimersByTimeAsync(10)
    const second = send('second', 5)
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.all([first, second])
    expect(registered).toEqual(['first', 'second'])
  })

  it('without the gate the second send overtakes the first (the defect)', async () => {
    const { registered, send } = runTwoSends(false)
    const first = send('first', 200)
    await vi.advanceTimersByTimeAsync(10)
    const second = send('second', 5)
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.all([first, second])
    expect(registered).toEqual(['second', 'first'])
  })

  it('a send with no earlier send waiting goes at once', async () => {
    const gate = createSendOrderGate()
    await expect(gate.enter('chat-a').turn).resolves.toEqual({ waited: false, waitedOut: false })
    // Another chat's send never waits for this one.
    gate.enter('chat-b')
    await expect(gate.enter('chat-c').turn).resolves.toEqual({ waited: false, waitedOut: false })
  })

  it('a send that ends early does not let a later one past an earlier one still waiting', async () => {
    const gate = createSendOrderGate()
    const first = gate.enter('chat-a')
    const second = gate.enter('chat-a')
    const third = gate.enter('chat-a')
    let thirdWent = false
    void third.turn.then(() => (thirdWent = true))
    second.settle() // ended without posting (an empty text, a refused agent read)
    await vi.advanceTimersByTimeAsync(100)
    expect(thirdWent).toBe(false)
    first.settle()
    await vi.advanceTimersByTimeAsync(0)
    expect(thirdWent).toBe(true)
  })

  it('an earlier send that never answers holds the next one for the limit only, and is named', async () => {
    const gate = createSendOrderGate()
    gate.enter('chat-a').setMessageId('msg_user_client_hung')
    let outcome: unknown = null
    void gate.enter('chat-a').turn.then((turn) => (outcome = turn))
    await vi.advanceTimersByTimeAsync(SEND_ORDER_WAIT_LIMIT_MS - 1)
    expect(outcome).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    // The page's console line names the send it stopped waiting for.
    expect(outcome).toEqual({ waited: true, waitedOut: true, gaveUpOn: ['msg_user_client_hung'] })
  })

  it('a timed-out wait names only the earlier sends still without an answer', async () => {
    const gate = createSendOrderGate()
    const answered = gate.enter('chat-a')
    answered.setMessageId('msg_answered')
    gate.enter('chat-a').setMessageId('msg_hung') // goes at the first one's 202, never answers
    await vi.advanceTimersByTimeAsync(1_000)
    answered.settle()
    await vi.advanceTimersByTimeAsync(1_000)
    // Goes at its limit; then works without a message id yet (its agent read) and never answers.
    let third: { gaveUpOn?: Array<string | null> } | null = null
    void gate.enter('chat-a').turn.then((turn) => (third = turn))
    await vi.advanceTimersByTimeAsync(1_000)
    let fourth: { gaveUpOn?: Array<string | null> } | null = null
    void gate.enter('chat-a').turn.then((turn) => (fourth = turn))
    await vi.advanceTimersByTimeAsync(SEND_ORDER_WAIT_LIMIT_MS)
    // The answered send is never named; a send given up on once is not named again.
    expect(third!.gaveUpOn).toEqual(['msg_hung'])
    expect(fourth!.gaveUpOn).toEqual([null])
  })

  /**
   * One send whose post never returns (a connection held open; the page sets no fetch timeout).
   * The send after it waits the limit once, goes, and has its 202 50 ms later. The sends made
   * after that must not wait the limit again: the chat already gave up on the hung one.
   */
  it('a send that never answers costs the chat one wait, not one for every send after it', async () => {
    const gate = createSendOrderGate()
    gate.enter('chat-a') // never settles
    const second = gate.enter('chat-a')
    void second.turn.then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      second.settle()
    })
    await vi.advanceTimersByTimeAsync(10_000)
    // Made while the second still waits: it goes at the second's 202, not at its own limit.
    let thirdTurn: unknown = null
    let thirdWentAt = -1
    const third = gate.enter('chat-a')
    void third.turn.then((turn) => {
      thirdTurn = turn
      thirdWentAt = Date.now()
    })
    const startedAt = Date.now()
    await vi.advanceTimersByTimeAsync(SEND_ORDER_WAIT_LIMIT_MS)
    expect(thirdTurn).toEqual({ waited: true, waitedOut: false })
    expect(thirdWentAt - startedAt).toBe(SEND_ORDER_WAIT_LIMIT_MS - 10_000 + 50)
    third.settle()
    await vi.advanceTimersByTimeAsync(0)
    // Made a minute later: nothing before it is still waiting.
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(gate.enter('chat-a').turn).resolves.toEqual({ waited: false, waitedOut: false })
  })

  it('a chat whose sends all answered keeps nothing', async () => {
    const gate = createSendOrderGate()
    const only = gate.enter('chat-a')
    only.settle()
    only.settle()
    await vi.advanceTimersByTimeAsync(0)
    await expect(gate.enter('chat-a').turn).resolves.toEqual({ waited: false, waitedOut: false })
  })
})
