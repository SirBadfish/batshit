// @vitest-environment node
/** SA-139 P1 (D1, D2): the Claude plan's readiness comes from P2's executable binding and plan sign-in check. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudePlanAuthStatus, ClaudePlanExecutable } from '../claudePlanExecutable'

const probe = vi.hoisted(() => ({ bind: vi.fn(), check: vi.fn(), readAuth: vi.fn(), resolve: vi.fn() }))
vi.mock('../claudePlanExecutable', async original => ({
  ...await original<Record<string, unknown>>(), bindClaudePlanExecutable: probe.bind,
  checkClaudePlanExecutable: probe.check, readClaudePlanAuthStatus: probe.readAuth
}))
vi.mock('../claudeCliStatus', async original => ({
  ...await original<Record<string, unknown>>(), resolveClaudeCliExecutableDetailed: probe.resolve
}))

import { env } from '$env/dynamic/private'
import { ClaudePlanExecutableError } from '../claudePlanExecutable'
import { admitClaudePlanSelection, claudePlanConfigurationReadiness } from '../claudePlanAdmission'
import {
  clearClaudePlanDisplayStatusForTests, projectClaudePlanProbe, readClaudePlanDisplayStatus, readClaudePlanReadiness, readClaudePlanStatus
} from '../claudePlanReadiness'
import { CLAUDE_PLAN_CONNECTION_ID } from '$lib/utils/claudePlanConnection'
import { noteClaudeCodeChanged } from '../claudeCodeChanges'

const bound = Object.freeze({ requestedPath: '/opt/claude', realPath: '/opt/claude', version: '2.1.296', size: 1, mtimeMs: 1,
  sha256: '0', source: 'path', identity: '1:1:1:1:1' }) as ClaudePlanExecutable
const { sha256: _evidence, ...checked } = bound
const plan: ClaudePlanAuthStatus = { state: 'plan', subscriptionType: 'max' }
const signedOut: ClaudePlanAuthStatus = { state: 'refused', code: 'signed_out', reason: 'Claude Code is not signed in.' }
const guidance = { setupCommand: 'claude auth login', statusCommand: 'claude auth status --text', setupContext: 'docker' as const, setupWorkingDirectory: '/srv/batshit' }

beforeEach(() => {
  probe.bind.mockReset().mockResolvedValue(bound)
  probe.check.mockReset().mockResolvedValue(checked)
  probe.readAuth.mockReset().mockResolvedValue(plan)
  probe.resolve.mockReset().mockReturnValue({ executable: 'claude', source: 'path' })
  clearClaudePlanDisplayStatusForTests()
})
afterEach(() => { vi.useRealTimers(); delete (env as Record<string, string | undefined>).BATSHIT_CLAUDE_PROVIDER_ENABLED })

describe('Claude plan readiness projection', () => {
  it('words each binding and sign-in refusal by its own code, with the sign-in guidance where signing in fixes it', () => {
    expect(projectClaudePlanProbe({ bound: null, bindError: { code: 'not_found', message: 'Claude Code is not installed. Install it from Agent Settings.' } }, guidance))
      .toEqual({ state: 'unavailable', code: 'not_installed', installed: false, reason: expect.stringContaining('Claude Plan card in Settings → API Keys'), ...guidance })
    // The binder's messages name the executable's path; what pickers, presets and a refused run show does not.
    for (const code of ['not_executable', 'version_unreadable', 'version_unqualified', 'changed'] as const) {
      const status = projectClaudePlanProbe({ bound: null, bindError: { code, message: `Claude Code at /secret/claude refused ${code}` } }, guidance)
      expect(status).toEqual({ state: 'unavailable', code: 'executable_unusable', installed: true, reason: expect.stringContaining('version Batshit was tested with (2.1.296)') })
      expect(status.state === 'unavailable' && status.reason).not.toMatch(/secret/)
    }
    const refused = (code: Extract<ClaudePlanAuthStatus, { state: 'refused' }>['code']) =>
      projectClaudePlanProbe({ bound, auth: { state: 'refused', code, reason: `reason ${code}` } }, guidance)
    expect(refused('signed_out')).toEqual({ state: 'unavailable', code: 'signed_out', installed: true, reason: 'reason signed_out', ...guidance })
    expect(refused('unreadable')).toMatchObject({ code: 'status_unreadable', setupCommand: 'claude auth login' })
    for (const code of ['api_key', 'oauth_token', 'third_party', 'not_first_party'] as const) {
      expect(refused(code)).toEqual({ state: 'unavailable', code: 'not_plan', installed: true, reason: `reason ${code}`, ...guidance })
    }
    // Only a plan passes: an answer this code does not know refuses (reviewer A, S1).
    expect(projectClaudePlanProbe({ bound, auth: { state: 'unknown' } as unknown as ClaudePlanAuthStatus }, guidance, { runtimeBuilt: true }))
      .toMatchObject({ state: 'unavailable', code: 'status_unreadable', setupCommand: 'claude auth login' })
    // This build has the runtime (SA-139 P3's flip); the gate still refuses a build without it.
    expect(projectClaudePlanProbe({ bound, auth: plan }, guidance)).toEqual({ state: 'ready', installed: true, version: '2.1.296' })
    expect(projectClaudePlanProbe({ bound, auth: plan }, guidance, { runtimeBuilt: false })).toMatchObject({ state: 'unavailable', code: 'runtime_unavailable', installed: true })
  })
})

describe('Claude plan readiness reads', () => {
  it('admission refuses before any process starts in a build without the runtime', async () => {
    const unbuilt = () => readClaudePlanReadiness({ runtimeBuilt: false })
    expect(await unbuilt()).toMatchObject({ state: 'unavailable', code: 'runtime_unavailable' })
    expect((await admitClaudePlanSelection({ connection: { id: CLAUDE_PLAN_CONNECTION_ID, type: 'direct', service: 'claude-plan' },
      modelId: 'opus', consumer: 'primary', readiness: unbuilt }).catch(error => error)).message).toMatch(/not available in this Batshit build yet/)
    expect(probe.bind).not.toHaveBeenCalled(); expect(probe.check).not.toHaveBeenCalled()
    expect(probe.readAuth).not.toHaveBeenCalled()
    // This build has the runtime (SA-139 P3's flip).
    expect(claudePlanConfigurationReadiness()).toEqual({ state: 'ready' })
  })

  it('admission binds the executable and reads the plan sign-in with it on every call, never from a cache', async () => {
    expect(await readClaudePlanReadiness({ runtimeBuilt: true })).toEqual({ state: 'ready', installed: true, version: '2.1.296' })
    // Admission binds with the evidence hash, as the run does (lead, 2026-10-27); display reads never hash.
    expect(probe.bind).toHaveBeenCalledWith({ resolution: { executable: 'claude', source: 'path' }, runAs: expect.any(Object) })
    expect(probe.check).not.toHaveBeenCalled()
    expect(probe.readAuth).toHaveBeenCalledWith(bound, expect.anything())
    await readClaudePlanDisplayStatus()
    probe.readAuth.mockResolvedValueOnce(signedOut)
    expect(await readClaudePlanReadiness({ runtimeBuilt: true })).toMatchObject({ state: 'unavailable', code: 'signed_out', setupCommand: 'claude auth login' })
    expect(probe.readAuth).toHaveBeenCalledTimes(3)
  })

  it('the display view reads Claude Code before the build gate, so the card can guide setup', async () => {
    probe.readAuth.mockResolvedValueOnce(signedOut)
    expect(await readClaudePlanStatus()).toMatchObject({ state: 'unavailable', code: 'signed_out', installed: true, setupContext: 'native' })
    expect(await readClaudePlanStatus({ runtimeBuilt: false })).toMatchObject({ state: 'unavailable', code: 'runtime_unavailable', installed: true })
    expect(await readClaudePlanStatus()).toMatchObject({ state: 'ready', installed: true })
    expect(probe.check).toHaveBeenCalledTimes(3)
    expect(probe.bind).not.toHaveBeenCalled()
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    probe.check.mockRejectedValueOnce(new ClaudePlanExecutableError('version_unqualified', 'Claude Code 2.1.310 at /secret/claude is not a version the Claude plan connection was tested with.'))
    expect(await readClaudePlanStatus()).toMatchObject({ code: 'executable_unusable', installed: true, reason: expect.not.stringMatching(/secret|2\.1\.310/) })
    expect(debug.mock.calls.at(-1)?.[0]).toContain('2.1.310 at /secret/claude')
  })

  it('an unexpected failure while checking is a refusal with a plain reason, never a pass', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    probe.check.mockRejectedValueOnce(new Error('EACCES /secret/path'))
    const status = await readClaudePlanStatus({ runtimeBuilt: true })
    expect(status).toMatchObject({ state: 'unavailable', code: 'executable_unusable' })
    expect(status.state === 'unavailable' && status.reason).not.toMatch(/secret/)
    probe.readAuth.mockRejectedValueOnce(new Error('auth status crashed'))
    expect(await readClaudePlanReadiness({ runtimeBuilt: true })).toMatchObject({ state: 'unavailable', code: 'executable_unusable' })
    // Even the setup before the check (the run-as user, the resolver) refuses instead of failing the request.
    probe.resolve.mockImplementationOnce(() => { throw new Error('manifest unreadable') })
    expect(await readClaudePlanStatus()).toMatchObject({ state: 'unavailable', code: 'executable_unusable' })
    expect(warn).toHaveBeenCalledTimes(3)
  })

  it('turned off: nothing is spawned and the connection is hidden', async () => {
    (env as Record<string, string>).BATSHIT_CLAUDE_PROVIDER_ENABLED = 'false'
    expect(await readClaudePlanStatus()).toMatchObject({ state: 'unavailable', code: 'disabled', installed: false })
    expect(await readClaudePlanReadiness({ runtimeBuilt: true })).toMatchObject({ state: 'unavailable', code: 'disabled' })
    expect(probe.bind).not.toHaveBeenCalled(); expect(probe.check).not.toHaveBeenCalled()
  })
})

describe('Claude plan display reads share one short-lived look (Faye S2)', () => {
  it('reuses one look for 30 seconds, looks again on Check Again or after that, and admission never uses it', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] })
    const [a, b, c] = await Promise.all([readClaudePlanDisplayStatus(), readClaudePlanDisplayStatus(), readClaudePlanDisplayStatus()])
    expect(a).toBe(b); expect(b).toBe(c)
    expect(probe.readAuth).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(29_000)
    await readClaudePlanDisplayStatus()
    expect(probe.readAuth).toHaveBeenCalledTimes(1)
    probe.readAuth.mockResolvedValueOnce(signedOut)
    expect(await readClaudePlanDisplayStatus({ fresh: true })).toMatchObject({ code: 'signed_out' })
    expect(await readClaudePlanDisplayStatus()).toMatchObject({ code: 'signed_out' })
    expect(probe.readAuth).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(30_000)
    expect(await readClaudePlanDisplayStatus()).toMatchObject({ state: 'ready' })
    expect(probe.readAuth).toHaveBeenCalledTimes(3)
    await readClaudePlanReadiness({ runtimeBuilt: true })
    expect(probe.readAuth).toHaveBeenCalledTimes(4)
  })

  it('a look that failed unexpectedly or saw the binary change is not shared (reviewer A)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    probe.check.mockRejectedValueOnce(new Error('EACCES'))
    expect(await readClaudePlanDisplayStatus()).toMatchObject({ code: 'executable_unusable' })
    probe.check.mockRejectedValueOnce(new ClaudePlanExecutableError('changed', 'Claude Code at /x changed while Batshit checked it. Try again.'))
    expect(await readClaudePlanDisplayStatus()).toMatchObject({ code: 'executable_unusable' })
    expect(await readClaudePlanDisplayStatus()).toMatchObject({ state: 'ready' })
    expect(await readClaudePlanDisplayStatus()).toMatchObject({ state: 'ready' })
    expect(probe.check).toHaveBeenCalledTimes(3)
  })

  it('a managed install, reinstall or uninstall makes the next display read look again (reviewer B, M1)', async () => {
    expect(await readClaudePlanDisplayStatus()).toMatchObject({ state: 'ready' })
    probe.check.mockRejectedValueOnce(new ClaudePlanExecutableError('not_found', 'Claude Code is not installed.'))
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    noteClaudeCodeChanged()
    expect(await readClaudePlanDisplayStatus()).toMatchObject({ code: 'not_installed' })
    expect(await readClaudePlanDisplayStatus()).toMatchObject({ code: 'not_installed' })
    expect(probe.check).toHaveBeenCalledTimes(2)
  })
})
