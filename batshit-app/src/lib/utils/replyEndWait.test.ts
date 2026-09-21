import { describe, expect, it } from 'vitest'
import { REPLY_END_POLL_MS, waitForReplyTarget, waitUntilReplyIsOver, type ReplyEndWaitDeps } from './replyEndWait'

/**
 * A message the BROWSER queued (one carrying a Clip or an `@file` mention) waits until the reply
 * it queued behind is over, then sends. Measured on the smoke stack on 2026-09-18
 * (`_local/queued-send-proof/`): when the same tab had sent the reply, the wait gave up the
 * moment the reply's message ended, because this tab's own send-routed request was still open
 * (the server's after-reply work) and there was no message left to wait on. The queued message
 * was then parked as "Not sent — the reply ran too long to wait for", after a 20-second reply.
 */

type Script = {
  /** What `isBusy` answers, by call. The last value repeats. */
  busy: boolean[]
  /** What `nextTarget` answers, by call. The last value repeats. */
  targets?: Array<string | null>
}

function fakeDeps(script: Script) {
  let clock = 0
  let busyCalls = 0
  let targetCalls = 0
  const waitedOn: string[] = []
  const sleeps: number[] = []
  const deps: ReplyEndWaitDeps = {
    isBusy: () => script.busy[Math.min(busyCalls++, script.busy.length - 1)],
    nextTarget: () => {
      const targets = script.targets ?? [null]
      return targets[Math.min(targetCalls++, targets.length - 1)]
    },
    waitForMessageEnd: async (messageId) => {
      waitedOn.push(messageId)
      clock += 1_000
    },
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    now: () => clock
  }
  return { deps, waitedOn, sleeps, elapsed: () => clock }
}

describe('waitUntilReplyIsOver', () => {
  it('keeps waiting while this tab’s own request is still open after the reply’s message ended', async () => {
    // The message ended, nothing new is streaming, and the chat is still busy for ~1 s: this
    // tab's send-routed request is doing its after-reply work. The old loop returned false here.
    const fake = fakeDeps({ busy: [true, true, true, true, true, true, true, false], targets: [null] })

    const over = await waitUntilReplyIsOver('msg_reply', fake.deps, 15 * 60_000)

    expect(over).toBe(true)
    expect(fake.waitedOn).toEqual(['msg_reply'])
    expect(fake.sleeps.length).toBeGreaterThanOrEqual(6)
    expect(fake.sleeps.every((ms) => ms === REPLY_END_POLL_MS)).toBe(true)
  })

  it('is over at once when nothing is busy after the reply’s message ends', async () => {
    const fake = fakeDeps({ busy: [false] })
    expect(await waitUntilReplyIsOver('msg_reply', fake.deps, 15 * 60_000)).toBe(true)
    expect(fake.sleeps).toEqual([])
  })

  it('follows the run to its next message (a context-exhaustion continuation)', async () => {
    const fake = fakeDeps({ busy: [true, true, false], targets: ['msg_continued', 'msg_continued'] })

    expect(await waitUntilReplyIsOver('msg_reply', fake.deps, 15 * 60_000)).toBe(true)
    expect(fake.waitedOn).toEqual(['msg_reply', 'msg_continued'])
  })

  it('does not spin on a message it has already waited for', async () => {
    // A message still listed as active after its wait returned (the 8 s ceiling, or a slow
    // store update) is polled, not waited on again in a tight loop.
    const fake = fakeDeps({ busy: [true, true, true, false], targets: ['msg_reply'] })

    expect(await waitUntilReplyIsOver('msg_reply', fake.deps, 15 * 60_000)).toBe(true)
    expect(fake.waitedOn).toEqual(['msg_reply'])
    // One poll before each of the three busy answers that follow the wait.
    expect(fake.sleeps.length).toBe(3)
  })

  it('gives up at the ceiling, and says the reply is still going', async () => {
    const fake = fakeDeps({ busy: [true], targets: [null] })

    expect(await waitUntilReplyIsOver('msg_reply', fake.deps, 10_000)).toBe(false)
    expect(fake.elapsed()).toBeGreaterThanOrEqual(10_000)
    expect(fake.elapsed()).toBeLessThan(10_000 + 1_000 + REPLY_END_POLL_MS)
  })
})

/**
 * Bug sweep, 2026-09-18: a group reply has no message id until its first `start` event, so a
 * message queued in that moment skipped the wait and was refused by the running turn.
 */
describe('waitForReplyTarget', () => {
  it('hands back the reply’s message id as soon as its first event gives it one', async () => {
    const fake = fakeDeps({ busy: [true], targets: [null, null, null, 'msg_group_reply'] })

    expect(await waitForReplyTarget(fake.deps, 60_000)).toEqual({ target: 'msg_group_reply', busy: true })
    expect(fake.sleeps).toEqual([REPLY_END_POLL_MS, REPLY_END_POLL_MS, REPLY_END_POLL_MS])
  })

  it('answers at once when the id is already known', async () => {
    const fake = fakeDeps({ busy: [true], targets: ['msg_reply'] })

    expect(await waitForReplyTarget(fake.deps, 60_000)).toEqual({ target: 'msg_reply', busy: true })
    expect(fake.sleeps).toEqual([])
  })

  it('says the chat is free when the reply ends before it ever named a message', async () => {
    const fake = fakeDeps({ busy: [true, true, false], targets: [null] })

    expect(await waitForReplyTarget(fake.deps, 60_000)).toEqual({ target: null, busy: false })
  })

  it('stops at the ceiling and says the reply is still starting', async () => {
    const fake = fakeDeps({ busy: [true], targets: [null] })

    expect(await waitForReplyTarget(fake.deps, 5_000)).toEqual({ target: null, busy: true })
    expect(fake.elapsed()).toBeGreaterThanOrEqual(5_000)
    expect(fake.elapsed()).toBeLessThan(5_000 + REPLY_END_POLL_MS * 2)
  })
})

