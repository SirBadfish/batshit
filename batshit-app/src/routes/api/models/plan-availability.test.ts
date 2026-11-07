// @vitest-environment node
/** SA-139 (Faye nit): plan model ids are never checked through ProviderManager and never promise a fallback. */
import { expect, it, vi } from 'vitest'
const pm = vi.hoisted(() => ({ createForUser: vi.fn(async () => ({ getModel: vi.fn(() => ({})) })) }))
vi.mock('$lib/server/services/providers', async original => ({ ...await original<Record<string, unknown>>(), ProviderManager: { createForUser: pm.createForUser } }))
import { POST } from './+server'

const post = (modelId: string) => POST({ locals: { user: { id: 'u' } }, request: new Request('http://test/api/models', { method: 'POST', body: JSON.stringify({ modelId }) }) } as any)

it('answers plan ids readably without asking ProviderManager, and keeps the ordinary check for other ids', async () => {
  for (const modelId of ['claude-plan:local/opus', 'direct:claude-plan/claude-opus-5-5', 'chatgpt-plan:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/gpt-6-astra']) {
    const body = await (await post(modelId)).json()
    expect(body.data).toMatchObject({ available: false, modelId })
    expect(body.data.message).toMatch(/never fall back/)
    expect(body.data.message).not.toMatch(/fallback will be used/)
  }
  expect(pm.createForUser).not.toHaveBeenCalled()
  expect((await (await post('anthropic/claude-opus-5-5')).json()).data).toMatchObject({ available: true })
  expect(pm.createForUser).toHaveBeenCalledTimes(1)
})
