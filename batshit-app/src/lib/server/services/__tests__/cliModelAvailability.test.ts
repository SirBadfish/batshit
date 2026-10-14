import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('$env/dynamic/private', () => ({ env: {} }))
vi.mock('$lib/server/redis', () => ({
  redis: { execute: vi.fn(async () => null) }
}))

import { isCliVersionOlder, parseCliVersion } from '../cliVersion'
import {
  buildRetiredCliModelMessage,
  explainCodexVersionRefusal,
  warnIfCliOlderThanPinned
} from '../cliModelAvailability'
import { MANAGED_CLI_PINNED_VERSIONS } from '../managedCliInstaller'

afterEach(() => vi.restoreAllMocks())

describe('BL-268: a CLI older than the version Batshit installs', () => {
  it('reads the versions both CLIs report', () => {
    expect(parseCliVersion('codex-cli 0.139.0')).toEqual([0, 139, 0])
    expect(parseCliVersion('codex-cli 0.158.0-alpha.2.1')).toEqual([0, 158, 0])
    expect(parseCliVersion('2.1.280 (Claude Code)')).toEqual([2, 1, 280])
    expect(parseCliVersion('no version')).toBeNull()
  })

  it('compares against the pin, and an unreadable version is never called older', () => {
    expect(isCliVersionOlder('codex-cli 0.139.0', '0.155.1')).toBe(true)
    expect(isCliVersionOlder('codex-cli 0.155.0-alpha.16.4', '0.155.1')).toBe(true)
    expect(isCliVersionOlder('codex-cli 0.155.1', '0.155.1')).toBe(false)
    expect(isCliVersionOlder('codex-cli 0.158.0-alpha.2.1', '0.155.1')).toBe(false)
    expect(isCliVersionOlder('2.1.280 (Claude Code)', '2.1.185')).toBe(false)
    expect(isCliVersionOlder('garbage', '0.155.1')).toBe(false)
  })

  it("adds which Codex ran and what to do to Codex's own \"requires a newer version\" refusal", () => {
    const raw = new Error(
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6-astra\' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}'
    )
    const explained = explainCodexVersionRefusal(raw, { version: 'codex-cli 0.139.0', source: 'path' }) as Error
    expect(explained).not.toBe(raw)
    expect(explained.message).toContain(raw.message)
    expect(explained.message).toContain('codex-cli 0.139.0')
    expect(explained.message).toContain(MANAGED_CLI_PINNED_VERSIONS.codex)
    expect(explained.message).toContain('Basic Settings')
    // Every other error is left alone.
    const other = new Error('Codex run failed')
    expect(explainCodexVersionRefusal(other, { version: 'codex-cli 0.139.0', source: 'path' })).toBe(other)
  })

  it('warns once per version when the CLI a run uses is older than the pin', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cli = { version: 'codex-cli 0.139.0', source: 'path', executable: '/zccli/codex' }
    warnIfCliOlderThanPinned('codex', cli)
    warnIfCliOlderThanPinned('codex', cli)
    warnIfCliOlderThanPinned('codex', { ...cli, version: `codex-cli ${MANAGED_CLI_PINNED_VERSIONS.codex}` })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('older than')
  })
})

describe('BL-158: the message a run with a retired model stops with', () => {
  const retired = { value: 'gpt-5.4', label: 'GPT-5.4', leftOn: '2026-09-06' }

  it('names the agent, the model, and the setting to change, in plain words', () => {
    const message = buildRetiredCliModelMessage('codex', retired, { kind: 'agent', name: 'Cody' })
    expect(message).toBe(
      "Cody is set to the Codex model GPT-5.4 (gpt-5.4), which Batshit's Codex list no longer offers (it left the list on 2026-09-06), so Batshit did not start the run. Pick another model in Settings → Agents → Cody → Codex CLI Defaults → Default Codex Model."
    )
    expect(message).not.toMatch(/—/)
  })

  it('names a Subagent as a Subagent, and sends a Worker to its agent', () => {
    expect(buildRetiredCliModelMessage('codex', retired, { kind: 'subagent', name: 'Codex CLI Subagent' })).toContain(
      'The Subagent Codex CLI Subagent is set to'
    )
    expect(buildRetiredCliModelMessage('claude', retired, { kind: 'worker' })).toContain(
      'Settings → Agents → the agent → Claude Code CLI Defaults → Default Claude Model'
    )
  })
})
