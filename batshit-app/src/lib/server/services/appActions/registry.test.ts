import { afterEach, describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { APP_ACTIONS_VERSION } from '../../../appActions/catalog'
import { actionProofBytes, canonicalActionJson, toActionBase64 } from '../../../appActions/protocol'
import type { AppActionCommand, AppActionLiveEvent } from '../../../appActions/protocol'
import type { ActionReceipt } from '../../../appActions/document'
import { createAppActionRegistry } from './registry'
import type { AppActionRegistry, DocumentAuth } from './registry'

const auth: DocumentAuth = { userId: 'owner', authenticationSession: 'cookie-session-private' }
const caller = { userId: auth.userId, scopeId: 'agent:primary:chat' }
const identity = { catalogVersion: APP_ACTIONS_VERSION, documentId: 'document', documentEpoch: 'epoch', expectedSessionId: 'chat' }
const intent = { requestId: 'request', actionId: 'goon.show' as const, args: {}, expectedSessionId: 'chat' }
const registries: AppActionRegistry[] = []
afterEach(() => { for (const registry of registries.splice(0)) registry.dispose() })
function harness(options: { now?: () => number; validAuthentication?: () => Promise<boolean>; processId?: string;
  publish?: (userId: string, event: AppActionLiveEvent) => Promise<void> } = {}) {
  const commands: AppActionCommand[] = []
  const registry = createAppActionRegistry({ publish: async (_user, command) => { if (command.type === 'app_action_requested') commands.push(command) }, validAuthentication: async () => true, ...options })
  registries.push(registry)
  return { registry, commands }
}
async function keys() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const exported = await webcrypto.subtle.exportKey('jwk', pair.publicKey)
  return { key: pair.privateKey, publicKey: { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y } }
}
async function signed(key: webcrypto.CryptoKey, domain: 'register' | 'renew' | 'receipt', payload: unknown) {
  return toActionBase64(new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, actionProofBytes(domain, payload))))
}
async function registered(registry: AppActionRegistry, doc = identity, who = auth) {
  const key = await keys()
  const challenge = await registry.beginRegistration(who, doc, key.publicKey)
  const binding = await registry.prove(who, challenge.challengeId, await signed(key.key, 'register', challenge))
  return { ...key, binding, challenge }
}
function completed(command: AppActionCommand): ActionReceipt {
  const request = command.request
  return { requestId: request.requestId, actionId: request.actionId, documentId: request.documentId,
    documentEpoch: request.documentEpoch, catalogVersion: request.catalogVersion,
    status: 'completed', visible: 'applied', saved: 'saved' }
}
async function answer(registry: AppActionRegistry, key: webcrypto.CryptoKey, command: AppActionCommand, receipt = completed(command), who = auth) {
  return registry.acceptReceipt(who, command, receipt, await signed(key, 'receipt', { command, receipt }))
}
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('admission did not retire while its dependency remained pending')), 100)
    })])
  } finally { clearTimeout(timer) }
}
function pausedDigest(requestId: string) {
  const subtle = webcrypto.subtle as unknown as SubtleCrypto
  const digest = subtle.digest.bind(subtle)
  let began!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { began = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  subtle.digest = async (...args: Parameters<SubtleCrypto['digest']>) => {
    if (new TextDecoder().decode(args[1]).includes(`"requestId":"${requestId}"`)) { began(); await gate }
    return digest(...args)
  }
  return { started, release: () => release(), restore: () => { release(); subtle.digest = digest } }
}

describe('App Actions exact-document key and nonce boundary (real Node WebCrypto)', () => {
  for (const late of ['answer', 'rejection']) it(`Stop bounds constructed-request authentication, observing a late ${late} without publication`, async () => {
    let began!: () => void, release!: () => void, fail!: (reason: Error) => void
    const started = new Promise<void>(resolve => { began = resolve })
    const gate = new Promise<void>((resolve, reject) => { release = resolve; fail = reject })
    const { registry, commands } = harness({ validAuthentication: async () => { began(); await gate; return true } })
    await registered(registry)
    const controller = new AbortController()
    const dispatch = registry.dispatch({ ...caller, signal: controller.signal }, { ...intent, requestId: `stopped-auth-${late}` })
    await started
    controller.abort()
    await assert.rejects(bounded(dispatch), /caller_stopped/)
    if (late === 'answer') release(); else fail(new Error('late authentication failure'))
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    assert.equal(commands.length, 0)
    assert.throws(() => registry.status(caller, `stopped-auth-${late}`), /request_not_found/)
  })
  it('deadline bounds constructed-request authentication and a late true answer cannot publish', async () => {
    let time = 1000, release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const { registry, commands } = harness({ now: () => time, validAuthentication: async () => { await gate; return true } })
    const document = await registered(registry)
    time = document.binding.expiresAt - 20
    await assert.rejects(bounded(registry.dispatch(caller, intent)), /expired_request/)
    time = document.binding.expiresAt
    release()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    assert.equal(commands.length, 0)
    assert.throws(() => registry.status(caller, intent.requestId), /request_not_found/)
  })
  for (const stop of [true, false]) it(`${stop ? 'Stop' : 'deadline'} bounds constructed-request hashing and late digest cannot publish`, async () => {
    let time = 1000
    const { registry, commands } = harness({ now: () => time })
    const document = await registered(registry)
    if (!stop) time = document.binding.expiresAt - 20
    const controller = new AbortController(), requestId = `retired-digest-${stop}`
    const digest = pausedDigest(requestId)
    try {
      const dispatch = registry.dispatch({ ...caller, signal: controller.signal }, { ...intent, requestId })
      await digest.started
      if (stop) controller.abort()
      await assert.rejects(bounded(dispatch), stop ? /caller_stopped/ : /expired_request/)
      if (!stop) time = document.binding.expiresAt
      digest.release()
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      assert.equal(commands.length, 0)
      assert.throws(() => registry.status(caller, requestId), /request_not_found/)
    } finally { digest.restore() }
  })
  it('canonicalizes key order, separates proof domains, and rejects ambiguous encodings', () => {
    assert.equal(canonicalActionJson({ b: 2, a: { y: true, x: null } }), canonicalActionJson({ a: { x: null, y: true }, b: 2 }))
    assert.notDeepEqual(actionProofBytes('register', {}), actionProofBytes('receipt', {}))
    assert.throws(() => canonicalActionJson({ bad: undefined }), /invalid_payload/)
    assert.throws(() => canonicalActionJson({ bad: Number.NaN }), /invalid_payload/)
    assert.throws(() => canonicalActionJson({ large: 'x'.repeat(20_000) }), /payload_too_large/)
  })
  it('requires challenged possession; own sibling key and another domain do not register', async () => {
    const { registry } = harness()
    const first = await keys(), sibling = await keys()
    const challenge = await registry.beginRegistration(auth, identity, first.publicKey)
    await assert.rejects(registry.prove(auth, challenge.challengeId, await signed(sibling.key, 'register', challenge)), /invalid_signature/)
    await assert.rejects(registry.prove(auth, challenge.challengeId, await signed(first.key, 'receipt', challenge)), /invalid_signature/)
    assert.equal(registry.listDocuments(auth.userId).length, 0)
    const good = await signed(first.key, 'register', challenge)
    const concurrent = await Promise.allSettled([registry.prove(auth, challenge.challengeId, good), registry.prove(auth, challenge.challengeId, good)])
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(registry.listDocuments(auth.userId).length, 1)
  })
  it('does not accept a private JWK, claimed registration ID, extra identity or foreign user/session', async () => {
    const { registry } = harness()
    const key = await keys()
    await assert.rejects(registry.beginRegistration(auth, identity, { ...key.publicKey, d: 'secret' }), /invalid_public_key/)
    await assert.rejects(registry.beginRegistration(auth, { ...identity, registrationId: 'captured' }, key.publicKey), /invalid_request/)
    const challenge = await registry.beginRegistration(auth, identity, key.publicKey)
    const signature = await signed(key.key, 'register', challenge)
    await assert.rejects(registry.prove({ ...auth, userId: 'other' }, challenge.challengeId, signature), /stale_challenge/)
    await assert.rejects(registry.prove({ ...auth, authenticationSession: 'another-cookie' }, challenge.challengeId, signature), /stale_challenge/)
    assert.equal(registry.listDocuments(auth.userId).length, 0)
  })
  it('requires same-key renewal, consumes the renewal nonce, and rejects an older competing renewal', async () => {
    const { registry } = harness()
    const document = await registered(registry), sibling = await keys()
    const change = { ...identity, expectedSessionId: 'next-chat' }
    const challenge = registry.beginRenewal(auth, document.binding.registrationId, change)
    const older = registry.beginRenewal(auth, document.binding.registrationId, identity)
    await assert.rejects(registry.prove(auth, challenge.challengeId, await signed(sibling.key, 'renew', challenge)), /invalid_signature/)
    const signature = await signed(document.key, 'renew', challenge)
    const renewed = await registry.prove(auth, challenge.challengeId, signature)
    assert.equal(renewed.registrationId, document.binding.registrationId)
    assert.equal(renewed.expectedSessionId, 'next-chat')
    await assert.rejects(registry.prove(auth, challenge.challengeId, signature), /stale_challenge/)
    await assert.rejects(registry.prove(auth, older.challengeId, await signed(document.key, 'renew', older)), /stale_registration/)
  })
  it('rejects expired registration challenges without creating a document', async () => {
    let time = 1000
    const { registry } = harness({ now: () => time })
    const key = await keys()
    const challenge = await registry.beginRegistration(auth, identity, key.publicKey)
    time = challenge.challengeExpiresAt
    await assert.rejects(registry.prove(auth, challenge.challengeId, await signed(key.key, 'register', challenge)), /stale_challenge/)
    assert.equal(registry.listDocuments(auth.userId).length, 0)
  })
  it('lets the same document hold a NEW registration after its lease ends while the old ID stays refused (BL-1273)', async () => {
    let time = 1000
    const { registry } = harness({ now: () => time })
    const first = await registered(registry)
    time = first.binding.expiresAt
    assert.throws(() => registry.beginRenewal(auth, first.binding.registrationId, identity), /stale_registration/)
    const second = await registered(registry)
    assert.notEqual(second.binding.registrationId, first.binding.registrationId)
    assert.notEqual(second.binding.registrationEpoch, first.binding.registrationEpoch)
    assert.deepEqual(registry.listDocuments(auth.userId).map(binding => binding.registrationId), [second.binding.registrationId])
    await assert.rejects(registry.dispatch(caller, { ...intent, requestId: 'old-target', targetDocumentId: first.binding.registrationId }),
      /stale_or_wrong_document/)
  })
  it('cannot revive a lease that expires during asynchronous renewal verification', async () => {
    let time = 1000
    const { registry } = harness({ now: () => time })
    const document = await registered(registry)
    time = document.binding.expiresAt - 1
    const challenge = registry.beginRenewal(auth, document.binding.registrationId, identity)
    const signature = await signed(document.key, 'renew', challenge)
    const proof = registry.prove(auth, challenge.challengeId, signature)
    time = document.binding.expiresAt
    await assert.rejects(proof, /stale_registration/)
    assert.equal(registry.listDocuments(auth.userId).length, 0)
  })
  it('selects only the exact session/document, and never picks between sibling tabs', async () => {
    const { registry, commands } = harness()
    await assert.rejects(registry.dispatch(caller, intent), /no_tab/)
    const first = await registered(registry)
    await registered(registry, { ...identity, documentId: 'sibling', documentEpoch: 'sibling-epoch' })
    await assert.rejects(registry.dispatch(caller, intent), /ambiguous_target/)
    await assert.rejects(registry.dispatch(caller, { ...intent, targetDocumentId: first.binding.registrationId, expectedSessionId: 'other-chat' }), /stale_or_wrong_document/)
    assert.equal(commands.length, 0)
    const dispatched = await registry.dispatch(caller, { ...intent, targetDocumentId: first.binding.registrationId })
    assert.equal(commands.length, 1)
    await answer(registry, first.key, commands[0])
    assert.equal((await dispatched.result).verified, true)
  })
  it('rechecks uniqueness after a digest while preserving explicit targeting of the same tab', async () => {
    const { registry, commands } = harness()
    const first = await registered(registry)
    const subtle = webcrypto.subtle as unknown as SubtleCrypto
    const digest = subtle.digest.bind(subtle)
    let began!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    subtle.digest = async (...args: Parameters<SubtleCrypto['digest']>) => {
      if (new TextDecoder().decode(args[1]).includes('"requestId":"racing-tab"')) { began(); await gate }
      return digest(...args)
    }
    try {
      const dispatched = registry.dispatch(caller, { ...intent, requestId: 'racing-tab' })
      await started
      await registered(registry, { ...identity, documentId: 'late-tab', documentEpoch: 'late-epoch' })
      release()
      await assert.rejects(dispatched, /ambiguous_target/)
      assert.equal(commands.length, 0)
      const explicit = await registry.dispatch(caller, { ...intent, targetDocumentId: first.binding.registrationId })
      assert.equal(commands.length, 1)
      assert.equal(commands[0].registrationId, first.binding.registrationId)
      await answer(registry, first.key, commands[0])
      assert.equal((await explicit.result).verified, true)
    } finally { release(); subtle.digest = digest }
  })
  it('observes a late publication rejection without changing the retained timeout or publishing again', async () => {
    let time = 1000, reject!: (reason: Error) => void, publications = 0
    const publisher = new Promise<void>((_resolve, failed) => { reject = failed })
    const { registry } = harness({ now: () => time, publish: () => { publications++; return publisher } })
    const document = await registered(registry)
    time = document.binding.expiresAt - 20
    const dispatched = await registry.dispatch(caller, intent)
    const result = await dispatched.result
    assert.equal(result.receipt.reason, 'receipt_timeout')
    assert.equal(result.verified, false)
    reject(new Error('underlying publisher rejected after receipt deadline'))
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    const repeated = await registry.dispatch(caller, intent)
    assert.deepEqual(await repeated.result, result)
    assert.equal(publications, 1)
  })
  it('rejects a sibling receipt despite shared cookies and captured target IDs/nonces', async () => {
    const { registry, commands } = harness()
    const target = await registered(registry), sibling = await keys()
    const dispatched = await registry.dispatch(caller, intent)
    await assert.rejects(answer(registry, sibling.key, commands[0]), /invalid_signature/)
    assert.equal(registry.status(caller, intent.requestId).status, 'pending')
    await answer(registry, target.key, commands[0])
    assert.equal((await dispatched.result).receipt.status, 'completed')
    assert.equal((await dispatched.result).verified, true)
    await assert.rejects(answer(registry, target.key, commands[0]), /receipt_replayed_or_unknown/)
  })
  it('binds the command/hash/status/postconditions to the signature and pending record', async () => {
    const { registry, commands } = harness()
    const target = await registered(registry)
    const dispatched = await registry.dispatch(caller, intent)
    const command = commands[0], receipt = completed(command)
    const signature = await signed(target.key, 'receipt', { command, receipt })
    await assert.rejects(registry.acceptReceipt(auth, command, { ...receipt, saved: 'failed' }, signature), /invalid_signature/)
    const changed = { ...command, request: { ...command.request, actionId: 'goon.hide' as const } }
    await assert.rejects(answer(registry, target.key, changed), /receipt_mismatch/)
    await assert.rejects(answer(registry, target.key, command, { ...receipt, documentEpoch: 'wrong' }), /receipt_mismatch/)
    await assert.rejects(answer(registry, target.key, command, { ...receipt, viewer: 'records' }), /invalid_receipt/)
    await assert.rejects(answer(registry, target.key, command, { ...receipt, import: { uploaded: 'confirmed', staged: 'confirmed', saved: 'confirmed', ready: 'confirmed', ids: ['foreign-file'] } }), /invalid_request/)
    await answer(registry, target.key, command)
    assert.equal((await dispatched.result).verified, true)
  })
  it('atomically consumes a receipt nonce across two valid concurrent proofs', async () => {
    const { registry, commands } = harness()
    const target = await registered(registry)
    const dispatched = await registry.dispatch(caller, intent)
    const proof = await Promise.allSettled([answer(registry, target.key, commands[0]), answer(registry, target.key, commands[0])])
    assert.equal(proof.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal((await dispatched.result).verified, true)
  })
  it('deduplicates parallel requests and refuses changed payloads without a second event', async () => {
    const { registry, commands } = harness()
    const target = await registered(registry)
    const [first, second] = await Promise.all([registry.dispatch(caller, intent), registry.dispatch(caller, intent)])
    assert.equal(commands.length, 1)
    await assert.rejects(registry.dispatch(caller, { ...intent, actionId: 'goon.hide' }), /request_id_conflict/)
    await answer(registry, target.key, commands[0])
    assert.deepEqual(await first.result, await second.result)
    assert.equal(registry.status(caller, intent.requestId).verified, true)
    assert.throws(() => registry.status({ ...caller, userId: 'foreign' }, intent.requestId), /request_not_found/)
  })
  it('does not widen the admitted five actions or accept extra effectful arguments', async () => {
    const { registry, commands } = harness()
    await registered(registry)
    await assert.rejects(registry.dispatch(caller, { ...intent, actionId: 'settings.change' as any }), /unsupported_action/)
    await assert.rejects(registry.dispatch(caller, { ...intent, args: { desktop: false } }), /invalid_arguments/)
    await assert.rejects(registry.dispatch(caller, { ...intent, actionId: 'settings.open', args: { tab: 'admin', delete: true } }), /invalid_arguments/)
    assert.equal(commands.length, 0)
  })
  it('refuses retired login sessions before publishing', async () => {
    const { registry, commands } = harness({ validAuthentication: async () => false })
    await registered(registry)
    await assert.rejects(registry.dispatch(caller, intent), /retired_authentication/)
    assert.equal(commands.length, 0)
  })
  it('rejects expired receipts and retains a terminal unknown result after the document lease ends', async () => {
    let time = 1000
    const { registry, commands } = harness({ now: () => time })
    const target = await registered(registry)
    time = target.binding.expiresAt - 20
    const dispatched = await registry.dispatch(caller, intent)
    time = commands[0].request.expiresAt
    await assert.rejects(answer(registry, target.key, commands[0]), /stale_registration/)
    assert.equal((await dispatched.result).receipt.status, 'unknown_outcome')
    assert.equal((await dispatched.result).verified, false)
    assert.equal(registry.listDocuments(auth.userId).length, 0)
    const repeated = await registry.dispatch(caller, intent)
    assert.equal((await repeated.result).receipt.status, 'unknown_outcome')
    assert.equal(commands.length, 1)
  })
  it('boot-binds receipt acceptance and never replays an old process command', async () => {
    const first = harness({ processId: 'boot-one' }), second = harness({ processId: 'boot-two' })
    const target = await registered(first.registry)
    await first.registry.dispatch(caller, intent)
    await assert.rejects(answer(second.registry, target.key, first.commands[0]), /wrong_process/)
    assert.equal(second.commands.length, 0)
  })
  it('rejects request expiry independently while the document lease is still current', async () => {
    let time = 1000
    const { registry, commands } = harness({ now: () => time })
    const target = await registered(registry)
    const dispatched = await registry.dispatch(caller, intent)
    time = commands[0].request.expiresAt
    assert.ok(time < target.binding.expiresAt)
    await assert.rejects(answer(registry, target.key, commands[0]), /expired_request/)
    assert.equal(registry.status(caller, intent.requestId).status, 'pending')
    registry.dispose()
    assert.equal((await dispatched.result).receipt.status, 'unknown_outcome')
  })
  it('rejects Stop during asynchronous authentication before publishing any command', async () => {
    const controller = new AbortController()
    const { registry, commands } = harness({ validAuthentication: async () => { controller.abort(); return true } })
    await registered(registry)
    await assert.rejects(registry.dispatch({ ...caller, signal: controller.signal }, intent), /caller_stopped/)
    assert.equal(commands.length, 0)
  })
})
