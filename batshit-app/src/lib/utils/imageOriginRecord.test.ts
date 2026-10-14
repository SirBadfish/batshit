import { describe, expect, it } from 'vitest'
import { decideImageAddressOrigin, type ImageAddressEvidence } from './imageAddressOrigin'
import { readImageOriginRecord, readImageOriginResponseRecord } from './imageOriginRecord'

const ADDRESS = 'https://images.example.org/picture.png'
const BOOLS = [false, true] as const

it('preserves a checked server projection even when the client table would choose a different outcome', () => {
  const record = storedRecord({ inRecord:true,startInRecord:false,sharesChatRun:false,complete:true })
  record.addresses[ADDRESS].state='blocked'
  record.addresses[ADDRESS].rule=4
  expect(readImageOriginRecord(record,'reply-1')?.state).toBe('decided')
  expect((readImageOriginRecord(record,'reply-1') as any).addresses[ADDRESS].state).toBe('as_read')
  expect((readImageOriginResponseRecord(record,'reply-1') as any).addresses[ADDRESS]).toEqual(record.addresses[ADDRESS])
})

it('rejects an unsupported or missing wire outcome rather than making a decision in the page', () => {
  for(const pair of [{state:'safe',rule:1},{state:'as_read',rule:6},{state:undefined,rule:undefined}]) {
    const record=storedRecord({inRecord:true,startInRecord:false,sharesChatRun:false,complete:true})
    Object.assign(record.addresses[ADDRESS],pair)
    expect(readImageOriginResponseRecord(record,'reply-1')).toBeNull()
  }
})

function evidenceCases(): ImageAddressEvidence[] {
  const cases: ImageAddressEvidence[] = []
  for (const inRecord of BOOLS) {
    for (const startInRecord of BOOLS) {
      for (const sharesChatRun of BOOLS) {
        for (const complete of BOOLS) {
          cases.push({ inRecord, startInRecord, sharesChatRun, complete })
        }
      }
    }
  }
  return cases
}

function storedRecord(evidence: ImageAddressEvidence) {
  const outcome = decideImageAddressOrigin(evidence)
  return {
    messageId: 'reply-1',
    version: 1,
    state: 'decided',
    textHashes: ['a'.repeat(64)],
    lane: 'api',
    complete: evidence.complete,
    addresses: { [ADDRESS]: { state: outcome.state, rule: outcome.rule, evidence } }
  }
}

describe('image-origin decision evidence records', () => {
  it('serializes and reads all 16 evidence combinations using the decision table', () => {
    for (const evidence of evidenceCases()) {
      const serialized = JSON.parse(JSON.stringify(storedRecord(evidence)))
      expect(readImageOriginRecord(serialized, 'reply-1')).toEqual(serialized)
    }
  })

  it('stores all measured evidence when rule 3 outranks an exact address match', () => {
    const evidence: ImageAddressEvidence = {
      inRecord: true,
      startInRecord: false,
      sharesChatRun: true,
      complete: false
    }
    expect(decideImageAddressOrigin(evidence)).toMatchObject({ state: 'unknown', rule: 3 })
    const serialized = JSON.parse(JSON.stringify(storedRecord(evidence)))
    expect(readImageOriginRecord(serialized, 'reply-1')).toEqual(serialized)
  })

  it('rejects evidence whose completeness disagrees with the record', () => {
    const malformed = storedRecord({
      inRecord: false,
      startInRecord: false,
      sharesChatRun: false,
      complete: true
    })
    malformed.complete = false
    expect(readImageOriginRecord(malformed, 'reply-1')).toBeNull()
  })

  it('derives every current state and rule from the four stored evidence values (BL-1023)', () => {
    for (const evidence of evidenceCases()) {
      const canonical = storedRecord(evidence)
      const olderTableRecord = {
        ...canonical,
        addresses: { [ADDRESS]: { state: 'an-old-table-state', rule: 99, evidence } }
      }
      expect(readImageOriginRecord(olderTableRecord, 'reply-1')).toEqual(canonical)
    }
  })

  it('does not require an old state or rule when the complete evidence is present (BL-1023)', () => {
    const evidence = { inRecord: true, startInRecord: true, sharesChatRun: true, complete: false }
    const canonical = storedRecord(evidence)
    expect(readImageOriginRecord({ ...canonical, addresses: { [ADDRESS]: { evidence } } }, 'reply-1'))
      .toEqual(canonical)
  })

  it.each(['inRecord', 'startInRecord', 'sharesChatRun', 'complete'] as const)('rejects a missing or non-boolean %s even with a plausible stored outcome', (field) => {
    const canonical = storedRecord({ inRecord: false, startInRecord: false, sharesChatRun: false, complete: true })
    const evidence: Record<string, unknown> = { ...canonical.addresses[ADDRESS].evidence }
    delete evidence[field]
    expect(readImageOriginRecord({ ...canonical, addresses: { [ADDRESS]: { ...canonical.addresses[ADDRESS], evidence } } }, 'reply-1'))
      .toBeNull()
    evidence[field] = 1
    expect(readImageOriginRecord({ ...canonical, addresses: { [ADDRESS]: { ...canonical.addresses[ADDRESS], evidence } } }, 'reply-1'))
      .toBeNull()
  })
})
