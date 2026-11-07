import { afterEach, describe, expect, it, vi } from 'vitest'

// BL-2863: concurrent ensures share one run. The physical revision behavior has its real Redis owner
// (slashCommandRevision.redis.test.ts); this file holds only who runs and who waits.
const ensureBuiltinAgentPluginMock = vi.hoisted(() => vi.fn())
const captureBasisMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/redis', () => ({ redis: { json: { get: vi.fn(), set: vi.fn() }, del: vi.fn() } }))
vi.mock('$lib/server/services/skillRegistry', () => ({ upsertSkill: vi.fn() }))
vi.mock('$lib/server/services/agentPlugins', () => ({ ensureBuiltinAgentPlugin: ensureBuiltinAgentPluginMock }))
vi.mock('$lib/server/services/slashCommandRevision', async importOriginal => ({
  ...await importOriginal<typeof import('$lib/server/services/slashCommandRevision')>(),
  captureSlashCommandWriteBasis: captureBasisMock
}))

import { ensureSystemSlashCommands } from '../systemSlashCommands'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('ensureSystemSlashCommands runs once at a time per user (BL-2863)', () => {
  afterEach(() => vi.clearAllMocks())

  it('lets concurrent callers join the running check, then starts afresh once it settles', async () => {
    const gate = deferred()
    ensureBuiltinAgentPluginMock.mockReturnValue(gate.promise)
    const stop = new Error('stop after the shared step')
    captureBasisMock.mockRejectedValue(stop)

    const calls = [ensureSystemSlashCommands('user_a'), ensureSystemSlashCommands('user_a'), ensureSystemSlashCommands('user_a')]
    const other = ensureSystemSlashCommands('user_b')
    expect(ensureBuiltinAgentPluginMock).toHaveBeenCalledTimes(2)
    expect(ensureBuiltinAgentPluginMock.mock.calls.map(([userId]) => userId)).toEqual(['user_a', 'user_b'])

    gate.resolve()
    for (const call of [...calls, other]) await expect(call).rejects.toBe(stop)
    expect(captureBasisMock).toHaveBeenCalledTimes(2)

    // A settled run, failed or not, is never reused.
    ensureBuiltinAgentPluginMock.mockResolvedValue(undefined)
    await expect(ensureSystemSlashCommands('user_a')).rejects.toBe(stop)
    expect(ensureBuiltinAgentPluginMock).toHaveBeenCalledTimes(3)
  })
})
