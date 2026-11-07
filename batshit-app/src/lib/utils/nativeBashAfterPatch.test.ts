import { describe, expect, it } from 'vitest'
import { nativeBashAfterPatchFromProvider, nativeBashApprovalCardsEnabled, normalizeNativeBashAccessMode } from './nativeBashAfterPatch'
import { buildToolGuidanceZipPromptBlock } from './toolPromptInjection'

describe('after-patch guidance follows native Bash policy', () => {
  it.each([
    { mode: 'plan', cards: true, context: {}, enabled: false },
    { mode: 'agent', cards: false, context: {}, enabled: false },
    { mode: 'agent', cards: true, context: {}, enabled: true },
    { mode: 'agent', cards: true, context: { groupMemberRun: true }, enabled: false },
    { mode: 'agent', cards: true, context: { toolApprovalMode: 'off' as const }, enabled: false },
    { mode: 'agent', cards: false, context: { toolApprovalMode: 'all' as const }, enabled: true },
    { mode: 'dangerous', cards: false, context: { groupMemberRun: true }, enabled: true }
  ])('matches $mode / cards=$cards / $context', ({ mode, cards, context, enabled }) => {
    const actual = nativeBashAfterPatchFromProvider({ nativeTools: { bashAccessMode: mode, bashAgentApprovalCardsEnabled: cards } }, context)
    expect(actual).toBe(enabled)
    const block = buildToolGuidanceZipPromptBlock({ bashCommandsAfterPatchRun: actual })
    expect(block.includes('**Test in the same call:**')).toBe(enabled)
    expect(block.includes('**Test in a separate call:**')).toBe(!enabled)
  })
  it('preserves legacy mode and approval aliases, nested/root ordering and boolean values', () => {
    for (const [value, expected] of [['readonly', 'plan'], ['workspace', 'agent'], ['unrestricted', 'dangerous']] as const) {
      expect(normalizeNativeBashAccessMode(value)).toBe(expected)
    }
    for (const value of ['__proto__', 'constructor', 'toString', 'unknown']) expect(normalizeNativeBashAccessMode(value)).toBeNull()
    expect(nativeBashApprovalCardsEnabled({ nativeTools: { bashApprovalCardsEnabled: 'enabled' } })).toBe(true)
    expect(nativeBashApprovalCardsEnabled({ nativeTools: { bashApprovalCardsEnabled: true }, bashAgentApprovalCardsEnabled: false })).toBe(false)
    expect(nativeBashAfterPatchFromProvider({ batshitNativeTools: { bashPolicyMode: 'workspace', nativeBashApprovalCardsEnabled: 'on' } })).toBe(true)
  })
  it('never teaches the combined call when the caller has not supplied its policy', () => {
    expect(buildToolGuidanceZipPromptBlock()).not.toContain('**Test in the same call:**')
  })
})
