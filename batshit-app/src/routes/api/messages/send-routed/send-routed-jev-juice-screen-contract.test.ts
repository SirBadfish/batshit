import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * SA-120 P7 — the incoming-text screen inside send-routed. The lane's logic has its own suites
 * (`untrustedText.jev`, `untrustedTextTurn`, `dmScreen`); these pins hold the WIRING: ONE
 * provider per send, composed LAST in the one tail provider, never for a group speaker, fed
 * the DM id from the SERVER's wake registry and never from the request body, with no compiler
 * option of its own, and with NOTHING of it anywhere near the approval resume paths.
 */
describe('send-routed Jev Juice incoming-text screen contracts', () => {
  const streamStart = source.indexOf('async function handleBatshitAgentStream({')
  const seam = source.indexOf('const jevJuiceHintProvider = jevJuiceGroupSelection', streamStart)
  const compile = source.indexOf('await databaseService.buildFormattedChatInput(', seam)
  const compileEnd = source.indexOf("throw new Error('Failed to build formatted chat input for API or CLI agent')", compile)
  const seamBody = source.slice(seam, compile)

  it('composes the woken turn\'s replay last, after the other three tail lanes', () => {
    expect(seam).toBeGreaterThan(streamStart)
    const hints = seamBody.indexOf('buildSkillToolHintProvider({')
    const zips = seamBody.indexOf('jevJuiceSmartZip?.hintProvider,')
    const notes = seamBody.indexOf('jevJuicePostTurnCheck?.hintProvider,')
    const screen = seamBody.indexOf('buildUntrustedTextHintProvider({')
    expect(hints).toBeGreaterThan(-1)
    expect(zips).toBeGreaterThan(hints)
    expect(notes).toBeGreaterThan(zips)
    expect(screen).toBeGreaterThan(notes)
    expect(source.split('buildUntrustedTextHintProvider({').length - 1).toBe(1)
    // A group speaker's replay takes the seam alone, so a group turn never reaches this lane.
    expect(seamBody.indexOf('? buildGroupSpeakerProvider(jevJuiceGroupSelection, jevJuiceTurn)')).toBeLessThan(screen)
  })

  it('names the DM from the wake registry (server-owned), never from the request body', () => {
    const start = seamBody.indexOf('buildUntrustedTextHintProvider({')
    const call = seamBody.slice(start, seamBody.indexOf('}),', start))
    expect(call).toContain('wakeDmId: getWakeRun(sessionId)?.origin?.dmId ?? null,')
    expect(call).not.toContain('metadata')
    expect(call).toContain("message: typeof messageForCompilation === 'string' ? messageForCompilation : ''")
    expect(call).toContain('isGroupTurn: Boolean(groupContext) || streamMetadata?.groupChat === true')
    expect(call).toContain('collector: jevJuiceTurn,')
    expect(call).toContain('agentId,')
  })

  it('gives the compiler no seam of its own and screens nothing here (the DM was screened when it arrived)', () => {
    expect(source.slice(compile, compileEnd)).not.toMatch(/untrustedText|UntrustedText/)
    expect(source).not.toContain('screenUntrustedText')
    expect(source).not.toContain('stampDmScreen')
  })

  it('never hands a screen to an approval: the only mention of the lane in this route is the tail provider', () => {
    const mentions = source.split('\n').filter((line) => /untrustedtext|incoming-text screen|\.screen\b/i.test(line))
    expect(mentions.map((line) => line.trim())).toEqual([
      'buildUntrustedTextHintProvider,',
      'buildUntrustedTextHintProvider({'
    ])
  })
})
