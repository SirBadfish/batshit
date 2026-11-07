import { describe, expect, it } from 'vitest'
import { planAgentRecordUpdate, serializeAgentRecordPlan } from '../agentRecordUpdate'
import { planSubagentRecordUpdate } from '../subagentRecordUpdate'
const plans = {
  Primary: (provider: unknown) => planAgentRecordUpdate({ updates: { provider_specific_settings: provider }, now: 'fixture' }),
  Subagent: (provider: unknown) => planSubagentRecordUpdate({ writes: { provider_specific_settings: provider }, now: 'fixture' })
}
describe.each(Object.entries(plans))('%s sparse tool settings permanent retirement guard', (_label, plan) => {
  it('refuses canonical ancestor deletion and null/text inheritance before any plan reaches Redis', () => {
    for (const provider of [null, { nativeTools: null }, { nativeTools: { typedFileToolsEnabled: null } }, { nativeTools: { typedFileToolsEnabled: 'false' } }]) expect(() => plan(provider)).toThrow(/explicit|on or off/)
  })
  it('refuses finite flat/canonical/alias operational writes while preserving unrelated settings', () => {
    for (const provider of [{ nativeWebSearchProvider: 'exa' }, { nativeTools: { agentBrowserProvider: 'kernel' } }, { batshitNativeTools: { agentBrowserTimeoutMs: 5000 } }]) expect(() => plan(provider)).toThrow(/global tool option/)
    const serialized = serializeAgentRecordPlan(plan({ nativeTools: { bashEnabled: false }, modelKey: 'keep' }).ops)
    expect(serialized).toContain('bashEnabled'); expect(serialized).toContain('modelKey')
    expect(serialized).not.toContain('typedFileToolsEnabled')
  })
  it('keeps an explicit canonical choice at its exact leaf and refuses the ignored legacy target', () => {
    expect(serializeAgentRecordPlan(plan({ nativeTools: { typedFileToolsEnabled: false } }).ops)).toContain('typedFileToolsEnabled')
    expect(() => plan({ batshitNativeTools: { typedFileToolsEnabled: true } })).toThrow(/current nativeTools/)
  })
})
