import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * SA-120 P9 — quick actions inside send-routed. The lane's judgment runs in its own route
 * BEFORE the browser decides whether to send at all (`/api/jev-juice/quick-action`); here the
 * only wiring is the tell: ONE replay provider per send, composed in the fixed order (after
 * the after-reply notes, before the woken turn's screen), fed the request's own history and
 * nothing else, never for a group speaker, with no Jev call and no compiler option of its own.
 */
describe('send-routed Jev Juice quick-action contracts', () => {
  const streamStart = source.indexOf('async function handleBatshitAgentStream({')
  const seam = source.indexOf('const jevJuiceHintProvider = jevJuiceGroupSelection', streamStart)
  const compile = source.indexOf('await databaseService.buildFormattedChatInput(', seam)
  const compileEnd = source.indexOf("throw new Error('Failed to build formatted chat input for API or CLI agent')", compile)
  const seamBody = source.slice(seam, compile)

  it('composes the tell after the after-reply notes and before the woken turn\'s screen', () => {
    expect(seam).toBeGreaterThan(streamStart)
    const notes = seamBody.indexOf('jevJuicePostTurnCheck?.hintProvider,')
    const tell = seamBody.indexOf('buildQuickActionTellProvider({')
    const screen = seamBody.indexOf('buildUntrustedTextHintProvider({')
    expect(notes).toBeGreaterThan(-1)
    expect(tell).toBeGreaterThan(notes)
    expect(screen).toBeGreaterThan(tell)
    expect(source.split('buildQuickActionTellProvider({').length - 1).toBe(1)
    expect(seamBody.indexOf('? buildGroupSpeakerProvider(jevJuiceGroupSelection, jevJuiceTurn)')).toBeLessThan(tell)
  })

  it('reads the request\'s own history and the group flag, nothing else', () => {
    const start = seamBody.indexOf('buildQuickActionTellProvider({')
    const call = seamBody.slice(start, seamBody.indexOf('}),', start))
    expect(call).toContain('messages,')
    expect(call).toContain('isGroupTurn: Boolean(groupContext) || streamMetadata?.groupChat === true')
    expect(call).not.toContain('collector')
    expect(call).not.toContain('client')
  })

  it('judges nothing here: no quick-action call, no compiler option, nothing near the approval paths', () => {
    expect(source).not.toContain('computeQuickAction')
    expect(source).not.toContain('quickActions.jev')
    expect(source.slice(compile, compileEnd)).not.toMatch(/quickAction|QuickAction/)
    const mentions = source.split('\n').filter((line) => /quickaction/i.test(line))
    expect(mentions.map((line) => line.trim())).toEqual(['buildQuickActionTellProvider,', 'buildQuickActionTellProvider({'])
  })
})
