// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { appActionsHumanRoute } from './humanRoutes'
vi.mock('../runtime', () => ({ requireAppActionTopology() {} }))

function event(headers: Record<string, string> = {}, method = 'PUT') {
  const url = new URL('http://localhost/api/agents/a/app-actions-policy')
  return { url, request: new Request(url, { method, headers: { origin: url.origin, 'content-type': 'application/json', ...headers },
    ...(method === 'GET' ? {} : { body: '{}' }) }),
    locals: { user: { id: 'owner' }, session: { user_id: 'owner', token: 'test-session' } } as App.Locals }
}
describe('human-only Settings policy/one-operation decision route boundary', () => {
  it.each(['authorization', 'x-batshit-agent-token', 'x-batshit-portable-token', 'x-batshit-token'])('refuses presented %s before owner work, even with a valid human cookie', async header => {
    const owner = vi.fn(async () => ({}))
    expect((await appActionsHumanRoute(event({ [header]: 'presented' }), owner)).status).toBe(401)
    expect(owner).not.toHaveBeenCalled()
  })
  it('requires same-origin human writes and GET cannot supply a decision body', async () => {
    const owner = vi.fn(async (_user, body) => ({ success: true, body }))
    expect((await appActionsHumanRoute(event({ origin: 'https://elsewhere.test' }), owner)).status).toBe(403)
    expect(owner).not.toHaveBeenCalled()
    expect((await appActionsHumanRoute(event({}, 'GET'), owner)).status).toBe(200)
    expect(owner).toHaveBeenCalledExactlyOnceWith('owner', undefined)
  })
})
