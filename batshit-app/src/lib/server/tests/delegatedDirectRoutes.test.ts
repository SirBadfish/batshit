import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ auth: null as any, bash: vi.fn() }))
vi.mock('$lib/server/services/nativeToolAuth', () => ({ resolveNativeToolUser: vi.fn(async () => state.auth) }))
vi.mock('$lib/server/services/nativeTools', () => ({ nativeToolService: { nativeBashExecute: state.bash } }))
import { POST } from '../../../routes/api/native-tools/bash/execute/+server'
beforeEach(() => state.bash.mockReset().mockResolvedValue({ success: true }))
describe('authenticated direct Bash probes', () => {
  it.each(['session', 'service'])('keeps the existing %s probe path', async lane => {
    state.auth = { userId: 'user_1', auth: lane }
    const request = new Request('http://localhost/api/native-tools/bash/execute', { method: 'POST', body: JSON.stringify({ command: 'example', backend: 'local' }) })
    expect((await POST({ request, locals: {} } as any)).status).toBe(200)
    expect(state.bash).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_1', command: 'example', backend: 'local' }))
  })
})
