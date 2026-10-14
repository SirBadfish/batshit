import { afterEach, describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { APP_ACTIONS_VERSION } from './catalog'
import { createAppActionsDocument } from './document'
import { retireAppActionNavigation } from './owners'
import { registerSuppliedFileOwner } from './imports/registry'
import { emptyImportReceipt } from './imports/contracts'
import { suppliedFileIntent } from './fileProtocol'
import type { ActionContext } from './owners'
import type { ImportOutcome } from './imports/contracts'

const cleanup: Array<() => void> = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose() })
function request(id = 'file-request', expiresAt = Date.now() + 20_000) {
  return { requestId: id, catalogVersion: APP_ACTIONS_VERSION, documentId: 'document', documentEpoch: 'epoch',
    expectedSessionId: 'chat', actionId: 'avatar.import_file', args: { entityType: 'user', entityId: 'user' }, expiresAt }
}
function harness(execute?: (files: File[], context: ActionContext) => Promise<ImportOutcome>, crypto = webcrypto as unknown as Crypto, now?: () => number) {
  let effects = 0
  const seen: number[][] = []
  cleanup.push(registerSuppliedFileOwner('avatar.import_file', { available: () => 'available', execute: async (_args, files, context) => {
    context.effect(); effects++
    seen.push([...new Uint8Array(await files[0].arrayBuffer())])
    if (execute) return execute(files, context)
    return { status: 'completed', saved: 'saved', import: { ...emptyImportReceipt(), uploaded: 'confirmed', saved: 'confirmed', ids: ['created'] } }
  } }))
  const doc = createAppActionsDocument({ documentId: 'document', documentEpoch: 'epoch', session: () => 'chat',
    handler: () => undefined, feedback: () => {}, crypto, now })
  cleanup.push(() => doc.retire())
  return { doc, effects: () => effects, seen }
}
const supplied = () => [{ filename: 'avatar.png', mimeType: 'image/png', bytes: Uint8Array.of(1, 2, 3) }]

describe('Developer supplied bytes share exact document freshness and flight custody', () => {
  it('fingerprints large inputs in bounded chunks and detects bytes beyond the first chunk', async () => {
    const sizes: number[] = []
    const crypto = { subtle: { digest: (...args: Parameters<SubtleCrypto['digest']>) => {
      sizes.push(args[1].byteLength)
      return webcrypto.subtle.digest(...args)
    } } } as unknown as Crypto
    const bytes = new Uint8Array(4 * 1024 * 1024 + 3)
    const intent = request() as Parameters<typeof suppliedFileIntent>[0]
    bytes[bytes.length - 1] = 1
    const first = await suppliedFileIntent(intent,
      [new File([bytes], 'avatar.png')], crypto)
    bytes[bytes.length - 1] = 2
    const changed = await suppliedFileIntent(intent,
      [new File([bytes], 'avatar.png')], crypto)
    assert.notEqual(first, changed)
    assert.equal(Math.max(...sizes), 4 * 1024 * 1024)
    assert.deepEqual(sizes.slice(0, 2), [4 * 1024 * 1024, 3])
  })
  it('detaches mutable bytes before awaiting and deduplicates exact content without remote admission', async () => {
    const h = harness()
    const input = supplied(), intent = request()
    const first = h.doc.executeFile(intent, input)
    input[0].bytes[0] = 9
    const receipt = await first
    assert.equal(receipt.status, 'completed')
    assert.equal(receipt.import?.uploaded, 'confirmed')
    assert.equal(receipt.import?.saved, 'confirmed')
    assert.deepEqual(h.seen, [[1, 2, 3]])
    assert.deepEqual(await h.doc.executeFile(intent, supplied()), receipt)
    assert.equal((await h.doc.executeFile(intent, input)).reason, 'request_id_conflict')
    assert.equal(h.effects(), 1)
    assert.equal((await h.doc.execute(intent)).reason, 'unsupported_action')
  })
  it('holds admission during fingerprinting and refuses concurrent IDs rather than queuing them', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const crypto = { subtle: { digest: async (...args: Parameters<SubtleCrypto['digest']>) => { await gate; return webcrypto.subtle.digest(...args) } } } as unknown as Crypto
    const h = harness(undefined, crypto)
    const first = h.doc.executeFile(request(), supplied())
    assert.equal(h.doc.state().busy, true)
    assert.equal((await h.doc.executeFile(request('another'), supplied())).reason, 'busy')
    const view = { ...request('view'), actionId: 'goon.show', args: {} }
    assert.equal((await h.doc.execute(view)).reason, 'busy')
    release()
    assert.equal((await first).status, 'completed')
    assert.equal(h.effects(), 1)
  })
  it('never begins upload after navigation during asynchronous fingerprinting', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const crypto = { subtle: { digest: async (...args: Parameters<SubtleCrypto['digest']>) => { await gate; return webcrypto.subtle.digest(...args) } } } as unknown as Crypto
    const h = harness(undefined, crypto)
    const first = h.doc.executeFile(request(), supplied())
    retireAppActionNavigation()
    release()
    const result = await first
    assert.equal(result.status, 'blocked')
    assert.equal(result.reason, 'user_navigation')
    assert.equal(h.effects(), 0)
    assert.equal(h.doc.state().busy, false)
  })
  it('preserves uploaded facts and sole custody after an uncancellable upload is interrupted', async () => {
    let began!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const h = harness(async (_files, context) => {
      context.report({ status: 'unknown_outcome', saved: 'unknown', import: { ...emptyImportReceipt(), uploaded: 'confirmed', saved: 'unknown', ids: ['uploaded'] } })
      began()
      await gate // Faithful owner: its existing upload cannot be canceled by this signal.
      return { status: 'completed', saved: 'saved', import: { ...emptyImportReceipt(), uploaded: 'confirmed', saved: 'confirmed', ids: ['uploaded'] } }
    })
    const intent = request()
    const first = h.doc.executeFile(intent, supplied())
    await started
    const duplicate = h.doc.executeFile(intent, supplied())
    retireAppActionNavigation()
    const result = await first
    assert.equal(result.status, 'unknown_outcome')
    assert.equal(result.import?.uploaded, 'confirmed')
    assert.equal(result.import?.saved, 'unknown')
    assert.equal(h.doc.state().busy, true)
    assert.equal((await h.doc.executeFile(request('later'), supplied())).reason, 'busy')
    assert.deepEqual(await duplicate, result)
    release()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    assert.equal(h.doc.state().busy, false)
    assert.deepEqual(await h.doc.receipt(intent.requestId), result)
    assert.equal(h.effects(), 1)
  })
  it('rejects wrong session/document and finite deadline overflow before owner work', async () => {
    const h = harness()
    for (const intent of [{ ...request(), documentEpoch: 'other' }, { ...request(), expectedSessionId: 'other' }, request('too-long', Date.now() + 400_000)]) {
      const result = await h.doc.executeFile(intent, supplied())
      assert.equal(result.status, 'blocked')
    }
    assert.equal(h.effects(), 0)
  })
})
