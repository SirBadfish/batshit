import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { RedisService } from '$lib/server/redis'

/**
 * BL-2387: `RedisService.updateProject` reads the project, merges the update and writes the whole
 * record back. A delete that landed between the read and the write used to be undone: the write
 * made the deleted project again. The write is now `JSON.SET … XX`, which only writes while the
 * key exists.
 *
 * Real Redis 8 only (`npm run test:redis`, DB15): the default lane's fake replaces the whole
 * service, so it has no `updateProject` to prove. The delete is placed exactly between the read
 * and the write by wrapping the real client the service hands its own operation.
 */
const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'

useRedisTestServer()

const USER = 'bl2387_user'
const PROJECT = 'project_bl2387'
const KEY = `project:${USER}:${PROJECT}`

function record() {
  return {
    id: PROJECT,
    user_id: USER,
    name: 'Alpha',
    root_path: '/fixture/alpha',
    custom_exclusions: [],
    created_at: '2026-10-27T00:00:00.000Z',
    updated_at: '2026-10-27T00:00:00.000Z'
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe.runIf(REAL_REDIS_LANE)('BL-2387: a project update never brings a deleted project back (real Redis)', () => {
  it('updates a project that still exists', async () => {
    const service = new RedisService()
    await service.saveProject(record() as any)
    const updated = await service.updateProject(PROJECT, USER, { name: 'Alpha Renamed' })
    expect(updated.name).toBe('Alpha Renamed')
    expect(((await service.getProjects(USER)) as any[]).map((project) => project.name)).toEqual(['Alpha Renamed'])
    await service.deleteProject(PROJECT, USER)
  })

  it('a delete between the read and the write leaves the project deleted and the update refused', async () => {
    const service = new RedisService()
    await service.saveProject(record() as any)

    const execute = service.execute.bind(service)
    vi.spyOn(service, 'execute').mockImplementation((operation: any) =>
      execute(async (client: any) => {
        const read = client.json.get
        client.json.get = async (...args: any[]) => {
          const value = await read.apply(client.json, args)
          // The user's delete lands right after the update read the record.
          await client.del(KEY)
          return value
        }
        try {
          return await operation(client)
        } finally {
          client.json.get = read
        }
      })
    )

    await expect(service.updateProject(PROJECT, USER, { name: 'Alpha Renamed' })).rejects.toMatchObject({
      message: 'Project not found',
      status: 404
    })
    vi.restoreAllMocks()
    expect(await new RedisService().getProjects(USER)).toEqual([])
  })
})
