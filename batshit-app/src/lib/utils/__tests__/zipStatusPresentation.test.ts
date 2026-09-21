import { describe, expect, it } from 'vitest'
import { buildZipStatusPresentation, resolveZipStateActors } from '../zipStatusPresentation'

/**
 * SA-120 P5 — the one reading of stored zip-state sources for the chat badges and the Zip
 * Manager. `inferred` (Jev Juice) is its own actor and must never be drawn as a user lock,
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
  it('names Jev Juice and the countdown on an inferred unzip', () => {
    const presentation = buildZipStatusPresentation({ isUnzipped: true, expandedReason: 'inferred', inferredControlled: true, remainingMessages: 2 })
    expect(presentation).toMatchObject({ state: 'unzipped', actor: 'inferred', duration: 'countdown', remainingMessages: 2 })
    expect(presentation.tooltip).toBe('Jev unzipped this for 2 messages')
    expect(buildZipStatusPresentation({ isUnzipped: true, inferredControlled: true }).actor).toBe('inferred')
  })

  it('an explicit actor always reads over the inferred flag', () => {
    expect(buildZipStatusPresentation({ isUnzipped: true, expandedReason: 'user', inferredControlled: true }).actor).toBe('user')
    expect(buildZipStatusPresentation({ isUnzipped: true, agentControlled: true, inferredControlled: true }).actor).toBe('agent')
  })

  it('says who zipped a result Jev Juice closed, and leaves the other zipped tooltips as they were', () => {
    expect(buildZipStatusPresentation({ isZipped: true, manualZip: true, inferredControlled: true }).tooltip).toBe(
      'Zipped by Jev: the agent seemed done with it'
    )
    expect(buildZipStatusPresentation({ isZipped: true, manualZip: true }).tooltip).toBe('Zipped manually')
    expect(buildZipStatusPresentation({ isZipped: true, manualZip: true, agentControlled: true }).tooltip).toBe('Zipped manually after agent zip control')
    expect(buildZipStatusPresentation({ isZipped: true, autoZip: true }).tooltip).toBe('Auto-zipped')
    expect(buildZipStatusPresentation({ isZipped: true }).tooltip).toBe('Zipped')
  })
})
