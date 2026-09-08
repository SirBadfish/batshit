import { describe, expect, it } from 'vitest'
import {
  buildSessionOrigin,
  buildWokenSessionName,
  describeSessionOrigin,
  isWokenSession,
  resolveSessionOrigin,
  resolveSessionOriginMetadataUpdate,
  stripClientSuppliedOrigin
} from '$lib/utils/sessionOrigin'
import { WAKE_SESSION_NAME_MAX_CHARS } from '$lib/utils/dmControl'

/**
 * SA-113 P1 (DL-113-08) — session origin. The two facts that matter beyond the shape:
 * the server owns it, and it survives a read-spread-write metadata update.
 */

describe('resolveSessionOrigin', () => {
  it('returns null for an ordinary user-started session', () => {
    expect(resolveSessionOrigin({ id: 's1' })).toBeNull()
    expect(resolveSessionOrigin({ id: 's1', metadata: {} })).toBeNull()
    expect(resolveSessionOrigin(null)).toBeNull()
    expect(isWokenSession({ id: 's1', metadata: { agent_id: 'a1' } })).toBe(false)
  })

  it('reads a DM origin', () => {
    const origin = resolveSessionOrigin({
      metadata: {
        origin: {
          version: 1,
          kind: 'dm',
          label: 'Cooper',
          agentId: 'agent-cooper',
          dmId: 'dm_9f3a',
          at: '2026-09-07T12:00:00.000Z',
          chainDepth: 1
        }
      }
    })
    expect(origin).toEqual({
      version: 1,
      kind: 'dm',
      label: 'Cooper',
      agentId: 'agent-cooper',
      dmId: 'dm_9f3a',
      at: '2026-09-07T12:00:00.000Z',
      chainDepth: 1
    })
  })

  it('reads a webhook origin and tolerates snake_case aliases', () => {
    const origin = resolveSessionOrigin({
      metadata: {
        origin: { kind: 'webhook', label: 'Nightly build', hook_id: 'hook_1', chain_depth: 0 }
      }
    })
    expect(origin?.kind).toBe('webhook')
    expect(origin?.hookId).toBe('hook_1')
    expect(origin?.chainDepth).toBe(0)
  })

  it('rejects an unknown kind rather than inventing one', () => {
    expect(resolveSessionOrigin({ metadata: { origin: { kind: 'telepathy' } } })).toBeNull()
    expect(resolveSessionOrigin({ metadata: { origin: [] } })).toBeNull()
    expect(resolveSessionOrigin({ metadata: { origin: 'dm' } })).toBeNull()
  })

  it('never returns a negative chain depth', () => {
    const origin = resolveSessionOrigin({
      metadata: { origin: { kind: 'dm', label: 'Cooper', chainDepth: -4 } }
    })
    expect(origin?.chainDepth).toBe(0)
  })
})

describe('describeSessionOrigin', () => {
  it('names the sender for a DM and the hook for a webhook', () => {
    expect(
      describeSessionOrigin(buildSessionOrigin({ kind: 'dm', label: 'Cooper', chainDepth: 1 }))
    ).toBe('Started by a DM from Cooper')
    expect(
      describeSessionOrigin(
        buildSessionOrigin({ kind: 'webhook', label: 'Nightly build', chainDepth: 0 })
      )
    ).toBe('Started by webhook "Nightly build"')
  })
})

describe('buildWokenSessionName (DL-113-08)', () => {
  it('names a DM session after its sender and subject', () => {
    expect(
      buildWokenSessionName({ kind: 'dm', label: 'Cooper', subject: 'Verify the package' })
    ).toBe('DM from Cooper: Verify the package')
  })

  it('drops the subject when there is not one', () => {
    expect(buildWokenSessionName({ kind: 'dm', label: 'Cooper', subject: '  ' })).toBe(
      'DM from Cooper'
    )
  })

  it('names a webhook session after the hook', () => {
    expect(buildWokenSessionName({ kind: 'webhook', label: 'Nightly build' })).toBe(
      'Webhook: Nightly build'
    )
  })

  it('trims to the cap with an ellipsis instead of running long in the sidebar', () => {
    const name = buildWokenSessionName({
      kind: 'dm',
      label: 'Cooper',
      subject: 'x'.repeat(200)
    })
    expect(name.length).toBe(WAKE_SESSION_NAME_MAX_CHARS)
    expect(name.endsWith('…')).toBe(true)
  })
})

describe('stripClientSuppliedOrigin (DL-113-08)', () => {
  it('removes a forged origin while keeping the rest of the metadata', () => {
    expect(
      stripClientSuppliedOrigin({ agent_id: 'a1', origin: { kind: 'dm', label: 'Nobody' } })
    ).toEqual({ agent_id: 'a1' })
  })

  it('passes ordinary metadata through untouched', () => {
    const metadata = { agent_id: 'a1', last_agent_id: 'a1' }
    expect(stripClientSuppliedOrigin(metadata)).toBe(metadata)
  })

  it('leaves a missing metadata object alone', () => {
    expect(stripClientSuppliedOrigin(undefined)).toBeUndefined()
  })
})

describe('resolveSessionOriginMetadataUpdate (DL-113-08)', () => {
  const stored = {
    agent_id: 'a1',
    origin: { version: 1, kind: 'dm', label: 'Cooper', at: 'x', chainDepth: 1 }
  }

  it('leaves updates alone when they carry no metadata at all', () => {
    expect(resolveSessionOriginMetadataUpdate(stored, undefined)).toEqual({
      ok: true,
      metadata: undefined
    })
  })

  it('rejects non-object metadata', () => {
    expect(resolveSessionOriginMetadataUpdate(stored, [1, 2]).ok).toBe(false)
    expect(resolveSessionOriginMetadataUpdate(stored, 'nope').ok).toBe(false)
  })

  it('RE-ATTACHES the stored origin when a read-spread-write payload omits it', () => {
    const result = resolveSessionOriginMetadataUpdate(stored, { agent_id: 'a2' })
    expect(result).toEqual({
      ok: true,
      metadata: { agent_id: 'a2', origin: stored.origin }
    })
  })

  it('accepts an identical origin unchanged', () => {
    const result = resolveSessionOriginMetadataUpdate(stored, {
      agent_id: 'a1',
      origin: stored.origin
    })
    expect(result.ok).toBe(true)
  })

  it('rejects changing or removing a stored origin', () => {
    const changed = resolveSessionOriginMetadataUpdate(stored, {
      origin: { version: 1, kind: 'webhook', label: 'Fake', at: 'x', chainDepth: 0 }
    })
    expect(changed.ok).toBe(false)
    const removed = resolveSessionOriginMetadataUpdate(stored, { origin: null })
    expect(removed.ok).toBe(false)
  })

  it('rejects a client adding an origin to a session that has none', () => {
    const result = resolveSessionOriginMetadataUpdate(
      { agent_id: 'a1' },
      { origin: { kind: 'dm', label: 'Nobody' } }
    )
    expect(result.ok).toBe(false)
  })

  it('passes ordinary metadata through for a session with no origin', () => {
    const result = resolveSessionOriginMetadataUpdate({ agent_id: 'a1' }, { agent_id: 'a2' })
    expect(result).toEqual({ ok: true, metadata: { agent_id: 'a2' } })
  })
})
