import { beforeEach, describe, expect, it, vi } from 'vitest'

const records = vi.hoisted(() => new Map<string, { user_id: string }>())
const readRecord = vi.hoisted(() => vi.fn(async (key: string) => records.get(key) ?? null))
vi.mock('$lib/server/redis', () => ({ redis: { json: { get: readRecord } } }))

import {
  holdAgentProfileFolder,
  isManagedProfileRunRefusal,
  withManagedProfileRunWrite
} from '../agentProfileFolderGate'

const owner = { userId: 'josh', kind: 'agent' as const, id: 'one' }

beforeEach(() => {
  records.clear()
  readRecord.mockReset()
  readRecord.mockImplementation(async (key: string) => records.get(key) ?? null)
})

describe('managed profile run admission', () => {
  it('does not recreate a folder when deletion takes its turn first', async () => {
    records.set('agent:one', { user_id: 'josh' })
    let finishDelete!: () => void
    const deleteMayFinish = new Promise<void>((resolve) => { finishDelete = resolve })
    let deleting!: () => void
    const deleteStarted = new Promise<void>((resolve) => { deleting = resolve })
    const events: string[] = []
    const deletion = holdAgentProfileFolder('batshit_agent_one', async () => {
      events.push('delete starts')
      deleting()
      await deleteMayFinish
      records.delete('agent:one')
      events.push('record removed')
    })
    await deleteStarted
    const start = withManagedProfileRunWrite(owner, 'batshit_agent_one', async () => {
      events.push('folder written')
    })
    finishDelete()
    await deletion
    await expect(start).rejects.toMatchObject({ code: 'MANAGED_PROFILE_RUN_REFUSED' })
    expect(events).toEqual(['delete starts', 'record removed'])
  })

  it('refuses a missing, foreign, or unreadable owner before the folder action', async () => {
    const write = vi.fn(async () => undefined)
    await expect(withManagedProfileRunWrite(owner, 'batshit_agent_one', write)).rejects.toMatchObject({ code: 'MANAGED_PROFILE_RUN_REFUSED' })
    records.set('agent:one', { user_id: 'other' })
    await expect(withManagedProfileRunWrite(owner, 'batshit_agent_one', write)).rejects.toMatchObject({ code: 'MANAGED_PROFILE_RUN_REFUSED' })
    readRecord.mockRejectedValueOnce(new Error('Redis unavailable'))
    await expect(withManagedProfileRunWrite(owner, 'batshit_agent_one', write)).rejects.toMatchObject({ code: 'MANAGED_PROFILE_RUN_REFUSED' })
    await expect(withManagedProfileRunWrite({ ...owner, kind: 'host' }, 'batshit_agent_one', write)).rejects.toMatchObject({ code: 'MANAGED_PROFILE_RUN_REFUSED' })
    expect(write).not.toHaveBeenCalled()
  })

  it('preserves an action error after a verified owner', async () => {
    records.set('subagent:one', { user_id: 'josh' })
    const failure = new Error('disk write failed')
    await expect(withManagedProfileRunWrite(
      { ...owner, kind: 'subagent' },
      'batshit_agent_subagent_cli-one',
      async () => { throw failure }
    )).rejects.toBe(failure)
    expect(isManagedProfileRunRefusal(failure)).toBe(false)
  })

  it.each(['owner read', 'folder action'])('releases the folder turn after a failed %s', async (failureAt) => {
    records.set('agent:one', { user_id: 'josh' })
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve })
    let firstEntered!: () => void
    const firstIsInside = new Promise<void>((resolve) => { firstEntered = resolve })
    if (failureAt === 'owner read') {
      readRecord.mockImplementationOnce(async () => {
        firstEntered()
        await firstMayFinish
        throw new Error('Redis unavailable')
      })
    }
    const first = withManagedProfileRunWrite(owner, 'batshit_agent_one', async () => {
      if (failureAt === 'folder action') {
        firstEntered()
        await firstMayFinish
        throw new Error('disk failed')
      }
    })
    await firstIsInside
    const secondAction = vi.fn(async () => 'wrote')
    const second = withManagedProfileRunWrite(owner, 'batshit_agent_one', secondAction)
    releaseFirst()
    await expect(first).rejects.toThrow(failureAt === 'owner read' ? /could not be verified/ : /disk failed/)
    await expect(second).resolves.toBe('wrote')
    expect(secondAction).toHaveBeenCalledOnce()
  })
})
