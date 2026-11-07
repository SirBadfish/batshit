// @vitest-environment node
/** SA-139 P1: the Claude plan card's status is a read for the signed-in user only; raw CLI text stays in the log. */
import { expect, it, vi } from 'vitest'
const status = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('$lib/server/services/claudePlanReadiness', () => ({ readClaudePlanDisplayStatus: status.read }))
import { GET } from './+server'

it('refuses without a signed-in user and answers codes, a clean version and the sign-in command only', async () => {
  expect((await GET({ locals: {} } as any)).status).toBe(401)
  expect(status.read).not.toHaveBeenCalled()
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
  const user = { locals: { user: { id: 'u' } }, url: new URL('http://localhost/api/settings/claude-plan') } as any
  status.read.mockResolvedValue({ state: 'unavailable', installed: true, code: 'signed_out', reason: 'Command failed: /secret/path/claude auth status --json',
    setupCommand: 'claude auth login', statusCommand: 'claude auth status --text', setupContext: 'native' })
  const answer = await GET(user)
  expect(answer.status).toBe(200)
  expect(answer.headers.get('cache-control')).toBe('no-store')
  expect(await answer.json()).toEqual({ state: 'unavailable', installed: true, code: 'signed_out', setupCommand: 'claude auth login', setupContext: 'native' })
  expect(debug.mock.calls.at(-1)?.[0]).toContain('/secret/path')
  expect(status.read).toHaveBeenLastCalledWith({ fresh: false })
  // Signed in another way than a Claude plan, or a status Batshit cannot read: signing in fixes both.
  for (const code of ['not_plan', 'status_unreadable']) {
    status.read.mockResolvedValue({ state: 'unavailable', installed: true, code, reason: 'Claude Code is set to use an API key at /secret/path',
      setupCommand: 'claude auth login', setupContext: 'native' })
    expect(await (await GET(user)).json()).toEqual({ state: 'unavailable', installed: true, code, setupCommand: 'claude auth login', setupContext: 'native' })
  }
  status.read.mockResolvedValue({ state: 'unavailable', installed: true, code: 'executable_unusable', reason: 'Claude Code at /secret/path changed',
    setupCommand: 'claude auth login' })
  expect(await (await GET(user)).json()).toEqual({ state: 'unavailable', installed: true, code: 'executable_unusable' })
  // Check Again looks again instead of reusing the short-lived display read.
  await GET({ ...user, url: new URL('http://localhost/api/settings/claude-plan?fresh=1') })
  expect(status.read).toHaveBeenLastCalledWith({ fresh: true })
  status.read.mockResolvedValue({ state: 'unavailable', installed: false, code: 'not_installed', reason: 'spawn ENOENT /secret/path', setupCommand: 'claude auth login' })
  expect(await (await GET(user)).json()).toEqual({ state: 'unavailable', installed: false, code: 'not_installed' })
  status.read.mockResolvedValue({ state: 'ready', installed: true, version: '2.1.296 (Claude Code)' })
  expect(await (await GET(user)).json()).toEqual({ state: 'ready', installed: true, version: '2.1.296' })
  status.read.mockRejectedValue(new Error('spawn failed /secret/path'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const failed = await GET(user)
  expect(failed.status).toBe(500)
  expect(await failed.json()).toEqual({ error: 'Batshit could not read Claude Code status. Try again.' })
})
