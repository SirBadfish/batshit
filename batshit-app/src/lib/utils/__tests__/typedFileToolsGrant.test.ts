import { describe, expect, it } from 'vitest'
import { planRecordFieldOps } from '$lib/server/agentRecordUpdate'
import { planSubagentRecordUpdate } from '$lib/server/subagentRecordUpdate'
import { nativeToolsFieldChanges } from '$lib/utils/agentSettingsSavePatch'
import { diffSubagentPayload } from '$lib/utils/subagentSettingsSavePatch'
import {
  TYPED_FILE_TOOLS_AGENT_FIELD,
  TYPED_FILE_TOOLS_FACTORY_DEFAULT,
  agentTypedFileToolsValue,
  globalTypedFileToolsValue,
  resolveTypedFileToolsGrant,
  validateTypedFileToolsGlobalField,
  typedFileToolsUnavailableReason
} from '../typedFileToolsGrant'

/**
 * SA-136 D1: the typed file tools' grant, read by the browser and the server through one owner.
 * Legacy absent/null readers remain for conversion compatibility. Current ordinary writes keep
 * the materialized on/off choice; sparse legacy reset encoders cannot restore inheritance.
 */

describe('the grant readers', () => {
  it('agent → global → factory, null and absent inherit, false stays off', () => {
    expect(TYPED_FILE_TOOLS_FACTORY_DEFAULT).toBe(false)
    expect(resolveTypedFileToolsGrant(null, null)).toBe(false)
    expect(resolveTypedFileToolsGrant(null, true)).toBe(true)
    expect(resolveTypedFileToolsGrant(false, true)).toBe(false)
    expect(resolveTypedFileToolsGrant(true, false)).toBe(true)
    expect(agentTypedFileToolsValue({ nativeTools: { typedFileToolsEnabled: null } })).toBeNull()
    expect(agentTypedFileToolsValue({ typedFileToolsEnabled: true })).toBeNull()
    expect(agentTypedFileToolsValue({ nativeTools: { typedFileToolsEnabled: false } })).toBe(false)
    expect(globalTypedFileToolsValue({ global_tool_grid_settings: { typed_file_tools: true } })).toBe(true)
    expect(globalTypedFileToolsValue({ global_tool_grid_settings: {} })).toBeNull()
    expect(globalTypedFileToolsValue(null)).toBeNull()
  })

  it('the settings route refuses a global value that is not true, false or null', () => {
    expect(validateTypedFileToolsGlobalField(undefined)).toBeNull()
    expect(validateTypedFileToolsGlobalField({ cli: {} })).toBeNull()
    expect(validateTypedFileToolsGlobalField({ typed_file_tools: true })).toBeNull()
    expect(validateTypedFileToolsGlobalField({ typed_file_tools: null })).toBeNull()
    expect(validateTypedFileToolsGlobalField({ typed_file_tools: 'true' })).toBe('"Typed File Tools" must be true or false.')
    expect(validateTypedFileToolsGlobalField({ typed_file_tools: 1 })).toBe('"Typed File Tools" must be true or false.')
  })
})

describe('current writes preserve the explicit materialized choice', () => {
  it("a legacy null reset is refused, while an explicit false changes exactly the owned field", () => {
    const changes = nativeToolsFieldChanges(
      { nativeTools: { bashEnabled: true, [TYPED_FILE_TOOLS_AGENT_FIELD]: true } },
      { nativeTools: { bashEnabled: true } }
    )
    expect(changes).toEqual({ [TYPED_FILE_TOOLS_AGENT_FIELD]: null })
    expect(() => planRecordFieldOps('provider_specific_settings', { nativeTools: changes }, new Set()))
      .toThrow('Typed File Tools must be explicitly on or off.')
    const ops = planRecordFieldOps('provider_specific_settings', { nativeTools: { [TYPED_FILE_TOOLS_AGENT_FIELD]: false } }, new Set())
    expect(ops).toContainEqual({ op: 'set', field: 'provider_specific_settings', key: 'nativeTools', subkey: TYPED_FILE_TOOLS_AGENT_FIELD, value: false })
    expect(ops.filter((op) => op.op === 'set' || op.op === 'delete')).toHaveLength(1)
  })

  it("a Subagent's legacy reset is also refused and an explicit false is writable", () => {
    const patch = diffSubagentPayload(
      { provider_specific_settings: { nativeTools: { [TYPED_FILE_TOOLS_AGENT_FIELD]: false } } },
      { provider_specific_settings: { nativeTools: {} } }
    )
    expect(patch).toEqual({ provider_specific_settings: { nativeTools: { [TYPED_FILE_TOOLS_AGENT_FIELD]: null } } })
    expect(() => planSubagentRecordUpdate({ writes: patch, now: '2026-11-05T00:00:00.000Z' }))
      .toThrow('Typed File Tools must be explicitly on or off.')
    expect(planSubagentRecordUpdate({ writes: { provider_specific_settings: { nativeTools: { [TYPED_FILE_TOOLS_AGENT_FIELD]: false } } },
      now: '2026-11-05T00:00:00.000Z' }).ops).toContainEqual({
      op: 'set', field: 'provider_specific_settings', key: 'nativeTools', subkey: TYPED_FILE_TOOLS_AGENT_FIELD, value: false
    })
  })
})

describe('P2c host/workspace qualification shared by registration, guidance and Settings', () => {
  const mac = { platform: 'darwin', containerized: false, linuxKernel: null }
  const linux = { platform: 'linux', containerized: false, linuxKernel: '5.6.0' }

  // SA-137 Round 2 (R2-5): Docker Sandbox on a Mac mounts the host workspace at the same path.
  it('admits Mac Local, Apple and Docker Sandbox host mounts, and nothing else', () => {
    expect(typedFileToolsUnavailableReason('local', mac)).toBeNull()
    expect(typedFileToolsUnavailableReason('apple_container', mac)).toBeNull()
    expect(typedFileToolsUnavailableReason('docker_sandbox', mac)).toBeNull()
    expect(typedFileToolsUnavailableReason('docker_sandbox', linux)).toBe('Typed file tools are not qualified with this Sandbox Level yet.')
    expect(typedFileToolsUnavailableReason('remote_gateway', mac)).toBe('Typed file tools are not qualified with this Sandbox Level yet.')
  })

  it('admits supported native Linux Local only, refusing unknown or older kernel contracts', () => {
    expect(typedFileToolsUnavailableReason('local', linux)).toBeNull()
    expect(typedFileToolsUnavailableReason('local', { ...linux, linuxKernel: '7.0.14-linuxkit' })).toBeNull()
    expect(typedFileToolsUnavailableReason('local', { ...linux, linuxKernel: '5.5.19' })).toBe('Typed file tools need Linux 5.6 or later and the native file helper.')
    expect(typedFileToolsUnavailableReason('local', { ...linux, linuxKernel: null })).not.toBeNull()
    expect(typedFileToolsUnavailableReason('apple_container', linux)).not.toBeNull()
  })

  it('admits Linux app Local and explicitly configured operator Sandbox, not an unavailable mapping', () => {
    const app = { ...linux, containerized: true }
    expect(typedFileToolsUnavailableReason('local', app)).toBeNull()
    expect(typedFileToolsUnavailableReason('docker_sandbox', app)).toMatch(/host operator.*host bind workspace/)
    expect(typedFileToolsUnavailableReason('docker_sandbox', { ...app, dockerSandboxOperatorConfigured: true })).toBeNull()
    expect(typedFileToolsUnavailableReason('apple_container', app)).not.toBeNull()
    expect(typedFileToolsUnavailableReason('local', { ...app, linuxKernel: '5.5.0' })).not.toBeNull()
    expect(typedFileToolsUnavailableReason('local', { ...mac, containerized: true })).not.toBeNull()
  })

  it('does not infer Windows support or host facts from a saved grant', () => {
    expect(typedFileToolsUnavailableReason('local', { platform: 'win32', containerized: false, linuxKernel: null })).toBe('Typed file tools need a supported Mac or Linux host.')
    expect(typedFileToolsUnavailableReason('local', null)).toBe('Checking typed file tools availability.')
  })
})
