import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), execute: vi.fn(), getSession: vi.fn(), exists: vi.fn() }))
vi.mock('$lib/server/services/nativeToolAuth', () => ({ resolveNativeToolUser: mocks.auth }))
vi.mock('$lib/server/services/cliToolRegistry', () => ({ executeCliTool: mocks.execute }))
vi.mock('$lib/server/redis', () => ({ redis: { getSession: mocks.getSession, execute: async (fn: any) => fn({ exists: mocks.exists }) } }))
import { __resetStreamAbortRegistryForTests, registerStreamAbort } from '$lib/server/services/streamAbortRegistry'
import { POST } from './+server'
beforeEach(() => {
  vi.clearAllMocks(); __resetStreamAbortRegistryForTests()
  mocks.auth.mockResolvedValue({ userId: 'user-1', auth: 'service' })
  mocks.execute.mockResolvedValue({ success: true, toolId: 'long_job' })
  mocks.getSession.mockImplementation(async (id: string) => ({ id, user_id: 'user-1' }))
  mocks.exists.mockResolvedValue(1)
})
it('does not give a service caller the Stop from a body-named chat', async () => {
  registerStreamAbort('claimed-chat', 'claimed-reply', new AbortController())
  const request = new Request('http://localhost/api/cli-tools/execute', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ toolId: 'long_job', sessionId: 'claimed-chat' }) })
  expect((await POST({ request, locals: {} } as any)).status).toBe(200)
  expect(mocks.execute).toHaveBeenCalledTimes(1)
  expect(mocks.execute.mock.calls[0][1]).toBeUndefined()
})
