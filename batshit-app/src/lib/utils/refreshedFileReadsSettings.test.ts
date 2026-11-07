import { typedFileToolsUnavailableReason } from './typedFileToolsGrant'
import { describe, expect, it, vi } from 'vitest'
import {
  REFRESHED_FILE_READS_GLOBAL_INLINE_NOTE,
  REFRESHED_FILE_READS_HOST_CHECK_FAILED,
  agentRefreshedFileReadsAvailability,
  fetchToolsHostFacts,
  globalRefreshedFileReadsAvailability,
  refreshedFileReadsRecordInputs,
  refreshedFileReadsRecordInputsChanged
} from './refreshedFileReadsSettings'

/**
 * SA-137 Round 2 (R2-2): what the Settings surfaces say about Refreshed File Reads availability.
 * The global switch is unavailable only for what this computer is (a containerized host, a
 * platform that is neither Mac nor Linux); an inline global Zip view is a note, because agents set
 * to Appended still inherit the switch. A host that could not be read never locks either switch.
 */
describe('globalRefreshedFileReadsAvailability', () => {
  const mac = { platform: 'darwin', containerized: false }
  const linux = { platform: 'linux', containerized: false }

  it('is available on a Mac or Linux host with the appended Zip view: no reason, no notes', () => {
    expect(globalRefreshedFileReadsAvailability({ zipViewMode: 'appended', host: mac })).toEqual({ unavailableReason: null, notes: [] })
    expect(globalRefreshedFileReadsAvailability({ zipViewMode: 'appended', host: linux })).toEqual({ unavailableReason: null, notes: [] })
  })

  it('names the app container and an unsupported platform as reasons', () => {
    expect(globalRefreshedFileReadsAvailability({ zipViewMode: 'appended', host: { platform: 'linux', containerized: true } }).unavailableReason)
      .toBe('Refreshed File Reads is not available in the app container yet.')
    expect(globalRefreshedFileReadsAvailability({ zipViewMode: 'appended', host: { platform: 'win32', containerized: false } }).unavailableReason)
      .toBe('Refreshed File Reads needs a Mac or Linux host.')
  })

  it('an inline global Zip view is a note, never a reason: the switch stays usable', () => {
    const result = globalRefreshedFileReadsAvailability({ zipViewMode: 'inline', host: mac })
    expect(result.unavailableReason).toBeNull()
    expect(result.notes).toEqual(['The global Zip view is inline; agents that use it refresh nothing.'])
    expect(REFRESHED_FILE_READS_GLOBAL_INLINE_NOTE).toBe('The global Zip view is inline; agents that use it refresh nothing.')
  })

  it('a host reason and the inline note can stand together', () => {
    const result = globalRefreshedFileReadsAvailability({ zipViewMode: 'inline', host: { platform: 'linux', containerized: true } })
    expect(result.unavailableReason).toBe('Refreshed File Reads is not available in the app container yet.')
    expect(result.notes).toEqual([REFRESHED_FILE_READS_GLOBAL_INLINE_NOTE])
  })

  it('a host that could not be read never locks it, and says so as a note', () => {
    expect(globalRefreshedFileReadsAvailability({ zipViewMode: 'appended', host: null, hostCheckFailed: true })).toEqual({
      unavailableReason: null,
      notes: [REFRESHED_FILE_READS_HOST_CHECK_FAILED]
    })
    expect(REFRESHED_FILE_READS_HOST_CHECK_FAILED).toBe('Could not check whether Refreshed File Reads can run here.')
  })

  it('a host still being read says nothing and locks nothing', () => {
    expect(globalRefreshedFileReadsAvailability({ zipViewMode: 'appended', host: null })).toEqual({ unavailableReason: null, notes: [] })
  })

  it('a failure flag does not outlive a host that was read', () => {
    expect(globalRefreshedFileReadsAvailability({ zipViewMode: 'appended', host: mac, hostCheckFailed: true }).notes).toEqual([])
  })
})

describe('agentRefreshedFileReadsAvailability', () => {
  const mac = { platform: 'darwin', containerized: false }
  const base = { primaryType: 'api', zipViewMode: 'appended' as const, backend: 'local', host: mac, hostCheckFailed: false, chosenOn: true }

  it('is available: no reason, no note, no warning', () => {
    expect(agentRefreshedFileReadsAvailability(base)).toEqual({ unavailableReason: null, note: null, warn: false })
  })

  it('warns only when the setting resolves ON and is unavailable', () => {
    const container = { ...base, host: { platform: 'linux', containerized: true } }
    expect(agentRefreshedFileReadsAvailability(container)).toMatchObject({
      unavailableReason: 'Refreshed File Reads is not available in the app container yet.',
      warn: true
    })
    expect(agentRefreshedFileReadsAvailability({ ...container, chosenOn: false })).toMatchObject({
      unavailableReason: 'Refreshed File Reads is not available in the app container yet.',
      warn: false
    })
  })

  it('while the host is still being read the reason is the plain checking sentence, never a warning', () => {
    const checking = agentRefreshedFileReadsAvailability({ ...base, host: null })
    expect(checking.unavailableReason).toBe('Checking whether Refreshed File Reads can run here.')
    expect(checking.warn).toBe(false)
    expect(checking.note).toBeNull()
  })

  it('a host that could not be read does not lock the switch: no reason, a plain note', () => {
    expect(agentRefreshedFileReadsAvailability({ ...base, host: null, hostCheckFailed: true })).toEqual({
      unavailableReason: null,
      note: REFRESHED_FILE_READS_HOST_CHECK_FAILED,
      warn: false
    })
  })

  it('and still names what does not need the host (an inline Zip view, a removed agent type), with the note beside it', () => {
    const inline = agentRefreshedFileReadsAvailability({ ...base, host: null, hostCheckFailed: true, zipViewMode: 'inline' })
    expect(inline.unavailableReason).toMatch(/needs the appended Zip view/)
    expect(inline.note).toBe(REFRESHED_FILE_READS_HOST_CHECK_FAILED)
    expect(inline.warn).toBe(true)
    const cli = agentRefreshedFileReadsAvailability({ ...base, host: null, hostCheckFailed: true, primaryType: 'cli' })
    // SA-139 R4: a leftover `cli` Primary is a removed type.
    expect(cli.unavailableReason).toBe("This agent's type was removed from Batshit, so Refreshed File Reads cannot run for it.")
  })

  it('a Sandbox Level the host cannot judge is not blamed when the host is unknown', () => {
    expect(agentRefreshedFileReadsAvailability({ ...base, host: null, hostCheckFailed: true, backend: 'docker_sandbox' }).unavailableReason).toBeNull()
  })
})

describe('refreshedFileReadsRecordInputs (what a save can change in the availability rule)', () => {
  const record = (agentType: string, provider: unknown) => ({ agentType, provider_specific_settings: provider })

  it('reads the agent type and the Bash location and mode, nested and top-level', () => {
    const a = record('api', { nativeTools: { executionBackend: 'local', bashAccessMode: 'agent' } })
    expect(refreshedFileReadsRecordInputsChanged(a, record('api', { nativeTools: { executionBackend: 'apple_container', bashAccessMode: 'agent' } }))).toBe(true)
    expect(refreshedFileReadsRecordInputsChanged(a, record('api', { nativeTools: { executionBackend: 'local', bashAccessMode: 'dangerous' } }))).toBe(true)
    expect(refreshedFileReadsRecordInputsChanged(a, record('cli', { nativeTools: { executionBackend: 'local', bashAccessMode: 'agent' } }))).toBe(true)
    expect(refreshedFileReadsRecordInputsChanged(a, record('api', { nativeTools: { executionBackend: 'local', bashAccessMode: 'agent' }, nativeBashPolicyMode: 'dangerous' }))).toBe(true)
    expect(refreshedFileReadsRecordInputsChanged(a, record('api', { nativeTools: { nativeExecutionBackend: 'docker_sandbox', bashAccessMode: 'agent' } }))).toBe(true)
  })

  it('ignores everything else a save can carry', () => {
    const a = record('api', { nativeTools: { executionBackend: 'local', bashEnabled: true } })
    expect(refreshedFileReadsRecordInputsChanged(a, record('api', { nativeTools: { executionBackend: 'local', bashEnabled: false, typedFileToolsEnabled: true } }))).toBe(false)
    expect(refreshedFileReadsRecordInputsChanged(a, record('api', { nativeTools: { executionBackend: 'local', bashEnabled: true }, voice: { x: 1 } }))).toBe(false)
    expect(refreshedFileReadsRecordInputsChanged(a, record('api', null))).toBe(true)
  })

  it('an empty value is the same as an absent one, and a missing record reads as none', () => {
    expect(refreshedFileReadsRecordInputsChanged(
      record('api', { nativeTools: { executionBackend: '' } }),
      record('api', { nativeTools: {} })
    )).toBe(false)
    expect(refreshedFileReadsRecordInputs(null)).toBe(refreshedFileReadsRecordInputs(undefined))
    expect(refreshedFileReadsRecordInputsChanged(null, record('api', null))).toBe(true)
  })
})

describe('the host-only read (BL-2049)', () => {
  const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }))

  it('asks the host-only status, which starts no sandbox probe, and keeps the host facts the Tools card rules read', async () => {
    const fetcher = answer({ success: true, typedFileToolsHost: { platform: 'linux', containerized: false, linuxKernel: '6.8.0', extra: 1 } })
    await expect(fetchToolsHostFacts(fetcher as unknown as typeof fetch)).resolves.toEqual({ platform: 'linux', containerized: false, linuxKernel: '6.8.0' })
    expect(fetcher).toHaveBeenCalledWith('/api/native-tools/sandbox/status?hostOnly=1')
    // An answer without a kernel (a Mac) reads as null.
    await expect(fetchToolsHostFacts(answer({ typedFileToolsHost: { platform: 'darwin', containerized: false } }) as unknown as typeof fetch))
      .resolves.toEqual({ platform: 'darwin', containerized: false, linuxKernel: null })
  })

  it.each([true, false, undefined, 'true', 1])('keeps only explicit operator facts for the real typed-file availability rule: %s', async (configured) => {
    const parsed = await fetchToolsHostFacts(answer({ typedFileToolsHost: {
      platform: 'linux', containerized: true, linuxKernel: '7.0.14-linuxkit', dockerSandboxOperatorConfigured: configured
    } }) as unknown as typeof fetch)
    if (typeof configured === 'boolean') expect(parsed.dockerSandboxOperatorConfigured).toBe(configured)
    else expect(parsed).not.toHaveProperty('dockerSandboxOperatorConfigured')
    expect(typedFileToolsUnavailableReason('docker_sandbox', parsed)).toBe(configured === true
      ? null
      : 'Typed file tools with Docker Sandbox need the configured host operator and a host bind workspace.')
  })

  it('throws on a refused answer or one without host facts (the switch then shows its plain note)', async () => {
    await expect(fetchToolsHostFacts(answer({ error: 'down' }, 500) as unknown as typeof fetch)).rejects.toThrow('HTTP 500')
    await expect(fetchToolsHostFacts(answer({ success: true }) as unknown as typeof fetch)).rejects.toThrow('no host facts')
    await expect(fetchToolsHostFacts(answer({ typedFileToolsHost: { platform: 'darwin' } }) as unknown as typeof fetch)).rejects.toThrow('no host facts')
  })
})
