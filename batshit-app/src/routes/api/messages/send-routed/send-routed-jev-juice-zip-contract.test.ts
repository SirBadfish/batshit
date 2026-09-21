import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * SA-120 P5 — smart zip inside send-routed. The lane's logic has its own suites
 * (`smartZip.jev`, `jevJuiceTurn`, `zipStateInferred`, compile contract S25); these pins hold
 * the WIRING and the ORDER: one turn per send, gated on this send's own freshly read
 * `global_zip_settings` (the ONE switch); its open provider and its tail replay both reach
 * the compiler; a group speaker's replay still wins the tail seam outright and gets no zip
 * turn; and zip state is written ONLY at the accepted-send boundary, after the compile,
 * beside the memory commit, never for a group or a resume.
 */
describe('send-routed Jev Juice smart zip contracts', () => {
  const streamStart = source.indexOf('async function handleBatshitAgentStream({')
  const collector = source.indexOf('const jevJuiceTurn = createJevJuiceTurnCollector()', streamStart)
  const zipTurn = source.indexOf('const jevJuiceSmartZip = jevJuiceGroupSelection', collector)
  const seam = source.indexOf('const jevJuiceHintProvider = jevJuiceGroupSelection', zipTurn)
  const compile = source.indexOf('await databaseService.buildFormattedChatInput(', seam)
  const compileEnd = source.indexOf("throw new Error('Failed to build formatted chat input for API or CLI agent')", compile)

  it('builds one smart zip turn per send, gated on this send\'s own global zip settings, and never for a group speaker', () => {
    expect(streamStart).toBeGreaterThan(-1)
    expect(collector).toBeGreaterThan(streamStart)
    expect(zipTurn).toBeGreaterThan(collector)
    expect(seam).toBeGreaterThan(zipTurn)
    expect(compile).toBeGreaterThan(seam)

    const turnBody = source.slice(zipTurn, seam)
    expect(turnBody).toContain('? undefined\n    : buildSmartZipTurn({')
    expect(turnBody).toContain('sessionId,')
    expect(turnBody).toContain('globalZipSettings,')
    expect(turnBody).toContain('collector: jevJuiceTurn')
    expect(turnBody).toContain('isGroupTurn: Boolean(groupContext) || streamMetadata?.groupChat === true')
    expect(turnBody).toContain("message: typeof messageForCompilation === 'string' ? messageForCompilation : ''")
    // The settings come off a fresh read for every send, so the switch is live with no cache.
    expect(source).toContain('globalZipSettings = userSettings?.global_zip_settings || undefined')
    expect(source.split('buildSmartZipTurn({').length - 1).toBe(1)
  })

  it('hands the compiler the open provider and composes the tail replay after the skill/tool lane', () => {
    const seamBody = source.slice(seam, compile)
    const replay = seamBody.indexOf('? buildGroupSpeakerProvider(jevJuiceGroupSelection, jevJuiceTurn)')
    const composer = seamBody.indexOf(': composeJevJuiceHintProviders([')
    const skillLane = seamBody.indexOf('buildSkillToolHintProvider({', composer)
    const zipTail = seamBody.indexOf('jevJuiceSmartZip?.hintProvider,', composer)
    expect(replay).toBeGreaterThan(-1)
    expect(composer).toBeGreaterThan(replay)
    expect(skillLane).toBeGreaterThan(composer)
    expect(zipTail).toBeGreaterThan(skillLane)

    const compileOptions = source.slice(compile, compileEnd)
    expect(compileOptions).toContain('      jevJuiceHintProvider,\n')
    expect(compileOptions).toContain('      jevJuiceSmartZipProvider: jevJuiceSmartZip?.openProvider,\n')
  })

  it('stores what the compile opened only at the accepted-send boundary, beside the memory commit', () => {
    const consumeGate = source.indexOf('if (consumeSessionClips) {\n    await consumePostCompileSessionClips(sessionId)', compileEnd)
    const memoryCommit = source.indexOf('memoryTurnCommit = await commitMemoryTurnState({', consumeGate)
    const zipGate = source.indexOf('if (jevJuiceSmartZip && messageForCompilation && !groupContext) {', memoryCommit)
    const write = source.indexOf('const stored = await writeInferredUnzips(', zipGate)
    const told = source.indexOf('if (told.length > 0) await markInferredRezipsTold(sessionId, told)', write)
    const abortRegistered = source.indexOf('registerStreamAbort(sessionId, messageId, streamAbortController)', consumeGate)

    expect(consumeGate).toBeGreaterThan(compileEnd)
    expect(memoryCommit).toBeGreaterThan(consumeGate)
    expect(zipGate).toBeGreaterThan(memoryCommit)
    expect(write).toBeGreaterThan(zipGate)
    expect(told).toBeGreaterThan(write)
    // Still inside the accepted-send block: the stream has not started yet.
    expect(told).toBeLessThan(abortRegistered)

    const gateBody = source.slice(zipGate, abortRegistered)
    // The commit reads the compile's own answer, never a second call.
    expect(gateBody).toContain('const opens = jevJuiceSmartZip.getOpens()')
    // Only what Redis really took reaches the reply metadata (a user or agent action that
    // landed since the compile wins at the write).
    expect(gateBody).toContain('.filter((open) => stored.includes(open.zipId))')
    expect(gateBody).toContain('jevJuiceTurn.zips.opened.push(')
    // ONE writer site for the opens in the whole route.
    expect(source.split('writeInferredUnzips(').length - 1).toBe(1)
  })

  it('hands the compiler the exposed observer beside the open provider', () => {
    const compileOptions = source.slice(compile, compileEnd)
    expect(compileOptions).toContain('      jevJuiceSmartZipExposedObserver: jevJuiceSmartZip?.exposedObserver,\n')
  })

  it('runs the after-reply step only once the reply is complete and its snapshot has had its last write, never for a silent reply', () => {
    const finalize = source.indexOf("await finalizeAssistantMessage('postStream')", compileEnd)
    const complete = source.indexOf('await streamAdapter.emitComplete()', finalize)
    const snapshot = source.indexOf("await persistRuntimeSnapshot('succeeded')", complete)
    // SA-120 P6 shares this one site: the gate opens for either after-reply lane.
    const postTurnGate = source.indexOf('if (!silentResponse && (jevJuiceSmartZip || jevJuicePostTurnCheck)) {', snapshot)
    const postTurn = source.indexOf('? jevJuiceSmartZip.runPostTurn({ messageId, reply: finishedReply, newZipIds })', postTurnGate)
    const awaited = source.indexOf('await Promise.all([smartZipStep, postTurnCheckStep])', postTurn)
    const responseBuilt = source.indexOf('const response = json({', postTurn)

    expect(finalize).toBeGreaterThan(compileEnd)
    expect(complete).toBeGreaterThan(finalize)
    // The user already has the whole reply before Jev is asked anything.
    expect(snapshot).toBeGreaterThan(complete)
    expect(postTurnGate).toBeGreaterThan(snapshot)
    expect(postTurn).toBeGreaterThan(postTurnGate)
    // The step is awaited before the response is built, so a promoted follow-up turn sees it.
    expect(awaited).toBeGreaterThan(postTurn)
    expect(responseBuilt).toBeGreaterThan(awaited)

    const body = source.slice(postTurnGate, responseBuilt)
    expect(body).toContain("const finishedReply = finishSummary.content || finishSummary.text || ''")
    expect(body).toContain('const newZipIds = (finishSummary.zipReferences ?? [])')
    // ONE site: never on the error, abort, or interrupted paths.
    expect(source.split('jevJuiceSmartZip.runPostTurn(').length - 1).toBe(1)
  })

  it('never asks the lane directly', () => {
    expect(source).not.toContain('computeSmartZipRezips')
    expect(source).not.toContain('writeInferredRezips')
    expect(source).not.toContain('computeSmartZipHints')
    expect(source).not.toContain('jevJuiceSmartZip.openProvider(')
    expect(source).not.toContain('jevJuiceSmartZip.hintProvider(')
  })
})
