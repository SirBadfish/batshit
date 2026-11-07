// @vitest-environment node
import { expect, it, vi } from 'vitest'
const hooks = vi.hoisted(() => ({ duplicate: vi.fn(), source: vi.fn() }))
vi.mock('$lib/server/redis', () => ({ redis: { execute: async (run: (client: unknown) => unknown) => run({ json: { get: hooks.source } }) } }))
vi.mock('$lib/server/services/goonRecipeDuplicationService.server', async loadOriginal => ({
  ...await loadOriginal<typeof import('$lib/server/services/goonRecipeDuplicationService.server')>(), duplicateRecipeGoon: hooks.duplicate
}))
import { GoonRecipeDuplicationError } from '$lib/server/services/goonRecipeDuplicationService.server'
import { POST } from './+server'

it('returns a held duplicate identity when an issued transaction is unknown', async () => {
  hooks.source.mockResolvedValue({ id: 'source', user_id: 'owner', recipe: { contract: 'goon-recipe/v2' } })
  hooks.duplicate.mockRejectedValue(new GoonRecipeDuplicationError('Do not retry until the outcome is recovered.', 503, 'unknown', { goonId: 'held-copy' }))
  const response = await POST({ params: { id: 'source' }, locals: { user: { id: 'owner' } } } as never)
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: 'Do not retry until the outcome is recovered.', outcome: 'unknown', recovery: { goonId: 'held-copy' } })
})
