import { describe, expect, it } from 'vitest'
import {
  resolveEnabledMode4InternalHelperTools,
  resolveManagedCliFetchZipAllowed
} from '../mode4InternalTools'
import { resolveBrokerToolToggles } from '$lib/utils/brokerAvailability'

describe('managed CLI Fetch Zip run scope', () => {
  it.each([true, false])('matches the actual helper profile when the saved toggle is %s', (enabled) => {
    const settings = { nativeTools: { fetchZipEnabled: enabled } }
    const offered = resolveEnabledMode4InternalHelperTools(resolveBrokerToolToggles(settings))
      .includes('batshit_server_fetch_zip')
    expect(resolveManagedCliFetchZipAllowed(settings, { configScope: 'managed' })).toBe(offered)
    expect(offered).toBe(enabled)
  })

  it('never grants an unmanaged, Subagent, or Worker run a new Fetch Zip exception', () => {
    const settings = { nativeTools: { fetchZipEnabled: true } }
    expect(resolveManagedCliFetchZipAllowed(settings, { configScope: 'global' })).toBe(false)
    expect(resolveManagedCliFetchZipAllowed(settings, {
      configScope: 'managed', delegatedRun: true
    })).toBe(false)
  })

  it('keeps the existing default-on primary helper when the toggle is absent', () => {
    expect(resolveManagedCliFetchZipAllowed({}, { configScope: 'managed' })).toBe(true)
  })
})
