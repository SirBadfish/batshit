import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MCPGateway } from '$lib/types/database'

import {
  asSentence,
  classifySaveFailure,
  clearOutcomeUnknown,
  failureConfirmsGatewaySaved,
  gatewayLockReason,
  gatewayReadFailure,
  isGatewayReadInFlight,
  isOutcomeUnknown,
  markOutcomeUnknown,
  nextGatewaySeq,
  requestGatewayRead,
  resetGatewaySaveStateForTest,
  savesOnTheirWay,
  settleSave,
  startSave,
  subscribeGatewaySaveEvents,
  type GatewaySaveEvent
} from './gatewaySaveState'

// BL-1393/BL-1394: the module-level save state every Gateway Settings card and the MCP Sources
// panel share. The read route is a small fake that can hold or fail its answer.

const GATEWAY: MCPGateway = {
  id: 'gw-a',
  name: 'Filesystem',
  type: 'stdio',
  enabled: true,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-11T15:00:05.000Z'
}

let reads: string[]
let answerRead: () => Response | Promise<Response>

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  resetGatewaySaveStateForTest()
  reads = []
  answerRead = () => json(200, { gateway: GATEWAY })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      reads.push(String(input))
      return answerRead()
    })
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function record() {
  const events: GatewaySaveEvent[] = []
  subscribeGatewaySaveEvents((event) => events.push(event))
  return events
}

describe('gatewaySaveState', () => {
  it('BL-1410: only exactly gatewaySaved true with this gateway\'s id proves the record was saved', () => {
    expect(failureConfirmsGatewaySaved({ gatewaySaved: true, gatewayId: 'gw-a' }, 'gw-a')).toBe(true)
    for (const body of [
      { gatewaySaved: 'true', gatewayId: 'gw-a' },
      { gatewaySaved: 1, gatewayId: 'gw-a' },
      { gatewaySaved: true, gatewayId: 'gw-b' },
      { gatewaySaved: true },
      { error: 'The gateway settings were saved, but …' },
      null,
      'gatewaySaved: true',
      []
    ]) {
      expect(failureConfirmsGatewaySaved(body, 'gw-a')).toBe(false)
    }
  })

  it('BL-1410: a message becomes one sentence: a period only when it does not end one already', () => {
    expect(asSentence('Failed to update gateway')).toBe('Failed to update gateway.')
    expect(asSentence('It was saved.  ')).toBe('It was saved.')
    expect(asSentence('Try again?')).toBe('Try again?')
    expect(asSentence('Wait…')).toBe('Wait…')
    expect(asSentence('(It was saved.)')).toBe('(It was saved.)')
    expect(asSentence('He said "saved."')).toBe('He said "saved."')
    expect(asSentence('see the logs (ENOSPC)')).toBe('see the logs (ENOSPC).')
  })

  it('only 409 and 401 prove a failed save stored nothing; anything else may have been stored', () => {
    expect(classifySaveFailure(409)).toBe('not-stored')
    expect(classifySaveFailure(401)).toBe('not-stored')
    for (const status of [500, 400, 404, 502, null]) {
      expect(classifySaveFailure(status)).toBe('unknown')
    }
  })

  it('counts saves per section and gateway, and tells every listener when one settles, even if one listener throws', () => {
    const events = record()
    subscribeGatewaySaveEvents(() => {
      throw new Error('a broken card')
    })
    const later = record()
    const from = {}
    startSave('settings', 'gw-a')
    startSave('settings', 'gw-a')
    startSave('grouping', 'gw-a')
    expect(savesOnTheirWay('settings', 'gw-a')).toBe(2)

    vi.spyOn(console, 'error').mockImplementation(() => {})
    settleSave('settings', 'gw-a', GATEWAY, from)

    expect(savesOnTheirWay('settings', 'gw-a')).toBe(1)
    expect(savesOnTheirWay('grouping', 'gw-a')).toBe(1)
    expect(events).toEqual([{ kind: 'save-settled', section: 'settings', gatewayId: 'gw-a', landed: GATEWAY, from }])
    expect(later).toEqual(events)
  })

  it('a read that succeeds clears the unknown outcome of both sections and says when it started', async () => {
    const events = record()
    markOutcomeUnknown('settings', 'gw-a')
    markOutcomeUnknown('grouping', 'gw-a')
    const before = nextGatewaySeq()

    await requestGatewayRead('user-1', 'gw-a')

    expect(reads).toEqual(['/api/mcp/gateways/gw-a?userId=user-1'])
    expect(isOutcomeUnknown('settings', 'gw-a')).toBe(false)
    expect(isOutcomeUnknown('grouping', 'gw-a')).toBe(false)
    expect(events).toHaveLength(1)
    const event = events[0] as Extract<GatewaySaveEvent, { kind: 'read' }>
    expect(event.kind).toBe('read')
    expect(event.gateway).toEqual(GATEWAY)
    expect(event.startedAt).toBeGreaterThan(before)
  })

  it('a second request while a read is on its way joins it', async () => {
    let release: (response: Response) => void = () => {}
    answerRead = () => new Promise((resolve) => (release = resolve))
    const events = record()

    const first = requestGatewayRead('user-1', 'gw-a')
    const second = requestGatewayRead('user-1', 'gw-a')
    expect(isGatewayReadInFlight('gw-a')).toBe(true)
    release(json(200, { gateway: GATEWAY }))
    await Promise.all([first, second])

    expect(reads).toHaveLength(1)
    expect(events.filter((event) => event.kind === 'read')).toHaveLength(1)
    expect(isGatewayReadInFlight('gw-a')).toBe(false)
  })

  it('a read that fails keeps the unknown outcome, keeps its message for a card mounted later, and never retries by itself', async () => {
    answerRead = () => json(500, { error: 'Failed to get gateway' })
    const events = record()
    markOutcomeUnknown('settings', 'gw-a')

    await requestGatewayRead(null, 'gw-a')
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(reads).toEqual(['/api/mcp/gateways/gw-a'])
    expect(isOutcomeUnknown('settings', 'gw-a')).toBe(true)
    expect(gatewayReadFailure('gw-a')).toBe('Failed to get gateway')
    expect(events).toEqual([{ kind: 'read-failed', gatewayId: 'gw-a', message: 'Failed to get gateway' }])

    // Retry asks again; its success clears the failure.
    answerRead = () => json(200, { gateway: GATEWAY })
    await requestGatewayRead(null, 'gw-a')
    expect(reads).toHaveLength(2)
    expect(gatewayReadFailure('gw-a')).toBeNull()
    expect(isOutcomeUnknown('settings', 'gw-a')).toBe(false)
  })

  it('a filled form is read-only while a save is on its way, then while an unknown outcome waits for its read, and says when that read failed', async () => {
    answerRead = () => json(500, { error: 'Failed to get gateway' })
    startSave('settings', 'gw-a')
    markOutcomeUnknown('settings', 'gw-a')
    expect(gatewayLockReason('settings', 'gw-a')).toBe('saving')
    expect(gatewayLockReason('grouping', 'gw-a')).toBeNull()

    settleSave('settings', 'gw-a', null, {})
    expect(gatewayLockReason('settings', 'gw-a')).toBe('reading')
    await requestGatewayRead(null, 'gw-a')
    expect(gatewayLockReason('settings', 'gw-a')).toBe('read-failed')

    answerRead = () => json(200, { gateway: GATEWAY })
    await requestGatewayRead(null, 'gw-a')
    expect(gatewayLockReason('settings', 'gw-a')).toBeNull()
  })

  it('a stored save sent after the unknown outcome clears only its section; one sent before clears nothing', () => {
    const sentBefore = startSave('settings', 'gw-a')
    markOutcomeUnknown('settings', 'gw-a')
    markOutcomeUnknown('grouping', 'gw-a')
    clearOutcomeUnknown('settings', 'gw-a', sentBefore)
    expect(isOutcomeUnknown('settings', 'gw-a')).toBe(true)

    clearOutcomeUnknown('settings', 'gw-a', startSave('settings', 'gw-a'))
    expect(isOutcomeUnknown('settings', 'gw-a')).toBe(false)
    expect(isOutcomeUnknown('grouping', 'gw-a')).toBe(true)
  })

  it('a read on its way that started before a newer unknown outcome is not joined, and its answer clears only what came before it', async () => {
    const held: Array<(response: Response) => void> = []
    answerRead = () => new Promise((resolve) => held.push(resolve))
    const events = record()
    markOutcomeUnknown('settings', 'gw-a')
    const first = requestGatewayRead('user-1', 'gw-a')
    // Another save of the gateway may have been stored after that read started.
    markOutcomeUnknown('grouping', 'gw-a')
    const second = requestGatewayRead('user-1', 'gw-a')
    expect(reads).toHaveLength(2)

    // The older read fails: the newer one decides, so nothing is recorded or said.
    held[0](json(500, { error: 'Failed to get gateway' }))
    await first
    expect(gatewayReadFailure('gw-a')).toBeNull()
    expect(isGatewayReadInFlight('gw-a')).toBe(true)
    expect(events).toEqual([])

    held[1](json(200, { gateway: GATEWAY }))
    await second
    expect(isOutcomeUnknown('settings', 'gw-a')).toBe(false)
    expect(isOutcomeUnknown('grouping', 'gw-a')).toBe(false)
    expect(isGatewayReadInFlight('gw-a')).toBe(false)
    expect(events.map((event) => event.kind)).toEqual(['read'])
  })

  it('an older read that succeeds while a newer one is on its way keeps the newer unknown outcome', async () => {
    const held: Array<(response: Response) => void> = []
    answerRead = () => new Promise((resolve) => held.push(resolve))
    markOutcomeUnknown('settings', 'gw-a')
    const first = requestGatewayRead('user-1', 'gw-a')
    markOutcomeUnknown('settings', 'gw-a')
    void requestGatewayRead('user-1', 'gw-a')

    held[0](json(200, { gateway: GATEWAY }))
    await first
    expect(isOutcomeUnknown('settings', 'gw-a')).toBe(true)
    expect(isGatewayReadInFlight('gw-a')).toBe(true)
    held[1](json(200, { gateway: GATEWAY }))
  })
})
