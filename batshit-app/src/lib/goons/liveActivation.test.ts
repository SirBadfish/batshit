import { describe, expect, it } from 'vitest'

import { GoonLiveActivationGate } from '$lib/goons/liveActivation'

describe('GoonLiveActivationGate', () => {
  it('accepts one successful activation per exact revision key', () => {
    const gate = new GoonLiveActivationGate()
    const first = gate.request('goon::revision-a')
    expect(first).not.toBeNull()
    expect(gate.request('goon::revision-a')).toBeNull()
    expect(gate.accept(first!)).toBe(true)
    expect(gate.isAccepted('goon::revision-a')).toBe(true)
    expect(gate.request('goon::revision-a')).toBeNull()
  })

  it('keeps a failed activation retryable without accepting it', () => {
    const gate = new GoonLiveActivationGate()
    const failed = gate.request('goon::revision-b')!
    expect(gate.fail(failed)).toBe(true)
    expect(gate.isAccepted(failed.key)).toBe(false)
    expect(gate.request(failed.key)).toBeNull()
    expect(gate.retry(failed.key)).toBe(true)
    expect(gate.request(failed.key)).not.toBeNull()
  })

  it('rejects a stale async winner after a newer revision supersedes it', () => {
    const gate = new GoonLiveActivationGate()
    const oldRevision = gate.request('goon::revision-old')!
    const newRevision = gate.request('goon::revision-new')!
    expect(gate.accept(oldRevision)).toBe(false)
    expect(gate.fail(oldRevision)).toBe(false)
    expect(gate.accept(newRevision)).toBe(true)
    expect(gate.isAccepted('goon::revision-new')).toBe(true)
  })
})
