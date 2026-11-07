import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

/**
 * BL-157 (2026-09-25): deleting a CLI Subagent deletes its managed profile folder,
 * `~/.batshit/agents/batshit_agent_subagent_cli_<slug>/` (every CLI home inside it, its config,
 * logs and prompts included). The folder is named for the Subagent's slug, so a folder another
 * of the user's Subagents resolves to is theirs too and stays.
 *
 * The folder deletes are the ones the Primary Agent delete uses (reviewed in BL-7: Claude's
 * refuses a `.claude` that is not a managed home and unlinks a symlinked one;
 * `deleteManagedProfileFolder` removes the profile folder without following links);
 * `claudeManagedHome.test.ts` pins them.
 */

const calls = vi.hoisted(() => [] as string[])
vi.mock('$lib/server/services/managedProfileFolderDelete', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/managedProfileFolderDelete')>()
  return {
    ...actual,
    deleteManagedProfileFolder: vi.fn(async (id: string) => {
      calls.push(`folder ${id}`)
    })
  }
})
vi.mock('$lib/server/services/claudeProfileManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/claudeProfileManager')>()
  return {
    ...actual,
    deleteAgentClaudeConfig: vi.fn(async (id: string) => {
      calls.push(`claude ${id}`)
    })
  }
})

useRedisTestServer()

const USER = 'user-cli-subagent-delete'

async function seedSubagent(record: Record<string, unknown>) {
  await redis.json.set(`subagent:${record.id}`, '$', { user_id: USER, ...record })
  await redis.sAdd(`user:${USER}:subagents`, String(record.id))
}

// The real profile managers are a large module graph; load it once, outside any one test's
// time limit (under a full lane's load the first import alone took more than five seconds).
let deleteManagedCliSubagentProfile: typeof import('$lib/server/services/cliSubagentProfileSync').deleteManagedCliSubagentProfile
beforeAll(async () => {
  ;({ deleteManagedCliSubagentProfile } = await import('$lib/server/services/cliSubagentProfileSync'))
}, 120_000)

beforeEach(() => {
  calls.length = 0
})

describe('deleteManagedCliSubagentProfile (BL-157)', () => {
  it('removes the Claude home, then the whole profile folder, named for the Subagent’s slug', async () => {
    await seedSubagent({ id: 'cli_subagent' })

    const result = await deleteManagedCliSubagentProfile(USER, { id: 'cli_subagent', user_id: USER } as any)

    expect(result).toEqual({
      profileId: 'batshit_agent_subagent_cli_cli_subagent',
      deleted: true,
      sharedWith: null,
      sharedWithKind: null
    })
    expect(calls).toEqual(['claude subagent_cli_cli_subagent', 'folder subagent_cli_cli_subagent'])
  })

  it('a stored slug names the folder, not the id', async () => {

    const result = await deleteManagedCliSubagentProfile(USER, { id: 'researcher_2', slug: 'Researcher', user_id: USER } as any)

    expect(result.profileId).toBe('batshit_agent_subagent_cli_researcher')
    expect(calls).toEqual(['claude subagent_cli_researcher', 'folder subagent_cli_researcher'])
  })

  it('a folder another of the user’s Subagents resolves to stays, and says whose it is', async () => {
    await seedSubagent({ id: 'researcher_2', slug: 'researcher' })
    await seedSubagent({ id: 'researcher' })

    const result = await deleteManagedCliSubagentProfile(USER, { id: 'researcher_2', slug: 'researcher', user_id: USER } as any)

    expect(result).toEqual({
      profileId: 'batshit_agent_subagent_cli_researcher',
      deleted: false,
      sharedWith: 'researcher',
      sharedWithKind: 'subagent'
    })
    expect(calls).toEqual([])
  })

  // BL-285 (2026-09-27): a Primary Agent's folder is `batshit_agent_<id lowercased>`, so one
  // with the id `subagent_cli_<slug>` (creation refuses that id since BL-285, older ones may
  // exist) owns the Subagent's folder too; the delete used to check only Subagents.
  it('a folder one of the user’s Primary Agents resolves to stays, and says whose it is', async () => {
    await seedSubagent({ id: 'helper' })
    await redis.sAdd(`user:${USER}:agents`, 'Subagent_CLI_Helper')

    const result = await deleteManagedCliSubagentProfile(USER, { id: 'helper', user_id: USER } as any)

    expect(result).toEqual({
      profileId: 'batshit_agent_subagent_cli_helper',
      deleted: false,
      sharedWith: 'Subagent_CLI_Helper',
      sharedWithKind: 'agent'
    })
    expect(calls).toEqual([])
    await redis.sRem(`user:${USER}:agents`, 'Subagent_CLI_Helper')
  })

  it('a failure propagates, so the Subagent delete can keep the Subagent for a retry', async () => {
    const folders = await import('$lib/server/services/managedProfileFolderDelete')
    vi.mocked(folders.deleteManagedProfileFolder).mockRejectedValueOnce(new Error('EACCES: permission denied'))

    await expect(
      deleteManagedCliSubagentProfile(USER, { id: 'cli_subagent', user_id: USER } as any)
    ).rejects.toThrow(/EACCES/)
  })
})

// BL-393 (2026-09-27): a Primary Agent's Workers run in slot folders of their own (holding the
// Workers' prompts and logs), and the agent's delete removed only its own folder. It now removes the slots too, under both names a slot has had (BL-285), never a slot
// another record also owns.
describe('deleteAgentWorkerProfiles (BL-393)', () => {
  let deleteAgentWorkerProfiles: typeof import('$lib/server/services/cliSubagentProfileSync').deleteAgentWorkerProfiles
  beforeAll(async () => {
    ;({ deleteAgentWorkerProfiles } = await import('$lib/server/services/cliSubagentProfileSync'))
  }, 120_000)

  it('removes all six slots (delegation limits: six Workers at a time), under the current and the pre-BL-285 name, Claude home first', async () => {
    const result = await deleteAgentWorkerProfiles(USER, 'Cooper')

    expect(result.kept).toEqual([])
    expect(result.deleted).toEqual(
      [1, 2, 3, 4, 5, 6].flatMap((slot) => [
        `batshit_agent_subagent_cli-worker_cooper_${slot}`,
        `batshit_agent_subagent_cli_worker_cooper_${slot}`
      ])
    )
    expect(calls.slice(0, 4)).toEqual([
      'claude subagent_cli-worker_cooper_1',
      'folder subagent_cli-worker_cooper_1',
      'claude subagent_cli_worker_cooper_1',
      'folder subagent_cli_worker_cooper_1'
    ])
    expect(calls).toHaveLength(24)
  })

  it('keeps an old-name slot a Subagent slugged like it owns (BL-285’s collision)', async () => {
    await seedSubagent({ id: 'worker_cooper_2' })

    const result = await deleteAgentWorkerProfiles(USER, 'cooper')

    expect(result.kept).toEqual([
      { profileId: 'batshit_agent_subagent_cli_worker_cooper_2', sharedWith: 'worker_cooper_2', sharedWithKind: 'subagent' }
    ])
    expect(calls).not.toContain('folder subagent_cli_worker_cooper_2')
    expect(calls).not.toContain('claude subagent_cli_worker_cooper_2')
    expect(calls).toContain('folder subagent_cli-worker_cooper_2')
    await redis.del('subagent:worker_cooper_2')
    await redis.sRem(`user:${USER}:subagents`, 'worker_cooper_2')
  })

  it('keeps an old-name slot an older agent’s own folder is (its id is the slot’s runtime id)', async () => {
    await redis.sAdd(`user:${USER}:agents`, 'subagent_cli_worker_cooper_3')

    const result = await deleteAgentWorkerProfiles(USER, 'cooper')

    expect(result.kept).toEqual([
      {
        profileId: 'batshit_agent_subagent_cli_worker_cooper_3',
        sharedWith: 'subagent_cli_worker_cooper_3',
        sharedWithKind: 'agent'
      }
    ])
    expect(calls).not.toContain('folder subagent_cli_worker_cooper_3')
    await redis.sRem(`user:${USER}:agents`, 'subagent_cli_worker_cooper_3')
  })

  it('keeps every slot while another of the user’s agents has the same slug (their Workers share them)', async () => {
    await redis.sAdd(`user:${USER}:agents`, 'cooper')

    const result = await deleteAgentWorkerProfiles(USER, 'Cooper')

    expect(result.deleted).toEqual([])
    // Six slots, each under its current and its pre-BL-285 name.
    expect(result.kept).toHaveLength(12)
    expect(result.kept[0]).toEqual({
      profileId: 'batshit_agent_subagent_cli-worker_cooper_1',
      sharedWith: 'cooper',
      sharedWithKind: 'agent'
    })
    expect(calls).toEqual([])
    await redis.sRem(`user:${USER}:agents`, 'cooper')
  })
})

