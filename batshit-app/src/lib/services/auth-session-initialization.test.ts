// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ initialize: vi.fn(), create: vi.fn(), set: vi.fn(), expire: vi.fn() }))
vi.mock('$lib/server/services/systemSlashCommands', () => ({ initializeSystemSlashCommandsForUser: state.initialize }))
vi.mock('redis', () => ({ createClient: state.create }))
import { AuthService } from './auth.server'

beforeEach(() => {
  vi.clearAllMocks()
  state.initialize.mockReset().mockResolvedValue(undefined)
  state.create.mockReturnValue({ on: vi.fn(), connect: vi.fn(), json: { set: state.set }, expire: state.expire })
})
describe('authentication session publication waits for trustworthy skill initialization', () => {
  const user = { id: 'fixture', email: 'fixture@example.invalid', is_admin: true }
  it('waits before acquiring the auth client or publishing any session', async () => {
    let ready!: () => void
    state.initialize.mockReturnValue(new Promise<void>(resolve => { ready = resolve }))
    const session = new AuthService().createSession(user)
    await vi.waitFor(() => expect(state.initialize).toHaveBeenCalledWith(user.id))
    expect(state.create).not.toHaveBeenCalled()
    expect(state.set).not.toHaveBeenCalled()
    ready()
    const published = await session
    expect(state.set).toHaveBeenCalledWith(`user_session:${published.token}`, '$', expect.objectContaining({ user_id: user.id }))
    expect(state.expire).toHaveBeenCalledWith(`user_session:${published.token}`, 24 * 60 * 60)
  })
  it('propagates initialization refusal without a new session or access default', async () => {
    const refusal = Object.assign(new Error('unreadable saved access'), { code: 'PLUGIN_UNAVAILABLE' })
    state.initialize.mockRejectedValue(refusal)
    await expect(new AuthService().createSession(user)).rejects.toBe(refusal)
    expect(state.create).not.toHaveBeenCalled()
    expect(state.set).not.toHaveBeenCalled()
    expect(state.expire).not.toHaveBeenCalled()
  })
})
