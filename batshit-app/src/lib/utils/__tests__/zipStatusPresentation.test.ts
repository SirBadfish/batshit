import { describe, expect, it } from 'vitest'
import { buildZipStatusPresentation, resolveZipStateActors } from '../zipStatusPresentation'
import { judgeModelName } from '../judgeProviders'

/**
 * SA-120 P5 — the one reading of stored zip-state sources for the chat badges and the Zip
 * Manager. `inferred` (Judge Juice) is its own actor and must never be drawn as a user lock,
 * and an absent or unknown unzip source stays the user's, as it always was.
 */
describe('resolveZipStateActors', () => {
  it('maps each stored unzip source to its actor', () => {
    expect(resolveZipStateActors('user', undefined, true)).toEqual({ expandedReason: 'user', agentControlled: false, inferredControlled: false })
    expect(resolveZipStateActors('agent', undefined, true)).toEqual({ expandedReason: 'agent', agentControlled: true, inferredControlled: false })
    expect(resolveZipStateActors('inferred', undefined, true)).toEqual({ expandedReason: 'inferred', agentControlled: false, inferredControlled: true })
    expect(resolveZipStateActors(undefined, undefined, true).expandedReason).toBe('user')
    expect(resolveZipStateActors('mystery', undefined, true).expandedReason).toBe('user')
  })

  it('has no actor for a zip that is not held open, and reads who zipped it by hand', () => {
    expect(resolveZipStateActors(undefined, undefined, false)).toEqual({ expandedReason: undefined, agentControlled: false, inferredControlled: false })
    expect(resolveZipStateActors(undefined, 'agent', false)).toMatchObject({ agentControlled: true, inferredControlled: false })
    expect(resolveZipStateActors(undefined, 'inferred', false)).toMatchObject({ agentControlled: false, inferredControlled: true })
    // A stale source on a record that is no longer open claims nothing.
    expect(resolveZipStateActors('inferred', undefined, false).inferredControlled).toBe(false)
  })
})

describe('buildZipStatusPresentation with the inferred actor', () => {
  // BL-1485: a Judge Juice open is a hold for a number of messages, in the user's hold words, and
  // the judge is named by the SA-120 P10b helper: "the judge" while the stored state keeps none.
  it('a Judge Juice open reads as a hold by the judge, with its countdown', () => {
    const presentation = buildZipStatusPresentation({ isUnzipped: true, expandedReason: 'inferred', inferredControlled: true, remainingMessages: 2 })
    expect(presentation).toMatchObject({ state: 'unzipped', actor: 'inferred', duration: 'countdown', remainingMessages: 2 })
    expect(presentation.tooltip).toBe('Held by the judge (2 messages left)')
    expect(buildZipStatusPresentation({ isUnzipped: true, inferredControlled: true }).actor).toBe('inferred')
    expect(buildZipStatusPresentation({ isUnzipped: true, inferredControlled: true }).tooltip).toBe('Held by the judge')
  })

  it('names the judge that judged when the caller knows it, never a hard-coded Jev', () => {
    const name = judgeModelName({ kind: 'ollama', modelId: 'clef-flash:latest' })
    expect(name).toBe('Clef Flash')
    expect(buildZipStatusPresentation({ isUnzipped: true, inferredControlled: true, remainingMessages: 1, judgeName: name }).tooltip).toBe(
      'Held by Clef Flash (1 message left)'
    )
    expect(buildZipStatusPresentation({ isZipped: true, manualZip: true, inferredControlled: true, judgeName: judgeModelName({ kind: 'typesafe' }) }).tooltip).toBe(
      'Compressed by Jev: the agent seemed done with it'
    )
    expect(buildZipStatusPresentation({ isUnzipped: true, inferredControlled: true, judgeName: '  ' }).tooltip).toBe('Held by the judge')
  })

  it('an explicit actor always reads over the inferred flag', () => {
    expect(buildZipStatusPresentation({ isUnzipped: true, expandedReason: 'user', inferredControlled: true }).actor).toBe('user')
    expect(buildZipStatusPresentation({ isUnzipped: true, agentControlled: true, inferredControlled: true }).actor).toBe('agent')
  })

  it('says compressed for every compressed result, and who zipped it when someone did (BL-1485)', () => {
    expect(buildZipStatusPresentation({ isZipped: true, manualZip: true, inferredControlled: true }).tooltip).toBe(
      'Compressed by the judge: the agent seemed done with it'
    )
    expect(buildZipStatusPresentation({ isZipped: true, manualZip: true }).tooltip).toBe('Compressed: you zipped it')
    expect(buildZipStatusPresentation({ isZipped: true, manualZip: true, agentControlled: true }).tooltip).toBe('Compressed: the agent zipped it')
    expect(buildZipStatusPresentation({ isZipped: true, autoZip: true }).tooltip).toBe('Compressed at once (Auto)')
    expect(buildZipStatusPresentation({ isZipped: true }).tooltip).toBe('Compressed')
  })

  it('says expanded for a result the automatic rules keep open (BL-1485)', () => {
    expect(buildZipStatusPresentation({ remainingMessages: 2 }).tooltip).toBe('Expanded: compresses in 2 messages')
    expect(buildZipStatusPresentation({}).tooltip).toBe('Expanded by the automatic rules (buffer and threshold)')
  })

  it('keeps the badge words P2 settled', () => {
    expect(buildZipStatusPresentation({ isUnzipped: true, expandedReason: 'user', holdLabel: 'Held by you' }).tooltip).toBe('Held by you')
    expect(buildZipStatusPresentation({ isUnzipped: true, expandedReason: 'agent', holdLabel: 'Held by Opie' }).tooltip).toBe('Held by Opie')
    expect(buildZipStatusPresentation({ isZipped: true, deadCopyReason: 'superseded' }).tooltip).toBe('Compressed: superseded by a later read')
    expect(buildZipStatusPresentation({ isZipped: true, deadCopyReason: 'stale' }).tooltip).toBe('Compressed: stale, edited since')
  })

  it('never says unzipped, zipped as a state, or names Jev without a judge', () => {
    const inputs = [
      {}, { remainingMessages: 3 }, { isUnzipped: true }, { isUnzipped: true, isPermanent: true },
      { isUnzipped: true, expandedReason: 'agent' as const }, { isUnzipped: true, inferredControlled: true, remainingMessages: 2 },
      { isZipped: true }, { isZipped: true, autoZip: true }, { isZipped: true, manualZip: true },
      { isZipped: true, manualZip: true, agentControlled: true }, { isZipped: true, manualZip: true, inferredControlled: true }
    ]
    for (const input of inputs) {
      const tooltip = buildZipStatusPresentation(input).tooltip
      expect(tooltip, JSON.stringify(input)).not.toMatch(/unzipped|Unzipped|^Zipped|Auto-zipped|Auto-managed|Jev|zip control/)
    }
  })
})

describe('buildZipStatusPresentation with the size guard', () => {
  it('uses the too-large reason even when an old Hold still exists', () => {
    expect(buildZipStatusPresentation({
      isZipped: true,
      isUnzipped: true,
      holdLabel: 'Held by you',
      sizeGuard: 'too_large',
      tokens: 30_000
    })).toMatchObject({
      state: 'zipped',
      actor: null,
      tooltip: 'Too large for the prompt (about 30,000 tokens). The agent reads it in parts.'
    })
  })

  it('leaves an ordinary large result with its winning Hold wording', () => {
    expect(buildZipStatusPresentation({ isUnzipped: true, holdLabel: 'Held by you', tokens: 12_000 }).tooltip).toBe('Held by you')
  })
})
