import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetStreamAbortRegistryForTests,
  abortStream,
  clearGroupAbort,
  clearStreamAbort,
  getActiveSessionTurn,
  hasRunningRequest,
  isSessionDeleting,
  registerGroupAbort,
  registerSessionTurn,
  registerStreamAbort,
  releaseSessionTurn
} from '$lib/server/services/streamAbortRegistry'
import {
  __resetWakeRunRegistryForTests,
  registerWakeRun
} from '$lib/server/services/wakeRunRegistry'
import {
  SESSION_DELETE_TURN_STOP_MS,
  SessionDeleteRefusedError,
  deleteSessionAfterItsTurn,
  isStoppedForSessionDelete
} from '$lib/server/services/sessionDeleteTurnStop'

// Watched, never run: the delete leaves the chat's sandboxes to the reply's own run-end sweep.
const sandboxRemoval = vi.hoisted(() => vi.fn(async (_sessionId: string) => [] as string[]))
vi.mock('$lib/server/services/nativeTools', () => ({
  nativeToolService: { cleanupExecutionSandboxesForSession: sandboxRemoval }
}))

/**
 * Deleting a chat stops its running turn, and sweeps only once that turn's request is done
 * (2026-09-18).
 *
 * Measured before, on the dev lane (`_local/deletemid-proof/before-*.json`): a chat deleted
 * while its Codex or API reply ran `sleep 20` was swept in 35-85 ms, the reply's request ran on
 * for another 20 seconds, and it wrote the reply's message, the message list, its zip, the zip
 * set, and (when the delete beat its first snapshot) the Execution Viewer log back into a chat
 * that no longer existed. Nothing sweeps those later. These drive the REAL lock registry and
 * the REAL woken-turn registry.
 *
 * The delete does not remove the chat's sandboxes itself (2026-09-18). A Stop ends the reply's
 * commands and what they started, and the reply's request removes the chat's sandboxes in its
 * run-end sweep before it lets go; the delete's own removal, from before a Stop ended commands,
 * made that sweep find nothing and log "failed to delete container … not found".
 */

const SESSION = 'session-delete-mid-reply'

beforeEach(() => {
  __resetStreamAbortRegistryForTests()
  __resetWakeRunRegistryForTests()
  sandboxRemoval.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  __resetStreamAbortRegistryForTests()
  __resetWakeRunRegistryForTests()
})

function streamingReply(messageId = 'msg_reply') {
  const reply = registerSessionTurn(SESSION, 'single', messageId)
  if (!reply.ok) throw new Error('registration refused')
  const controller = new AbortController()
  registerStreamAbort(SESSION, messageId, controller)
  return { turn: reply.entry, controller }
}

/** Start a delete without awaiting it, and record when it sweeps and how it ends. */
function startDelete(order: string[] = []) {
  const record: { outcome: unknown; error: unknown; order: string[] } = {
    outcome: null,
    error: null,
    order
  }
  const sweep = vi.fn(async () => {
    order.push('sweep')
  })
  void deleteSessionAfterItsTurn(SESSION, sweep).then(
    (value) => {
      record.outcome = value
    },
    (error) => {
      record.error = error
    }
  )
  return { record, sweep }
}

describe('deleteSessionAfterItsTurn', () => {
  it('sweeps at once when no turn holds the chat, and leaves its commands alone', async () => {
    const sweep = vi.fn(async () => undefined)

    await expect(deleteSessionAfterItsTurn(SESSION, sweep)).resolves.toEqual({ kind: 'no_turn' })

    expect(sweep).toHaveBeenCalledTimes(1)
    expect(sandboxRemoval).not.toHaveBeenCalled()
    expect(isSessionDeleting(SESSION)).toBe(false)
  })

  it('stops a streaming reply, and sweeps only after its request lets go', async () => {
    vi.useFakeTimers()
    const { turn, controller } = streamingReply()
    const { record, sweep } = startDelete()

    await vi.advanceTimersByTimeAsync(0)
    expect(controller.signal.aborted).toBe(true)
    expect(controller.signal.reason).toBe('session_deleted')
    // send-routed answers that request with the delete's words, and a Stop with its own.
    expect(isStoppedForSessionDelete(controller.signal.reason)).toBe(true)
    expect(isStoppedForSessionDelete('user')).toBe(false)
    // The Stop ends the reply's commands; its request removes the chat's sandboxes.
    expect(sandboxRemoval).not.toHaveBeenCalled()

    // The stopped reply's request writes what a stopped reply writes (its message, its zips,
    // its Execution Viewer snapshot) and runs its after-reply work. The delete waits for it,
    // and no new turn may start meanwhile.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(sweep).not.toHaveBeenCalled()
    expect(registerSessionTurn(SESSION, 'single', 'msg_next')).toEqual({
      ok: false,
      reason: 'session_deleting'
    })

    clearStreamAbort(SESSION, 'msg_reply')
    record.order.push('released')
    releaseSessionTurn(SESSION, turn.turnId)
    await vi.advanceTimersByTimeAsync(150)

    expect(record.order).toEqual(['released', 'sweep'])
    expect(record.outcome).toMatchObject({ kind: 'stopped' })
    expect(isSessionDeleting(SESSION)).toBe(false)
  })

  it('stops a turn that was still setting up as soon as its stream registers', async () => {
    // Setup (the compile, the snapshot, the bridge) runs before the stream is registered, so
    // there is nothing to abort yet when the delete arrives.
    vi.useFakeTimers()
    const reply = registerSessionTurn(SESSION, 'single', 'msg_setup')
    if (!reply.ok) throw new Error('registration refused')
    const { record, sweep } = startDelete()
    await vi.advanceTimersByTimeAsync(0)
    // The turn itself is stopped at once: send-routed forwards this into the run, so the setup
    // checkpoint ends it before the provider call instead of after the stream registers.
    expect(reply.entry.stop.signal.aborted).toBe(true)
    expect(reply.entry.stop.signal.reason).toBe('session_deleted')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(sweep).not.toHaveBeenCalled()

    const controller = new AbortController()
    registerStreamAbort(SESSION, 'msg_setup', controller)
    await vi.advanceTimersByTimeAsync(150)
    expect(controller.signal.aborted).toBe(true)
    expect(controller.signal.reason).toBe('session_deleted')

    clearStreamAbort(SESSION, 'msg_setup')
    releaseSessionTurn(SESSION, reply.entry.turnId)
    await vi.advanceTimersByTimeAsync(150)
    expect(sweep).toHaveBeenCalledTimes(1)
    expect(record.outcome).toMatchObject({ kind: 'stopped' })
  })

  it('waits out a turn that is only finishing, and sweeps after its after-reply work', async () => {
    vi.useFakeTimers()
    const { turn } = streamingReply()
    clearStreamAbort(SESSION, 'msg_reply')

    const { record, sweep } = startDelete()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sweep).not.toHaveBeenCalled()
    expect(getActiveSessionTurn(SESSION)).toBe(turn)

    releaseSessionTurn(SESSION, turn.turnId)
    await vi.advanceTimersByTimeAsync(150)
    expect(sweep).toHaveBeenCalledTimes(1)
    expect(record.outcome).toMatchObject({ kind: 'stopped' })
  })

  it('stops a group turn’s run', async () => {
    vi.useFakeTimers()
    const group = registerSessionTurn(SESSION, 'group')
    if (!group.ok) throw new Error('registration refused')
    const controller = new AbortController()
    registerGroupAbort(SESSION, controller)

    const { record } = startDelete()
    await vi.advanceTimersByTimeAsync(0)
    expect(controller.signal.aborted).toBe(true)
    expect(controller.signal.reason).toBe('session_deleted')

    clearGroupAbort(SESSION)
    releaseSessionTurn(SESSION, group.entry.turnId)
    await vi.advanceTimersByTimeAsync(150)
    expect(record.outcome).toMatchObject({ kind: 'stopped' })
  })

  it('stops a turn Batshit started on its own (a woken turn)', async () => {
    // A woken turn's request is made inside this process; only the wake registry's own
    // controller reaches it during its setup (AMD-113-02).
    vi.useFakeTimers()
    const { turn } = streamingReply()
    const wake = new AbortController()
    registerWakeRun({
      sessionId: SESSION,
      agentId: 'agent-woken',
      userId: 'josh',
      origin: {
        version: 1,
        kind: 'dm',
        label: 'DM from Cooper',
        at: '2026-09-18T12:00:00.000Z',
        chainDepth: 1
      } as never,
      startedAt: Date.now(),
      controller: wake,
      timer: setTimeout(() => undefined, 60_000)
    })

    const { record, sweep } = startDelete()
    await vi.advanceTimersByTimeAsync(0)
    expect(wake.signal.aborted).toBe(true)
    expect(wake.signal.reason).toBe('wake_stop')

    releaseSessionTurn(SESSION, turn.turnId)
    await vi.advanceTimersByTimeAsync(150)
    expect(sweep).toHaveBeenCalledTimes(1)
    expect(record.outcome).toMatchObject({ kind: 'stopped' })
  })

  it('refuses at the bound, thirty seconds, sweeps nothing, and gives the chat back', async () => {
    vi.useFakeTimers()
    const { turn } = streamingReply()
    const { record, sweep } = startDelete()

    await vi.advanceTimersByTimeAsync(29_800)
    expect(record.error).toBeNull()
    await vi.advanceTimersByTimeAsync(400)

    expect(SESSION_DELETE_TURN_STOP_MS).toBe(30_000)
    expect(record.error).toBeInstanceOf(SessionDeleteRefusedError)
    expect((record.error as SessionDeleteRefusedError).code).toBe('session_turn_still_stopping')
    expect((record.error as SessionDeleteRefusedError).status).toBe(409)
    expect(sweep).not.toHaveBeenCalled()
    expect(isSessionDeleting(SESSION)).toBe(false)
    // The request is still running, and still the only one that can say it is done.
    expect(hasRunningRequest(SESSION)).toBe(true)
    releaseSessionTurn(SESSION, turn.turnId)
    expect(hasRunningRequest(SESSION)).toBe(false)
  })

  it('makes a retry wait for the request the refused delete could not stop, lock or no lock', async () => {
    // After the refusal the chat is back under the ordinary rules, and the aborted-stream grace
    // takes the stopped request's lock. The request is still running and may still write, so a
    // retry must not sweep past it.
    vi.useFakeTimers()
    const { turn } = streamingReply()
    const first = startDelete()
    await vi.advanceTimersByTimeAsync(30_100)
    expect(first.record.error).toBeInstanceOf(SessionDeleteRefusedError)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(getActiveSessionTurn(SESSION)).toBeNull()

    const retry = startDelete()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(retry.sweep).not.toHaveBeenCalled()

    releaseSessionTurn(SESSION, turn.turnId)
    await vi.advanceTimersByTimeAsync(150)
    expect(retry.sweep).toHaveBeenCalledTimes(1)
    expect(retry.record.outcome).toMatchObject({ kind: 'stopped' })
  })

  it('waits for a request a Stop already stopped, whose lock the grace has taken', async () => {
    // Measured on the API lane (`_local/deletemid-proof/stoptime-api-1.json`): after a Stop the
    // request ran on for 22 s behind its command, and its lock went after five. A delete then
    // saw no lock at all.
    vi.useFakeTimers()
    const { turn } = streamingReply()
    abortStream(SESSION, 'user')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(getActiveSessionTurn(SESSION)).toBeNull()

    const { record, sweep } = startDelete()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(sweep).not.toHaveBeenCalled()

    clearStreamAbort(SESSION, 'msg_reply')
    releaseSessionTurn(SESSION, turn.turnId)
    await vi.advanceTimersByTimeAsync(150)
    expect(sweep).toHaveBeenCalledTimes(1)
    expect(record.outcome).toMatchObject({ kind: 'stopped' })
  })

  it('refuses a second delete of the chat while the first is stopping its turn', async () => {
    vi.useFakeTimers()
    const { turn } = streamingReply()
    const first = startDelete()
    await vi.advanceTimersByTimeAsync(0)

    const secondSweep = vi.fn(async () => undefined)
    const second = deleteSessionAfterItsTurn(SESSION, secondSweep)
    await expect(second).rejects.toMatchObject({
      code: 'session_delete_in_progress',
      status: 409
    })
    expect(secondSweep).not.toHaveBeenCalled()
    // The second refusal does not end the first delete's mark.
    expect(isSessionDeleting(SESSION)).toBe(true)

    releaseSessionTurn(SESSION, turn.turnId)
    await vi.advanceTimersByTimeAsync(150)
    expect(first.sweep).toHaveBeenCalledTimes(1)
  })

  it('ends the mark when the sweep itself fails', async () => {
    const failing = vi.fn(async () => {
      throw new Error('redis down')
    })

    await expect(deleteSessionAfterItsTurn(SESSION, failing)).rejects.toThrow('redis down')
    expect(isSessionDeleting(SESSION)).toBe(false)
  })
})
