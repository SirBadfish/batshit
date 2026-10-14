import { describe, expect, it } from 'vitest'
import {
  forgetCodexCleanupWarnings,
  getCodexCleanupWarning,
  refreshCodexCleanupWarnings
} from '../codexCleanupWarnings.svelte'

function delayedResponse() {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}

const payload = (messageId: string, kind = 'unconfirmed_command_cleanup') => new Response(JSON.stringify({
  records: { [messageId]: { messageId, kind } }
}), { status: 200 })

describe('Codex cleanup warning browser store', () => {
  it('keeps a later warning refresh when an earlier empty hydration finishes afterward', async () => {
    const sessionId = 'cleanup-warning-race'
    const old = delayedResponse()
    const first = refreshCodexCleanupWarnings(sessionId, (() => old.promise) as typeof fetch)
    await refreshCodexCleanupWarnings(sessionId, (async () => payload('reply')) as typeof fetch)
    old.resolve(new Response(JSON.stringify({ records: {} }), { status: 200 }))
    await first
    expect(getCodexCleanupWarning(sessionId, 'reply')?.kind).toBe('unconfirmed_command_cleanup')
    forgetCodexCleanupWarnings(sessionId)
  })

  it('does not revive an old response after the chat was forgotten', async () => {
    const sessionId = 'cleanup-warning-forgotten'
    const old = delayedResponse()
    const request = refreshCodexCleanupWarnings(sessionId, (() => old.promise) as typeof fetch)
    forgetCodexCleanupWarnings(sessionId)
    old.resolve(payload('reply'))
    await request
    expect(getCodexCleanupWarning(sessionId, 'reply')).toBeNull()
  })

  it('replaces an unconfirmed warning with the server-owned recovered kind', async () => {
    const sessionId = 'cleanup-warning-recovered'
    await refreshCodexCleanupWarnings(sessionId, (async () => payload('reply')) as typeof fetch)
    await refreshCodexCleanupWarnings(sessionId, (async () => payload('reply', 'recorded_processes_ended')) as typeof fetch)
    expect(getCodexCleanupWarning(sessionId, 'reply')?.kind).toBe('recorded_processes_ended')
    forgetCodexCleanupWarnings(sessionId)
  })
})
