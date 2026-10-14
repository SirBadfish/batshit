import { describe, expect, it } from 'vitest'
import type { UnzippedItem } from '$lib/services/zipping'
import {
  HELD_BY_ANOTHER_AGENT_HINT,
  HELD_BY_USER_HINT,
  HELD_BY_YOU_HINT,
  describeHeldReadHint,
  describeHoldForUser,
  describeUnzippedItemForDcm,
  heldByUserForMessagesHint,
  isAgentHold,
  isUserHold
} from './zipHoldWords'

// SA-129 P2 (DL-02, DL-03, D1): one vocabulary for a hold, on both sides.

const base = { sessionId: 's', unzippedAt: 1 }
const agentHold: UnzippedItem = { ...base, zipId: 'zip_a', permanent: true, source: 'agent', path: 'src/app.ts', agentId: 'agent-1', description: 'read_file: src/app.ts - 3 lines' }
const userHold: UnzippedItem = { ...base, zipId: 'zip_u', permanent: true, source: 'user', description: 'read_file: docs/spec.md - 9 lines' }
const userTimed: UnzippedItem = { ...base, zipId: 'zip_t', permanent: false, duration: 10, messageCount: 3, source: 'user', description: 'bash: npm test - 40 lines' }
const inferred: UnzippedItem = { ...base, zipId: 'zip_i', permanent: false, duration: 2, messageCount: 1, source: 'inferred', description: 'web_search: x' }
const legacyAgent: UnzippedItem = { ...base, zipId: 'zip_l', permanent: true, source: 'agent', description: 'bash: ls' }

describe('the steady line on a held read (DL-03)', () => {
  it('says who holds it, never how long is left', () => {
    expect(describeHeldReadHint(agentHold, 'agent-1')).toBe('Held by you: stays open until you release it.')
    expect(describeHeldReadHint(agentHold, 'agent-2')).toBe(HELD_BY_ANOTHER_AGENT_HINT)
    expect(describeHeldReadHint(userHold, 'agent-1')).toBe('Held by the user: stays open until they release it.')
    expect(describeHeldReadHint(userTimed, 'agent-1')).toBe('Held by the user for 10 messages.')
    expect(heldByUserForMessagesHint(1)).toBe('Held by the user for 1 message.')
  })

  it('is the same line whatever the count, so a history line never changes while the hold lasts', () => {
    expect(describeHeldReadHint({ ...userTimed, messageCount: 0 }, 'a')).toBe(describeHeldReadHint({ ...userTimed, messageCount: 9 }, 'a'))
  })

  it('gives no line to a Judge Juice open or a parked zip-control unzip (not holds)', () => {
    expect(describeHeldReadHint(inferred, 'agent-1')).toBeNull()
    expect(describeHeldReadHint(legacyAgent, 'agent-1')).toBeNull()
    expect(describeHeldReadHint(undefined, 'agent-1')).toBeNull()
  })

  it('stays about twelve tokens or fewer', () => {
    for (const line of [HELD_BY_YOU_HINT, HELD_BY_USER_HINT, HELD_BY_ANOTHER_AGENT_HINT, heldByUserForMessagesHint(10)]) {
      expect(Math.ceil(line.length / 4)).toBeLessThanOrEqual(14)
    }
  })
})

describe('Current Zip State (the DCM)', () => {
  it('names the path and the holder for an agent hold, and whether the held copy was compressed as dead', () => {
    expect(describeUnzippedItemForDcm(agentHold, { agentId: 'agent-1' })).toBe(
      '- src/app.ts | zip_a | held by you | until you release it'
    )
    expect(describeUnzippedItemForDcm(agentHold, { agentId: 'agent-1', deadCopy: 'stale' })).toBe(
      '- src/app.ts | zip_a | held by you | until you release it | compressed (stale, edited since); the hold moves to your next whole read'
    )
    expect(describeUnzippedItemForDcm(agentHold, { agentId: 'agent-2' })).toBe(
      '- src/app.ts | zip_a | held by another agent | until it is released'
    )
  })

  it('shows a skill hold as <skill id>/<path>', () => {
    expect(
      describeUnzippedItemForDcm({ ...agentHold, path: 'skill:skill_creator:SKILL.md' }, { agentId: 'agent-1' })
    ).toBe('- skill_creator/SKILL.md | zip_a | held by you | until you release it')
  })

  it('carries the live count of a user\'s "Hold for N messages" (the DCM is cache-free)', () => {
    expect(describeUnzippedItemForDcm(userHold, { agentId: 'agent-1' })).toBe(
      '- read_file: docs/spec.md - 9 lines | zip_u | held by the user | until they release it'
    )
    expect(describeUnzippedItemForDcm(userTimed, { agentId: 'agent-1' })).toBe(
      '- bash: npm test - 40 lines | zip_t | held by the user | for 10 messages, 7 left'
    )
  })

  it('keeps the Judge Juice and parked zip-control words', () => {
    expect(describeUnzippedItemForDcm(inferred, { agentId: 'a' })).toBe('- web_search: x | zip_i | batshit-inferred | temp 1/2')
    expect(describeUnzippedItemForDcm(legacyAgent, { agentId: 'a' })).toBe('- bash: ls | zip_l | agent zip control | permanent')
  })

  it('tells every stored Hold source when the size guard keeps its content compressed', () => {
    for (const item of [agentHold, userHold, userTimed, inferred, legacyAgent]) {
      expect(describeUnzippedItemForDcm(item, { agentId: 'agent-1', sizeGuard: 'too_large' }))
        .toContain('| compressed (too large to open: fetch it in parts)')
    }
  })
})

describe('the user\'s words (badge and Zip Manager)', () => {
  it('reads Held by you, Held by you (N messages left), Held by <agent>', () => {
    expect(describeHoldForUser(userHold, null)).toBe('Held by you')
    expect(describeHoldForUser(userTimed, null)).toBe('Held by you (7 messages left)')
    expect(describeHoldForUser({ ...userTimed, messageCount: 9 }, null)).toBe('Held by you (1 message left)')
    expect(describeHoldForUser(agentHold, 'Opie')).toBe('Held by Opie')
    expect(describeHoldForUser(agentHold, null)).toBe('Held by the agent')
    expect(describeHoldForUser(inferred, null)).toBeNull()
    expect(describeHoldForUser(null, null)).toBeNull()
  })

  it('reads a record with no source as the user\'s (it predates sources)', () => {
    expect(isUserHold({ source: undefined })).toBe(true)
    expect(isUserHold({ source: 'agent' })).toBe(false)
    expect(isAgentHold(legacyAgent)).toBe(false)
    expect(isAgentHold(agentHold)).toBe(true)
  })
})
