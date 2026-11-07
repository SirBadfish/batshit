import { describe, expect, it } from 'vitest'
import { buildZipStatusPresentation, resolveZipStateActors } from '../zipStatusPresentation'
import { judgeModelName } from '../judgeProviders'
import { describeNotRefreshedReason } from '../liveFileReads'

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

describe('buildZipStatusPresentation with a live file snapshot (SA-137 P4)', () => {
  it('adds the snapshot line after the state, said as sent only when the request was issued', () => {
    expect(buildZipStatusPresentation({ expandedReason: 'buffer', liveSnapshot: { delivery: 'issued', promptTokens: 1_234 } }).tooltip).toBe(
      'Expanded by the automatic rules (buffer and threshold). File snapshot used for the newest reply: the file as it was when that reply started (1,234 tokens)'
    )
    expect(buildZipStatusPresentation({ isUnzipped: true, holdLabel: 'Held by you', liveSnapshot: { delivery: 'prepared', promptTokens: 50 } }).tooltip).toBe(
      'Held by you. File snapshot prepared for the newest reply (50 tokens); sending it was not confirmed'
    )
  })

  it('keeps the compressed state first, a size-guarded one included', () => {
    expect(buildZipStatusPresentation({ isZipped: true, sizeGuard: 'large', liveSnapshot: { delivery: 'issued', promptTokens: 17_000 } }).tooltip).toBe(
      'Compressed. Measured from the file as it was when the newest reply started (17,000 tokens); compressed, so its text was not sent'
    )
    expect(buildZipStatusPresentation({ isZipped: true, sizeGuard: 'too_large', tokens: 30_000, liveSnapshot: { delivery: 'issued', promptTokens: 30_000 } }).tooltip).toBe(
      'Too large for the prompt (about 30,000 tokens). The agent reads it in parts. Measured from the file as it was when the newest reply started (30,000 tokens); compressed, so its text was not sent'
    )
  })

  it('a dead copy with a refreshed snapshot says the snapshot was taken and the copy is compressed since, never "used" or "not sent" (D3 amended, 2026-11-04)', () => {
    // 17,000 tokens: the size guard may have compressed it in that compile, so "used" would be false.
    expect(buildZipStatusPresentation({ isZipped: true, deadCopyReason: 'stale', liveSnapshot: { delivery: 'issued', promptTokens: 17_000 } }).tooltip).toBe(
      'Compressed: stale, edited since. File snapshot taken for the newest reply (17,000 tokens); compressed since'
    )
    expect(buildZipStatusPresentation({ isZipped: true, deadCopyReason: 'superseded', liveSnapshot: { delivery: 'prepared', promptTokens: 120 } }).tooltip).toBe(
      'Compressed: superseded by a later read. File snapshot taken for the newest reply (120 tokens); compressed since'
    )
  })

  it('says nothing new without a snapshot', () => {
    expect(buildZipStatusPresentation({ isZipped: true, deadCopyReason: 'stale' }).tooltip).toBe('Compressed: stale, edited since')
  })
})

describe('buildZipStatusPresentation with an unknown live file snapshot (SA-137 P4 review M1)', () => {
  it('keeps the stored state and says the newest reply\'s snapshot is unknown', () => {
    expect(buildZipStatusPresentation({ isZipped: true, deadCopyReason: 'stale', liveSnapshot: { delivery: 'unknown' } }).tooltip).toBe(
      'Compressed: stale, edited since. Whether the newest reply showed this file as a fresh snapshot is unknown (no record for that reply), so this state may not match it'
    )
    expect(buildZipStatusPresentation({ isZipped: true, sizeGuard: 'too_large', tokens: 30_000, liveSnapshot: { delivery: 'unknown' } }).tooltip).toBe(
      'Too large for the prompt (about 30,000 tokens). The agent reads it in parts. Whether the newest reply showed this file as a fresh snapshot is unknown (no record for that reply), so this state may not match it'
    )
  })
})

describe('buildZipStatusPresentation with a copy the newest reply did not refresh (SA-137 Round 2)', () => {
  // The words come from the one owner (`describeNotRefreshedReason`); this test pins where they sit.
  const LINE = `Not shown to the agent in the newest reply: not refreshed (${describeNotRefreshedReason('not-readable')}). Batshit tries again at the next reply.`
  const notRefreshed = { delivery: 'not-refreshed' as const, reason: 'not-readable' }

  it('says the state first, then that the agent was not shown it and that Batshit tries again', () => {
    expect(buildZipStatusPresentation({ isZipped: true, liveSnapshot: notRefreshed }).tooltip).toBe(`Compressed. ${LINE}`)
  })

  it('keeps the hold label: a held copy reads Compressed, Held by you, then the line', () => {
    expect(buildZipStatusPresentation({ isZipped: true, isUnzipped: true, holdLabel: 'Held by you', liveSnapshot: notRefreshed }).tooltip).toBe(
      `Compressed. Held by you. ${LINE}`
    )
    expect(buildZipStatusPresentation({ isZipped: true, isUnzipped: true, holdLabel: 'Held by you (3 messages left)', liveSnapshot: notRefreshed }).tooltip).toBe(
      `Compressed. Held by you (3 messages left). ${LINE}`
    )
    expect(buildZipStatusPresentation({ isZipped: true, isUnzipped: true, holdLabel: 'Held by Opie', liveSnapshot: notRefreshed }).tooltip).toBe(
      `Compressed. Held by Opie. ${LINE}`
    )
  })

  it('a dead copy keeps its own reason and hold wording, and the line follows', () => {
    expect(buildZipStatusPresentation({ isZipped: true, deadCopyReason: 'superseded', liveSnapshot: notRefreshed }).tooltip).toBe(
      `Compressed: superseded by a later read. ${LINE}`
    )
    expect(buildZipStatusPresentation({ isZipped: true, deadCopyReason: 'stale', holdLabel: 'Held by you', liveSnapshot: notRefreshed }).tooltip).toBe(
      `Compressed: stale, edited since. Held by you; the hold moves to the next whole read. ${LINE}`
    )
  })

  it('does not hide who zipped it when nobody holds it', () => {
    expect(buildZipStatusPresentation({ isZipped: true, manualZip: true, liveSnapshot: notRefreshed }).tooltip).toBe(`Compressed: you zipped it. ${LINE}`)
    expect(buildZipStatusPresentation({ isZipped: true, autoZip: true, liveSnapshot: notRefreshed }).tooltip).toBe(`Compressed at once (Auto). ${LINE}`)
  })

  it('says the reason in plain words for each reason, and a kind it does not know', () => {
    const tooltip = (reason: string) => buildZipStatusPresentation({ isZipped: true, liveSnapshot: { delivery: 'not-refreshed', reason } }).tooltip
    for (const reason of ['not-readable', 'root-changed', 'read-while-off', 'deadline', 'replay-expired']) {
      expect(tooltip(reason)).toContain(`not refreshed (${describeNotRefreshedReason(reason)}). Batshit tries again`)
      expect(tooltip(reason)).not.toContain(reason)
    }
    expect(tooltip('something-new')).toContain('not refreshed (Batshit cannot refresh this kind of read)')
  })

  it('never calls it used or stale, and never shows a raw reason code', () => {
    const tooltip = buildZipStatusPresentation({ isZipped: true, isUnzipped: true, holdLabel: 'Held by you', liveSnapshot: { delivery: 'not-refreshed', reason: 'changed-during-read' } }).tooltip
    expect(tooltip).not.toMatch(/\bused\b|\bstale\b/i)
    expect(tooltip).not.toContain('changed-during-read')
  })

  it('a too-large copy keeps the too-large words, then the line', () => {
    expect(buildZipStatusPresentation({ isZipped: true, sizeGuard: 'too_large', tokens: 30_000, liveSnapshot: notRefreshed }).tooltip).toBe(
      `Too large for the prompt (about 30,000 tokens). The agent reads it in parts. ${LINE}`
    )
  })

  it('sets the aria label to the same words', () => {
    const presentation = buildZipStatusPresentation({ isZipped: true, isUnzipped: true, holdLabel: 'Held by you', liveSnapshot: notRefreshed })
    expect(presentation.ariaLabel).toBe(presentation.tooltip)
    expect(presentation.state).toBe('zipped')
  })

  it('without the snapshot the same copy reads as it did (a non-strict static copy produces none)', () => {
    expect(buildZipStatusPresentation({ isZipped: true, isUnzipped: true, holdLabel: 'Held by you', liveSnapshot: null }).tooltip).toBe('Compressed')
    expect(buildZipStatusPresentation({ isZipped: true, liveSnapshot: null }).tooltip).toBe('Compressed')
  })
})
