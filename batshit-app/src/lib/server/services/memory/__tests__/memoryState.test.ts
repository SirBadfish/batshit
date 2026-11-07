import { describe, expect, it } from 'vitest'
import { effectiveMemoryRecord, memoryIsEligible, standingMemoryTransition } from '../memoryState'
import type { MemoryRecord } from '../memoryTypes'

const now = Date.parse('2026-10-24T12:00:00Z')
const record = (lane: MemoryRecord['lane'], extra: Partial<MemoryRecord> = {}) => ({ lane, media_mode: 'always', expires_ts: now, ...extra }) as MemoryRecord

describe('memory visibility states', () => {
  it.each(['awareness', 'stm', 'ltm'] as const)('hides expired %s until deliberate lookup and presents it as LTM', lane => {
    const original = record(lane)
    expect(memoryIsEligible(original, false, now)).toBe(false)
    expect(memoryIsEligible(original, true, now)).toBe(true)
    expect(effectiveMemoryRecord(original, now)).toMatchObject({ lane: 'ltm', media_mode: 'on_recall' })
    expect(original.lane).toBe(lane)
  })
  it('never includes trash through an expired opt-in', () => {
    expect(memoryIsEligible(record('awareness', { deleted_ts: now - 1 }), true, now)).toBe(false)
  })
  it('keeps an unexpired state untouched before the precise expiry instant', () => {
    const original = record('awareness', { expires_ts: now + 1 })
    expect(memoryIsEligible(original, false, now)).toBe(true)
    expect(effectiveMemoryRecord(original, now)).toBe(original)
  })
})


describe('standing-media transition admission', () => {
  const standing = (id: string, deleted = false) => ({ id, lane: 'awareness', media_mode: 'always', is_superseded: 'n', ...(deleted ? { deleted_ts: now - 1 } : {}), media: [{ id: `photo_${id}`, filename: `agent/${id}/photo.png`, sha256: id }] }) as MemoryRecord
  const six = Array.from({ length: 6 }, (_, index) => standing(`mem_${index}`))
  it('permits a safe6→5 legacy repair and unrelated LTM edit without activation', () => {
    expect(standingMemoryTransition(six, [{ ...six[0], deleted_ts: now }, ...six.slice(1)], now)).toMatchObject({ oldCount: 6, postCount: 5, activation: false, allowed: true })
    expect(standingMemoryTransition(six, [...six, { id: 'long_term', lane: 'ltm', content: 'unrelated edit' } as MemoryRecord], now)).toMatchObject({ oldCount: 6, postCount: 6, allowed: true })
  })
  it('permits normal admission up to four and refuses over-cap growth', () => {
    expect(standingMemoryTransition(six.slice(0, 3), six.slice(0, 4), now).allowed).toBe(true)
    expect(standingMemoryTransition(six.slice(0, 4), six.slice(0, 5), now).allowed).toBe(false)
    expect(standingMemoryTransition(six, [...six, standing('new_photo')], now).allowed).toBe(false)
  })
  it('refuses over-cap restoration even when other removals make the net count smaller', () => {
    const trashed = standing('restore_me', true)
    const restored = { ...trashed }; delete restored.deleted_ts
    expect(standingMemoryTransition([...six, trashed], [...six.slice(2), restored], now)).toMatchObject({ oldCount: 6, postCount: 5, activation: true, allowed: false })
  })
})
