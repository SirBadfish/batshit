import { describe, expect, it } from 'vitest'
import { access } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { HostCommandRecordStore } from '../hostCommandRecords'
import { pinHostCommandOwner } from '../hostCommandOwnership'

const owner = { userId: `isolation-${randomUUID()}`, kind: 'host' as const, id: 'administration' }
let firstRoot: string
let firstResource: string

describe('isolated host-command record roots', () => {
  it('retains a deliberately unresolved fixture in this test root', async () => {
    firstRoot = process.env.BATSHIT_COMMAND_RECORDS_DIR!
    expect(firstRoot).toMatch(/batshit-command-records-test-/)
    const pin = pinHostCommandOwner(owner)
    firstResource = pin.resources[0]
    // This tests storage isolation, not OS process inspection (which is POSIX-only).
    pin.store.prepare({
      version: 1, runId: randomUUID(), kind: 'guardian', resources: pin.resources,
      bootId: 'fixture-boot', namespaceId: 'fixture', instanceId: 'fixture', lane: 'test',
      owner, profileId: null, sessionId: null, messageId: null,
      program: 'fixture', phase: 'prepared', processes: []
    }, pin.generations)
    expect(pin.store.records(pin.resources)).toHaveLength(1)
  })

  it('gives the next test a fresh root without the prior record', async () => {
    const currentRoot = process.env.BATSHIT_COMMAND_RECORDS_DIR!
    expect(currentRoot).not.toBe(firstRoot)
    const pin = pinHostCommandOwner(owner)
    expect(pin.store.records(pin.resources)).toEqual([])
    await expect(access(firstRoot)).resolves.toBeUndefined()
    const firstStore = new HostCommandRecordStore({ root: firstRoot })
    expect(firstStore.records([firstResource])).toHaveLength(1)
  })
})
