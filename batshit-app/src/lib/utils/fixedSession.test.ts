import { describe, expect, it } from 'vitest'
import {
  buildFixedSessionMetadata,
  isFixedSession,
  resolveFixedSessionMetadataUpdate
} from './fixedSession'

describe('fixedSession (SA-104 P5)', () => {
  const fixedBlock = { version: 1, enabled: true, created_at: '2026-08-25T00:00:00.000Z' }

  describe('isFixedSession', () => {
    it('is true only for a metadata.fixedSession block with enabled: true', () => {
      expect(isFixedSession({ metadata: { fixedSession: fixedBlock } })).toBe(true)
      expect(isFixedSession({ metadata: {} })).toBe(false)
      expect(isFixedSession({ metadata: { fixedSession: { enabled: false } } })).toBe(false)
      expect(isFixedSession({})).toBe(false)
      expect(isFixedSession(null)).toBe(false)
      expect(isFixedSession('session')).toBe(false)
    })
  })

  describe('buildFixedSessionMetadata', () => {
    it('builds the versioned enabled block', () => {
      const block = buildFixedSessionMetadata(new Date('2026-08-25T12:00:00.000Z'))
      expect(block).toEqual({
        version: 1,
        enabled: true,
        created_at: '2026-08-25T12:00:00.000Z'
      })
    })
  })

  describe('resolveFixedSessionMetadataUpdate (one-way PUT guard)', () => {
    it('passes untouched when the update carries no metadata', () => {
      const result = resolveFixedSessionMetadataUpdate({ fixedSession: fixedBlock }, undefined)
      expect(result).toEqual({ ok: true, metadata: undefined })
    })

    it('rejects adding fixedSession through the generic path', () => {
      const result = resolveFixedSessionMetadataUpdate({}, { fixedSession: fixedBlock })
      expect(result.ok).toBe(false)
    })

    it('re-attaches the stored block when a stale writer omits it', () => {
      const result = resolveFixedSessionMetadataUpdate(
        { fixedSession: fixedBlock, other: 1 },
        { last_agent_id: 'agent_a' }
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.metadata).toEqual({ last_agent_id: 'agent_a', fixedSession: fixedBlock })
      }
    })

    it('rejects altering or removing the stored block', () => {
      const altered = resolveFixedSessionMetadataUpdate(
        { fixedSession: fixedBlock },
        { fixedSession: { ...fixedBlock, enabled: false } }
      )
      expect(altered.ok).toBe(false)
    })

    it('accepts an identical block passthrough', () => {
      const result = resolveFixedSessionMetadataUpdate(
        { fixedSession: fixedBlock },
        { fixedSession: { ...fixedBlock }, note: 'x' }
      )
      expect(result.ok).toBe(true)
    })

    it('rejects adding group_chat metadata to an Infinite Session (DL-104-12)', () => {
      const withGroup = resolveFixedSessionMetadataUpdate(
        { fixedSession: fixedBlock },
        { group_chat: { group_id: 'g1' } }
      )
      expect(withGroup.ok).toBe(false)

      const withGroupAndBlock = resolveFixedSessionMetadataUpdate(
        { fixedSession: fixedBlock },
        { fixedSession: { ...fixedBlock }, group_chat: { group_id: 'g1' } }
      )
      expect(withGroupAndBlock.ok).toBe(false)
    })

    it('leaves regular sessions completely alone', () => {
      const result = resolveFixedSessionMetadataUpdate(
        { contextCompaction: { version: 1 } },
        { group_chat: { group_id: 'g1' } }
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.metadata).toEqual({ group_chat: { group_id: 'g1' } })
      }
    })

    it('rejects non-object metadata', () => {
      expect(resolveFixedSessionMetadataUpdate({}, 'nope').ok).toBe(false)
      expect(resolveFixedSessionMetadataUpdate({}, [1]).ok).toBe(false)
    })
  })
})
