/**
 * BL-977: the memory embedder's preset lane reads the saved Local AI servers to find the base URL of
 * a local runtime. When that read failed, the list used to answer the built-in DEFAULT address, so
 * the memory vectors of a user whose LM Studio runs at another address were asked of localhost.
 * Now the read fails and the embedding fails with the plain sentence, before any request leaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { memorySearchLaneActive, useMemorySearchTestServer } from '$lib/test-utils/memory-search-server'
import { failRedisJsonGets, stopFailingRedisJsonGets } from '$lib/test-utils/failRedisJsonGets'
import { saveLocalAiServers } from '$lib/server/services/localAiServers'
import { redis } from '$lib/server/redis'
import { createMemoryEmbedder } from '../memoryEmbedder'

vi.mock('$env/dynamic/private', () => ({ env: {} }))

if (memorySearchLaneActive()) useMemorySearchTestServer()
else useRedisTestServer()

const USER = 'bl977_memory_user'
const PRESET_ID = 'preset_bl977'

describe('the memory embedder preset lane when the saved Local AI servers cannot be read (BL-977)', () => {
  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await redis.set(`model:${PRESET_ID}`, {
      id: PRESET_ID,
      provider: 'lmstudio',
      modelId: 'nomic-embed',
      modelName: 'nomic-embed',
      purpose: 'embedding'
    } as never)
    await saveLocalAiServers(USER, [
      { id: 'lmstudio', baseUrl: 'http://192.168.1.21:1234', openaiPath: '/v1', enabled: true }
    ])
  })

  afterEach(() => {
    stopFailingRedisJsonGets()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const embedder = () =>
    createMemoryEmbedder(
      {
        lane: 'preset',
        modelId: 'preset:lmstudio:nomic-embed@768',
        preset: { presetId: PRESET_ID, provider: 'lmstudio', modelName: 'nomic-embed', dims: 768 }
      },
      { userId: USER }
    )

  it('fails with the plain sentence, sends no request, and works again once the read works', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }))
    vi.stubGlobal('fetch', fetchSpy)
    const subject = embedder()

    const failing = failRedisJsonGets((key) => key.startsWith(`local_provider:${USER}:`))
    await expect(subject.embedQuery('hello')).rejects.toThrow('Could not read the saved Local AI servers.')
    expect(fetchSpy).not.toHaveBeenCalled()
    failing.stop()

    // The failed attempt is not remembered: with the read working, the same embedder no longer fails
    // for that reason (whatever else a fake SDK does with the vectors).
    const afterwards = await subject.embedQuery('hello').then(
      () => '',
      (error: Error) => error.message
    )
    expect(afterwards).not.toContain('Could not read the saved Local AI servers.')
  })
})
