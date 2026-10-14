// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { loadRuntimeModelPreset, RuntimeModelPresetError } from '../runtimeModelPreset'

/**
 * BL-517: a send with an AI Gateway preset whose model the gateway no longer lists is refused
 * with a sentence that names the cause. Before, the preset list load deleted such a preset, and
 * the next send said only "Selected primary model preset no longer exists". Now the preset stays,
 * so the send path is where the user learns why it cannot run: the same catalog lookup the list
 * load uses (BL-68's variant match included), read from the cached catalog.
 */

useRedisTestServer()

const CATALOG_KEY = 'vercel:model_catalog:v1'

const SONNET_ROW = {
  id: 'anthropic/claude-sonnet-5',
  canonicalId: 'anthropic/claude-sonnet-5',
  provider: 'anthropic',
  name: 'claude-sonnet-5',
  displayName: 'Claude Sonnet 5',
  tags: [],
  features: { streaming: true, tools: true },
  source: 'vercel',
  idVariants: {
    'vercel-gateway': {
      developerId: 'anthropic',
      modelId: 'claude-sonnet-5',
      effectiveId: 'anthropic/claude-sonnet-5',
      source: 'vercel'
    }
  }
}

function gatewayPreset(id: string, gatewayId: string) {
  const [developer, ...rest] = gatewayId.split('/')
  return {
    id,
    modelName: 'Old GPT',
    provider: developer,
    modelId: rest.join('/'),
    catalogModelId: gatewayId,
    effectiveModelId: gatewayId,
    vercelSourceId: gatewayId,
    isVercelImport: true,
    connection: { type: 'vercel-gateway', service: 'vercel' },
    pricing: {},
    settings: {},
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z'
  }
}

beforeEach(async () => {
  await redis.set(CATALOG_KEY, { models: [SONNET_ROW], fetchedAt: new Date().toISOString() })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network is not used here')
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('loadRuntimeModelPreset (BL-517)', () => {
  it('refuses a gateway preset whose model the gateway no longer lists, naming the gateway and the model', async () => {
    await redis.set('model:zm_old_gpt', gatewayPreset('zm_old_gpt', 'openai/gpt-4.1-old'))

    const attempt = loadRuntimeModelPreset('zm_old_gpt', 'primary')
    await expect(attempt).rejects.toBeInstanceOf(RuntimeModelPresetError)
    await expect(loadRuntimeModelPreset('zm_old_gpt', 'primary')).rejects.toMatchObject({
      status: 400,
      code: 'model_preset_unavailable',
      message:
        'Vercel AI Gateway no longer lists openai/gpt-4.1-old, the model of the selected primary model preset "Old GPT". Pick another model in Agent settings.'
    })
  })

  it('names the Subagent when a Subagent preset is refused', async () => {
    await redis.set('model:zm_old_gpt', gatewayPreset('zm_old_gpt', 'openai/gpt-4.1-old'))
    await expect(loadRuntimeModelPreset('zm_old_gpt', 'Subagent')).rejects.toMatchObject({
      code: 'model_preset_unavailable',
      message: expect.stringContaining('the selected Subagent model preset "Old GPT"')
    })
  })

  it('runs a gateway preset the gateway still lists (control)', async () => {
    await redis.set('model:zm_sonnet', gatewayPreset('zm_sonnet', 'anthropic/claude-sonnet-5'))
    await expect(loadRuntimeModelPreset('zm_sonnet', 'primary')).resolves.toMatchObject({ id: 'zm_sonnet' })
  })

  it('never reads the catalog for a preset that is not a gateway catalog preset', async () => {
    await redis.del(CATALOG_KEY)
    await redis.set('model:zm_direct', {
      ...gatewayPreset('zm_direct', 'openai/gpt-4.1-old'),
      isVercelImport: false,
      vercelSourceId: undefined,
      connection: { type: 'direct', service: 'openai' }
    })
    await expect(loadRuntimeModelPreset('zm_direct', 'primary')).resolves.toMatchObject({ id: 'zm_direct' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('reads the cached catalog even when it is older than an hour, and never the network (review)', async () => {
    await redis.set(CATALOG_KEY, { models: [SONNET_ROW], fetchedAt: '2026-01-01T00:00:00.000Z' })
    await redis.set('model:zm_old_gpt', gatewayPreset('zm_old_gpt', 'openai/gpt-4.1-old'))
    await redis.set('model:zm_sonnet', gatewayPreset('zm_sonnet', 'anthropic/claude-sonnet-5'))

    await expect(loadRuntimeModelPreset('zm_old_gpt', 'primary')).rejects.toMatchObject({
      code: 'model_preset_unavailable'
    })
    await expect(loadRuntimeModelPreset('zm_sonnet', 'primary')).resolves.toMatchObject({ id: 'zm_sonnet' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('with no cached catalog the check cannot run: the send goes on, says so in the log, and fetches nothing', async () => {
    await redis.del(CATALOG_KEY)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await redis.set('model:zm_old_gpt', gatewayPreset('zm_old_gpt', 'openai/gpt-4.1-old'))

    await expect(loadRuntimeModelPreset('zm_old_gpt', 'primary')).resolves.toMatchObject({ id: 'zm_old_gpt' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain('no model catalog is cached')
  })

  it('builds the lookup once per cached catalog, and again when the catalog changes', async () => {
    await redis.set('model:zm_old_gpt', gatewayPreset('zm_old_gpt', 'openai/gpt-4.1-old'))
    await redis.set('model:zm_sonnet', gatewayPreset('zm_sonnet', 'anthropic/claude-sonnet-5'))
    const getSpy = vi.spyOn(redis, 'get')
    // The fake's `get` keeps its calls from earlier tests: count from here.
    const readsBefore = getSpy.mock.calls.filter(([key]) => key === CATALOG_KEY).length
    const catalogReads = () => getSpy.mock.calls.filter(([key]) => key === CATALOG_KEY).length - readsBefore

    await loadRuntimeModelPreset('zm_sonnet', 'primary')
    await loadRuntimeModelPreset('zm_sonnet', 'primary')
    await expect(loadRuntimeModelPreset('zm_old_gpt', 'primary')).rejects.toMatchObject({ code: 'model_preset_unavailable' })
    // One whole-catalog read for three sends while the cached catalog stayed the same.
    expect(catalogReads()).toBeLessThanOrEqual(1)

    // The registry sync lists the model again: a new cached catalog, read and used.
    const oldGptRow = {
      ...SONNET_ROW,
      id: 'openai/gpt-4.1-old',
      canonicalId: 'openai/gpt-4.1-old',
      provider: 'openai',
      name: 'gpt-4.1-old',
      idVariants: { 'vercel-gateway': { developerId: 'openai', modelId: 'gpt-4.1-old', effectiveId: 'openai/gpt-4.1-old', source: 'vercel' } }
    }
    await redis.set(CATALOG_KEY, { models: [SONNET_ROW, oldGptRow], fetchedAt: '2026-09-28T13:00:00.000Z' })
    await expect(loadRuntimeModelPreset('zm_old_gpt', 'primary')).resolves.toMatchObject({ id: 'zm_old_gpt' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('still says a deleted preset no longer exists', async () => {
    await expect(loadRuntimeModelPreset('zm_gone', 'primary')).rejects.toMatchObject({
      code: 'model_preset_missing'
    })
  })
})
