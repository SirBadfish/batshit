import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ resolveNativeToolUser: vi.fn(), useControl: vi.fn(), getSession: vi.fn(), exists: vi.fn() }))
vi.mock('$lib/server/services/nativeToolAuth', async original => ({ ...await original<typeof import('$lib/server/services/nativeToolAuth')>(), resolveNativeToolUser: mocks.resolveNativeToolUser }))
vi.mock('$lib/server/services/fabricRegistry', () => ({ useControl: mocks.useControl }))
vi.mock('$lib/server/redis', () => ({ redis: { getSession: mocks.getSession, execute: async (fn: any) => fn({ exists: mocks.exists }) } }))
import { __resetStreamAbortRegistryForTests, registerStreamAbort } from '$lib/server/services/streamAbortRegistry'
import { POST } from './+server'
beforeEach(() => {
  vi.clearAllMocks()
  __resetStreamAbortRegistryForTests()
  mocks.resolveNativeToolUser.mockResolvedValue({ userId: 'user-1', auth: 'service' })
  mocks.useControl.mockResolvedValue({ success: true, controlId: 'sys.mcp.dynamic.use', result: {} })
  mocks.getSession.mockImplementation(async (id: string) => ({ id, user_id: 'user-1' }))
  mocks.exists.mockResolvedValue(1)
})
it('does not give a service caller the Stop or originating identity from a body-named chat', async () => {
  registerStreamAbort('claimed-chat', 'claimed-reply', new AbortController())
  const request = new Request('http://localhost/api/controls/use', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ controlId: 'sys.mcp.dynamic.use', sessionId: 'claimed-chat', messageId: 'claimed-reply' }) })
  expect((await POST({ request, locals: {} } as any)).status).toBe(200)
  expect(mocks.useControl.mock.calls[0][0]).not.toHaveProperty('abortSignal')
  expect(mocks.useControl.mock.calls[0][0]).not.toHaveProperty('originatingReply')
})
