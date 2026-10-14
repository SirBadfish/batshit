// @vitest-environment node
/**
 * BL-483: a model preset cannot be deleted while anything still uses it.
 *
 * The delete used to be refused only when a Primary Agent's model named the preset. An API
 * Subagent's model, the Memory System's embedding model, the default and per-agent Auto Compact
 * model, an agent's memory summary model, and an artifact's model deleted without a word, and
 * each then failed with an error that pointed somewhere else. The refusal now covers every place
 * a preset id is stored (`findModelPresetReferences`) and names each one.
 * Runs the real route on the default lane's Redis fake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { MEMORY_CONFIG_KEY } from '$lib/server/services/memory/memoryKeys'

vi.mock('$lib/server/services/providers', () => ({
  ProviderManager: { createForUser: vi.fn() }
}))

vi.mock('$lib/server/services/vercelModelCatalog', () => ({
  fetchVercelModelCatalog: vi.fn(),
  findVercelCatalogEntry: vi.fn(),
  findVercelCatalogEntryById: vi.fn()
}))

useRedisTestServer()

const USER = 'user-bl483'
const PRESET = 'ssmod_preset_in_use'

const { DELETE } = await import('./+server')

async function deletePreset(id = PRESET) {
  const response = await DELETE({
    url: new URL(`http://localhost/api/user/saved-models?id=${id}`),
    locals: { user: { id: USER } }
  } as any)
  return { status: response.status, body: await response.json() }
}

async function expectRefusedNaming(label: string) {
  const { status, body } = await deletePreset()
  expect(status).toBe(409)
  expect(body.code).toBe('model_preset_in_use')
  expect(body.error).toContain(label)
  expect(await redis.get(`model:${PRESET}`)).not.toBeNull()
  expect(await redis.sMembers(`user:${USER}:models`)).toContain(PRESET)
  return body
}

async function addAgent(id: string, fields: Record<string, unknown>) {
  await redis.createAgent({ id, user_id: USER, displayName: id.replace('agent-', 'Agent '), agentType: 'api', ...fields } as any)
}

beforeEach(async () => {
  await redis.set(`model:${PRESET}`, { id: PRESET, modelName: 'In use', modelId: 'gpt-5.5', provider: 'openai', settings: {} })
  await redis.sAdd(`user:${USER}:models`, PRESET)
})

describe('BL-483: a preset in use cannot be deleted, and the refusal names each user', () => {
  it("a Primary Agent's model (kept from before)", async () => {
    await addAgent('agent-ava', { primary_model_preset_id: PRESET })
    await expectRefusedNaming("Agent ava's model")
  })

  it("an API Subagent's model", async () => {
    await redis.json.set('subagent:sub-researcher', '$', {
      id: 'sub-researcher',
      user_id: USER,
      displayName: 'Researcher',
      subagentType: 'api',
      primary_model_preset_id: PRESET
    })
    await redis.sAdd(`user:${USER}:subagents`, 'sub-researcher')
    await expectRefusedNaming("the Subagent Researcher's model")
  })

  it("the Memory System's embedding model", async () => {
    await redis.json.set(MEMORY_CONFIG_KEY, '$', {
      embedding: {
        lane: 'preset',
        modelId: `preset:${PRESET}`,
        preset: { presetId: PRESET, provider: 'openai', modelName: 'text-embedding-3-small', dims: 1536 }
      },
      schema_version: 1
    })
    await expectRefusedNaming("the Memory System's embedding model (Settings → Memory)")
  })

  it('the default Auto Compact model', async () => {
    await redis.updateUserSettings(USER, {
      global_auto_compact_settings: { mode: 'auto', modelMode: 'preset', modelPresetId: PRESET }
    } as any)
    await expectRefusedNaming('the default Auto Compact model (Settings → Admin)')
  })

  it("an agent's own Auto Compact model", async () => {
    await addAgent('agent-bo', { auto_compact_settings: { modelMode: 'preset', modelPresetId: PRESET } })
    await expectRefusedNaming("Agent bo's Auto Compact model")
  })

  it("an agent's memory summary model", async () => {
    await addAgent('agent-cy', { memory_window: { summary_model_mode: 'preset', summary_model_preset_id: PRESET } })
    await expectRefusedNaming("Agent cy's memory summary model")
  })

  it("an artifact's model", async () => {
    await redis.json.set('artifact:art-todo', '$', {
      id: 'art-todo',
      user_id: USER,
      name: 'Todo Helper',
      model_config: {
        mode: 'advanced',
        primary: { source: 'auto' },
        visual: { source: 'preset', presetId: PRESET }
      }
    })
    await redis.sAdd(`user:${USER}:artifacts`, 'art-todo')
    await expectRefusedNaming('the artifact "Todo Helper" (visual model)')
  })

  it('names every user in one refusal', async () => {
    await addAgent('agent-ava', { primary_model_preset_id: PRESET })
    await addAgent('agent-bo', { auto_compact_settings: { modelMode: 'preset', modelPresetId: PRESET } })
    await redis.updateUserSettings(USER, { global_auto_compact_settings: { modelMode: 'preset', modelPresetId: PRESET } } as any)
    const body = await expectRefusedNaming("Agent ava's model")
    expect(body.error.startsWith('This model preset is still used by ')).toBe(true)
    expect(body.error).toContain("Agent bo's Auto Compact model")
    expect(body.error).toContain('the default Auto Compact model (Settings → Admin)')
    expect(body.error.endsWith('Pick a different model in each of those places before deleting it.')).toBe(true)
    expect(body.dependencies.references.map((reference: { kind: string }) => reference.kind).sort()).toEqual([
      'agent_auto_compact',
      'agent_model',
      'global_auto_compact'
    ])
  })

  it('a setting that names the preset but does not use it does not block the delete', async () => {
    // Auto Compact on the current chat model and a memory summary on inherit: a leftover id is not a use.
    await addAgent('agent-dee', {
      auto_compact_settings: { modelMode: 'current', modelPresetId: PRESET },
      memory_window: { summary_model_mode: 'inherit', summary_model_preset_id: PRESET }
    })
    await redis.updateUserSettings(USER, { global_auto_compact_settings: { modelMode: 'current', modelPresetId: PRESET } } as any)
    await redis.json.set(MEMORY_CONFIG_KEY, '$', {
      embedding: { lane: 'builtin', modelId: 'builtin:embeddinggemma-300m', preset: { presetId: PRESET, provider: 'openai', modelName: 'x', dims: 8 } },
      schema_version: 1
    })
    const { status } = await deletePreset()
    expect(status).toBe(200)
    expect(await redis.get(`model:${PRESET}`)).toBeNull()
  })

  it('deletes a preset nothing uses (control)', async () => {
    const { status, body } = await deletePreset()
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(await redis.get(`model:${PRESET}`)).toBeNull()
  })
})
