// @vitest-environment node
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { liveReadOtherReaders, refreshedFileReadsActiveFor } from '../liveFileReadAccess.server'

/**
 * SA-137 Round 2: who may use Refreshed File Reads this turn (`refreshedFileReadsActiveFor`), and
 * whose copies a turn may refresh (`liveReadOtherReaders`): read from Redis each time it is asked,
 * carrying each reader's current backend and the group's sharing as the route normalizes it.
 *
 * The vitest Redis fake has `getAgents` and `getSession` but no `getGroup`: the tests assign it.
 */

const USER = 'user-access'
const SESSION = 'session-access'
const GROUP = 'group-access'

type FakeRedis = {
  getAgents: ReturnType<typeof vi.fn>
  getSession: ReturnType<typeof vi.fn>
  getGroup: ReturnType<typeof vi.fn>
}
const fake = redis as unknown as FakeRedis

/** A saved agent row: an API Primary by default, Bash on, on the given backend. */
function agentRow(id: string, options: { type?: string; backend?: string; bashEnabled?: boolean; liveFileReads?: boolean } = {}) {
  return {
    id,
    user_id: USER,
    name: id,
    agentType: options.type ?? 'api',
    ...(options.liveFileReads === undefined ? {} : { live_file_reads: options.liveFileReads }),
    provider_specific_settings: {
      nativeTools: {
        executionBackend: options.backend ?? 'local',
        ...(options.bashEnabled === undefined ? {} : { bashEnabled: options.bashEnabled })
      }
    }
  }
}

/** Runs `run` with `process.platform` (and the host the typed tools read) reported as `platform`. */
async function withPlatform<T>(platform: string, run: () => Promise<T> | T): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...original, value: platform })
  const hostPlatform = vi.spyOn(os, 'platform').mockReturnValue(platform as NodeJS.Platform)
  try {
    return await run()
  } finally {
    hostPlatform.mockRestore()
    Object.defineProperty(process, 'platform', original)
  }
}

const entries = (answer: { readers: ReadonlyMap<string, { backend: string }> }) => Object.fromEntries(answer.readers)

let hadGetGroup = false
let originalGetGroup: unknown

beforeEach(() => {
  hadGetGroup = Object.prototype.hasOwnProperty.call(redis, 'getGroup')
  originalGetGroup = (redis as any).getGroup
  fake.getGroup = vi.fn(async () => null)
  vi.spyOn(redis as any, 'getAgents').mockResolvedValue([])
  vi.spyOn(redis as any, 'getSession').mockResolvedValue({ id: SESSION, user_id: USER, metadata: {} })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (hadGetGroup) (redis as any).getGroup = originalGetGroup
  else delete (redis as any).getGroup
  delete process.env.BATSHIT_CONTAINERIZED
})

describe('liveReadOtherReaders: a chat that is not a group (it changed agents)', () => {
  const ask = (...ids: string[]) => liveReadOtherReaders({ userId: USER, sessionId: SESSION })(ids)

  it('asking for nobody answers nobody and reads nothing', async () => {
    expect(await ask()).toEqual({ readers: new Map(), sharedTools: [] })
    expect(fake.getAgents).not.toHaveBeenCalled()
    expect(fake.getSession).not.toHaveBeenCalled()
  })

  it('has no sharing gate (sharedTools null) and names this user\'s API agents with Bash on and a host-mounting backend', async () => {
    fake.getAgents.mockResolvedValue([
      agentRow('a'),
      agentRow('b', { backend: 'local' }),
      agentRow('cli', { type: 'cli' }),
      agentRow('nobash', { bashEnabled: false }),
      agentRow('other-app', { type: 'n8n' })
    ])
    const answer = await withPlatform('darwin', () => ask('a', 'b', 'cli', 'nobash', 'other-app', 'deleted'))
    expect(answer.sharedTools).toBeNull()
    expect(entries(answer)).toEqual({ a: { backend: 'local' }, b: { backend: 'local' } })
    expect(fake.getAgents).toHaveBeenCalledWith(USER)
    expect(fake.getSession).toHaveBeenCalledWith(SESSION)
    expect(fake.getGroup).not.toHaveBeenCalled()
  })

  it('a reader\'s own Refreshed File Reads setting is not its authority: ON, OFF or unset, the reader still counts', async () => {
    fake.getAgents.mockResolvedValue([
      agentRow('on', { liveFileReads: true }),
      agentRow('off', { liveFileReads: false }),
      agentRow('unset')
    ])
    expect(Object.keys(entries(await ask('on', 'off', 'unset'))).sort()).toEqual(['off', 'on', 'unset'])
  })

  it('names Apple Container and Docker Sandbox readers only where those sandboxes mount the host folder, with the backend they have now', async () => {
    fake.getAgents.mockResolvedValue([
      agentRow('local'),
      agentRow('apple', { backend: 'apple_container' }),
      agentRow('docker', { backend: 'docker_sandbox' })
    ])
    const mac = await withPlatform('darwin', () => ask('local', 'apple', 'docker'))
    expect(entries(mac)).toEqual({ local: { backend: 'local' }, apple: { backend: 'apple_container' }, docker: { backend: 'docker_sandbox' } })
    const linux = await withPlatform('linux', () => ask('local', 'apple', 'docker'))
    expect(entries(linux)).toEqual({ local: { backend: 'local' } })
    const windows = await withPlatform('win32', () => ask('local', 'apple', 'docker'))
    expect(entries(windows)).toEqual({})
  })

  it('answers from Redis each time it is asked: a reader removed or changed between two asks is not carried over', async () => {
    const reader = liveReadOtherReaders({ userId: USER, sessionId: SESSION })
    fake.getAgents.mockClear()
    fake.getAgents.mockResolvedValue([agentRow('a')])
    expect(entries(await withPlatform('darwin', () => reader(['a'])))).toEqual({ a: { backend: 'local' } })
    fake.getAgents.mockResolvedValue([agentRow('a', { backend: 'docker_sandbox' })])
    expect(entries(await withPlatform('darwin', () => reader(['a'])))).toEqual({ a: { backend: 'docker_sandbox' } })
    fake.getAgents.mockResolvedValue([])
    expect(entries(await withPlatform('darwin', () => reader(['a'])))).toEqual({})
    expect(fake.getAgents).toHaveBeenCalledTimes(3)
  })
})

describe('liveReadOtherReaders: a group chat', () => {
  const inGroup = () => fake.getSession.mockResolvedValue({ id: SESSION, user_id: USER, metadata: { group_chat: { group_id: GROUP } } })
  const ask = (...ids: string[]) => withPlatform('darwin', () => liveReadOtherReaders({ userId: USER, sessionId: SESSION })(ids))
  const group = (extra: Record<string, unknown>) => ({ id: GROUP, user_id: USER, agent_ids: ['a', 'b'], ...extra })

  beforeEach(() => {
    inGroup()
    fake.getAgents.mockResolvedValue([agentRow('a'), agentRow('b'), agentRow('c')])
  })

  it('names the group\'s members only, with the group\'s sharing as the route normalizes it', async () => {
    fake.getGroup.mockResolvedValue(group({ shared_tools: ['read_file', ' bash ', 'read_file', ''] }))
    const answer = await ask('a', 'b', 'c')
    expect(fake.getGroup).toHaveBeenCalledWith(GROUP)
    expect(entries(answer)).toEqual({ a: { backend: 'local' }, b: { backend: 'local' } })
    expect(answer.sharedTools).toEqual(['read_file', 'bash'])
  })

  it('falls back to zip_settings.shared_tools when the group has no shared_tools of its own', async () => {
    fake.getGroup.mockResolvedValue(group({ zip_settings: { shared_tools: ['read_file', 'grep'] } }))
    expect((await ask('a')).sharedTools).toEqual(['read_file', 'grep'])
    // The group's own list wins over the fallback, including an empty one.
    fake.getGroup.mockResolvedValue(group({ shared_tools: [], zip_settings: { shared_tools: ['read_file'] } }))
    expect((await ask('a')).sharedTools).toEqual([])
  })

  it('a group that shares nothing answers an empty list (not null): the turn then tests every copy against nothing', async () => {
    fake.getGroup.mockResolvedValue(group({}))
    const answer = await ask('a')
    expect(answer.sharedTools).toEqual([])
    expect(answer.sharedTools).not.toBeNull()
    expect(entries(answer)).toEqual({ a: { backend: 'local' } })
  })

  it('a member who is no longer one of this user\'s API agents, or has lost Bash, is not named', async () => {
    fake.getAgents.mockResolvedValue([agentRow('a'), agentRow('b', { bashEnabled: false })])
    fake.getGroup.mockResolvedValue(group({ agent_ids: ['a', 'b', 'gone'], shared_tools: ['read_file'] }))
    expect(entries(await ask('a', 'b', 'gone'))).toEqual({ a: { backend: 'local' } })
  })

  it('another user\'s group, or a group that no longer exists, names no one and shares nothing', async () => {
    fake.getGroup.mockResolvedValue(group({ user_id: 'someone-else', shared_tools: ['read_file'] }))
    expect(await ask('a', 'b')).toEqual({ readers: new Map(), sharedTools: [] })
    fake.getGroup.mockResolvedValue(null)
    expect(await ask('a', 'b')).toEqual({ readers: new Map(), sharedTools: [] })
  })
})

describe('liveReadOtherReaders: a failure to answer allows no one', () => {
  const ask = () => liveReadOtherReaders({ userId: USER, sessionId: SESSION })(['a'])

  it.each([
    ['the agents', () => fake.getAgents.mockRejectedValue(new Error('redis is down'))],
    ['the session', () => fake.getSession.mockRejectedValue(new Error('redis is down'))],
    ['the group', () => {
      fake.getSession.mockResolvedValue({ id: SESSION, user_id: USER, metadata: { group_chat: { group_id: GROUP } } })
      fake.getAgents.mockResolvedValue([agentRow('a')])
      fake.getGroup.mockRejectedValue(new Error('redis is down'))
    }]
  ])('Redis throwing while it reads %s answers no readers, shares nothing, and warns', async (_what, arrange) => {
    arrange()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await ask()).toEqual({ readers: new Map(), sharedTools: [] })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('Could not confirm other readers for Refreshed File Reads')
    expect(String(warn.mock.calls[0][1])).toContain('redis is down')
  })
})

describe('refreshedFileReadsActiveFor', () => {
  const api = (extra: Record<string, unknown> = {}) => ({ id: 'agent', agentType: 'api', live_file_reads: true, ...extra })
  const on = (agent: Record<string, any> | null, global: Record<string, any> | null = null, backend: unknown = 'local', platform = 'darwin') =>
    withPlatform(platform, () => refreshedFileReadsActiveFor(agent, global, backend))

  it('is on for an API agent with the setting on, the appended Zip view and a local backend on a Mac or Linux host', async () => {
    expect(await on(api())).toBe(true)
    expect(await on(api(), null, 'local', 'linux')).toBe(true)
  })

  it('needs the setting: the agent\'s own value, else the global one, else the factory value (ON since 2026-11-04, D13); an explicit false stays false', async () => {
    expect(await on(null)).toBe(false)
    expect(await on(api({ live_file_reads: undefined }))).toBe(true)
    expect(await on(api({ live_file_reads: undefined }), { live_file_reads: false })).toBe(false)
    expect(await on(api({ live_file_reads: false }), { live_file_reads: true })).toBe(false)
    expect(await on(api({ live_file_reads: undefined }), { live_file_reads: true })).toBe(true)
    expect(await on(api({ live_file_reads: null }), { live_file_reads: true })).toBe(true)
  })

  it('is off for a CLI agent and for the inline Zip view, whichever level sets it, and leaves the saved value alone', async () => {
    const cli = api({ agentType: 'cli' })
    expect(await on(cli)).toBe(false)
    expect(cli.live_file_reads).toBe(true)
    expect(await on(api({ zip_ai_view_mode: 'inline' }))).toBe(false)
    expect(await on(api(), { zip_ai_view_mode: 'inline' })).toBe(false)
    expect(await on(api({ zip_ai_view_mode: 'appended' }), { zip_ai_view_mode: 'inline' })).toBe(true)
  })

  it.each([
    ['apple_container', 'darwin', true],
    ['docker_sandbox', 'darwin', true],
    ['apple_container', 'linux', false],
    ['docker_sandbox', 'linux', false],
    ['local', 'win32', false],
    ['remote', 'darwin', false],
    [null, 'darwin', false]
  ] as const)('with the %s backend on %s the answer is %s', async (backend, platform, expected) => {
    expect(await on(api(), null, backend, platform)).toBe(expected)
  })

  it('is off inside the app container, whatever the backend', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    expect(await on(api())).toBe(false)
    expect(await on(api(), null, 'apple_container')).toBe(false)
  })
})
