import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * SA-120 P4b — recall by meaning inside send-routed. The lane's logic has its own suites
 * (`semanticRecall.jev`, `jevJuiceTurn`, the recall engine); these pins hold the ORDER and
 * the hand-off: one provider per send, given to the compiler, and the SAME answer given to
 * the memory commit at the accepted-send boundary — never a second call, never a commit
 * on a continuation or a group turn.
 */
describe('send-routed Jev Juice memory recall contracts', () => {
  it('builds the recall turn before the compile and hands its provider to the compiler', () => {
    const streamStart = source.indexOf('async function handleBatshitAgentStream({')
    const collector = source.indexOf('const jevJuiceTurn = createJevJuiceTurnCollector()', streamStart)
    const recallTurn = source.indexOf('const jevJuiceMemoryRecall = buildSemanticRecallTurn({', collector)
    const compile = source.indexOf('await databaseService.buildFormattedChatInput(', recallTurn)
    const providerOption = source.indexOf('jevJuiceMemoryRecallProvider: jevJuiceMemoryRecall?.provider,', compile)
    const compileEnd = source.indexOf("throw new Error('Failed to build formatted chat input for API or CLI agent')", compile)
    const recordsAttached = source.indexOf('attachJevJuiceRecords(executionMetadata, jevJuiceTurn)', compile)

    expect(streamStart).toBeGreaterThan(-1)
    expect(collector).toBeGreaterThan(streamStart)
    expect(recallTurn).toBeGreaterThan(collector)
    expect(compile).toBeGreaterThan(recallTurn)
    expect(providerOption).toBeGreaterThan(compile)
    expect(providerOption).toBeLessThan(compileEnd)
    // The lane's Execution Viewer row rides the snapshot recorded after the compile.
    expect(recordsAttached).toBeGreaterThan(compileEnd)

    const turnBody = source.slice(recallTurn, source.indexOf('})', recallTurn))
    expect(turnBody).toContain('collector: jevJuiceTurn')
    expect(turnBody).toContain('isGroupTurn: Boolean(groupContext) || streamMetadata?.groupChat === true')
  })

  it('gives the memory commit the compile\'s own answer, inside the accepted-send gate', () => {
    const consumeGate = source.indexOf('if (consumeSessionClips) {\n    await consumePostCompileSessionClips(sessionId)')
    const userTurnGate = source.indexOf('if (messageForCompilation && !groupContext) {', consumeGate)
    const episodeUpkeep = source.indexOf('await ensureFixedSessionOpenEpisode({', userTurnGate)
    const commit = source.indexOf('memoryTurnCommit = await commitMemoryTurnState({', episodeUpkeep)
    const commitBody = source.slice(commit, source.indexOf('})', commit))

    expect(consumeGate).toBeGreaterThan(-1)
    expect(userTurnGate).toBeGreaterThan(consumeGate)
    expect(episodeUpkeep).toBeGreaterThan(userTurnGate)
    expect(commit).toBeGreaterThan(episodeUpkeep)
    expect(commitBody).toContain('inferredRecalls: jevJuiceMemoryRecall?.getRecalls(),')
    // ONE commit site; the lane never adds another.
    expect(source.split('commitMemoryTurnState({').length - 1).toBe(1)
    // The route never asks the lane directly: only the recall engine calls the provider.
    expect(source).not.toContain('jevJuiceMemoryRecall.provider(')
    expect(source).not.toContain('computeSemanticRecall')
  })
})
