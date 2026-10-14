/**
 * BL-977: `ProviderManager.createForUser` reads the saved Local AI servers. When that read fails the
 * manager still builds (cloud models do not depend on the Local AI records), but a request for a
 * local model must say WHY there is none. It used to say "Provider lmstudio not configured", which
 * sends the user to Settings to fix something that is not broken. The read fails in the REAL Redis
 * wrapper; the real service and the real manager run on the default lane's Redis fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { failRedisJsonGets, stopFailingRedisJsonGets } from '$lib/test-utils/failRedisJsonGets'
import { saveLocalAiServers } from '$lib/server/services/localAiServers'
import { ProviderManager } from '../index'

vi.mock('$env/dynamic/private', () => ({ env: {} }))

useRedisTestServer()

const USER = 'bl977_manager_user'
const lmStudioRequest = { transport: 'direct' as const, service: 'lmstudio' }

describe('ProviderManager.createForUser when the saved Local AI servers cannot be read (BL-977)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    stopFailingRedisJsonGets()
    vi.restoreAllMocks()
  })

  const seedLmStudio = () =>
    saveLocalAiServers(USER, [
      { id: 'lmstudio', baseUrl: 'http://192.168.1.21:1234', openaiPath: '/v1', enabled: true }
    ])

  it('a user with only local programs (no cloud key at all): a request for a local model says the servers could not be read, not "No available provider"', async () => {
    await seedLmStudio()
    const failing = failRedisJsonGets((key) => key.startsWith(`local_provider:${USER}:`))
    const manager = await ProviderManager.createForUser(USER)
    expect(failing.failures).toBeGreaterThanOrEqual(1)
    failing.stop()

    expect(() => manager.getModel('local-model', lmStudioRequest)).toThrow(
      'LM Studio is not available: the saved Local AI servers could not be read. Try again.'
    )
  })

  it('a request for something that is not a local program keeps its own message', async () => {
    const failing = failRedisJsonGets((key) => key.startsWith(`local_provider:${USER}:`))
    const manager = await ProviderManager.createForUser(USER)
    failing.stop()

    expect(() => manager.getModel('some-model', { transport: 'direct', service: 'xai' })).toThrow(
      'No available provider'
    )
  })

  it('a user with a cloud key: the manager still builds, the cloud model works, and the local model says the servers could not be read', () => {
    const manager = new ProviderManager({
      apiKeys: { openai: 'sk-zcpause0123456789' },
      localProvidersUnreadable: true
    })
    expect(() => manager.getModel('gpt-4.1', { transport: 'direct', service: 'openai' })).not.toThrow()
    expect(() => manager.getModel('local-model', lmStudioRequest)).toThrow(
      'LM Studio is not available: the saved Local AI servers could not be read. Try again.'
    )
    expect(() => manager.getModel('grok', { transport: 'direct', service: 'xai' })).toThrow(
      'Provider xai not configured'
    )
  })

  it('regression guard, not a proof of a fix (green on the parent code too): with a good read, a local program that was never saved says "not configured"', () => {
    const manager = new ProviderManager({ apiKeys: { openai: 'sk-zcpause0123456789' } })
    expect(() => manager.getModel('local-model', lmStudioRequest)).toThrow('Provider lmstudio not configured')
  })

  it('regression guard, not a proof of a fix (green on the parent code too): with the read working, the saved local program is registered', async () => {
    await seedLmStudio()
    const manager = await ProviderManager.createForUser(USER)
    expect(() => manager.getModel('local-model', lmStudioRequest)).not.toThrow()
  })

})
