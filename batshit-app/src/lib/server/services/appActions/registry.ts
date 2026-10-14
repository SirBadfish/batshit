import { randomUUID, webcrypto } from 'node:crypto'
import { APP_ACTIONS_VERSION, AppActionRefusal, parseActionRequest, refuse } from '../../../appActions/catalog'
import type { ActionId } from '../../../appActions/catalog'
import type { ActionReceipt } from '../../../appActions/document'
import {
  APP_ACTION_DEADLINE_MS, APP_ACTION_LEASE_MS, APP_ACTION_TRANSPORT_VERSION,
  actionProofBytes, actionTransportId, canonicalActionJson, fromActionBase64,
  parseAppActionCommand, parseAppActionReceipt, parseDocumentIdentity, toActionBase64
} from '../../../appActions/protocol'
import type { AppActionCommand, AppActionLiveEvent, DocumentChallenge, Registration } from '../../../appActions/protocol'

export type DocumentAuth = { userId: string; authenticationSession: string }
type Binding = Registration & DocumentAuth & { key: webcrypto.CryptoKey; keyFingerprint: string; revision: number }
type ChallengeEntry = { payload: DocumentChallenge; binding: Binding; baseRevision?: number }
type Pending = {
  userId: string
  scopeId: string
  intent: string
  command: AppActionCommand
  binding: Binding
  receipt: ActionReceipt | null
  verified: boolean
  promise: Promise<ActionReceipt>
  finish(receipt: ActionReceipt, verified: boolean): void
  timer: ReturnType<typeof setTimeout>
  releaseAbort(): void
}
export type AppActionIntent = {
  requestId: string
  actionId: ActionId
  args: unknown
  expectedSessionId: string | null
  targetDocumentId?: string
}
export type AppActionCallerContext = { userId: string; scopeId: string; signal?: AbortSignal }
export type AppActionResult = { receipt: ActionReceipt; verified: boolean; targetDocumentId: string }

/** One adapter-node process, ephemeral state only. Restart retires every binding and nonce. */
export function createAppActionRegistry(ports: {
  publish(userId: string, event: AppActionLiveEvent): Promise<void>
  validAuthentication(auth: DocumentAuth): Promise<boolean>
  now?: () => number
  processId?: string
}) {
  const now = ports.now ?? Date.now
  const processId = ports.processId ?? randomUUID()
  const bindings = new Map<string, Binding>()
  const challenges = new Map<string, ChallengeEntry>()
  const pending = new Map<string, Pending>()
  function prune() {
    for (const [id, challenge] of challenges) if (challenge.payload.challengeExpiresAt <= now()) challenges.delete(id)
    // Retiring a lease does not retire request IDs: a timeout must remain deduplicated.
    for (const [id, binding] of bindings) if (binding.expiresAt <= now()) {
      bindings.delete(id)
    }
  }
  function owned(auth: DocumentAuth, registrationId: string): Binding {
    prune()
    const binding = bindings.get(registrationId)
    if (!binding || binding.userId !== auth.userId || binding.authenticationSession !== auth.authenticationSession) refuse('stale_registration')
    return binding
  }
  function publicBinding(binding: Binding): Registration {
    const { registrationId, registrationEpoch, processId, documentId, documentEpoch, catalogVersion, expectedSessionId, expiresAt } = binding
    return { registrationId, registrationEpoch, processId, documentId, documentEpoch, catalogVersion, expectedSessionId, expiresAt }
  }
  function challenge(kind: DocumentChallenge['kind'], binding: Binding, baseRevision?: number): DocumentChallenge {
    prune()
    if (challenges.size >= 256) refuse('registration_capacity')
    const payload: DocumentChallenge = { ...publicBinding(binding), kind,
      challengeId: randomUUID(), nonce: randomUUID(), challengeExpiresAt: now() + APP_ACTION_DEADLINE_MS,
      keyFingerprint: binding.keyFingerprint }
    challenges.set(payload.challengeId, { payload, binding, baseRevision })
    return payload
  }
  async function verify(key: webcrypto.CryptoKey, domain: 'register' | 'renew' | 'receipt', payload: unknown, signature: unknown) {
    const verified = await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key,
      fromActionBase64(signature, 64), actionProofBytes(domain, payload))
    if (!verified) refuse('invalid_signature')
  }
  async function beginRegistration(auth: DocumentAuth, identityValue: unknown, keyValue: unknown) {
    prune()
    const identity = parseDocumentIdentity(identityValue)
    if (bindings.size >= 256 || [...bindings.values()].filter(b => b.userId === auth.userId).length >= 16) refuse('registration_capacity')
    if (!keyValue || typeof keyValue !== 'object' || Array.isArray(keyValue)) refuse('invalid_public_key')
    const jwk = keyValue as Record<string, unknown>
    if (Object.keys(jwk).some(key => !['kty', 'crv', 'x', 'y'].includes(key)) || jwk.kty !== 'EC' || jwk.crv !== 'P-256') refuse('invalid_public_key')
    fromActionBase64(jwk.x, 32); fromActionBase64(jwk.y, 32)
    const key = await webcrypto.subtle.importKey('jwk', jwk as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const keyFingerprint = toActionBase64(new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalActionJson(jwk)))))
    const binding: Binding = { ...identity, ...auth, key, keyFingerprint,
      registrationId: randomUUID(), registrationEpoch: randomUUID(), processId, expiresAt: now() + APP_ACTION_LEASE_MS, revision: 0 }
    return challenge('register', binding)
  }
  function beginRenewal(auth: DocumentAuth, registrationId: string, identityValue: unknown): DocumentChallenge {
    const binding = owned(auth, registrationId)
    const identity = parseDocumentIdentity(identityValue)
    if (identity.documentId !== binding.documentId || identity.documentEpoch !== binding.documentEpoch) refuse('stale_document')
    // Only selected-session state changes. The binding and its private-key identity stay put.
    const next = { ...binding, ...identity, expiresAt: now() + APP_ACTION_LEASE_MS }
    return challenge('renew', next, binding.revision)
  }
  async function prove(auth: DocumentAuth, challengeId: string, signature: unknown): Promise<Registration> {
    prune()
    const entry = challenges.get(challengeId)
    if (!entry || entry.binding.userId !== auth.userId || entry.binding.authenticationSession !== auth.authenticationSession) refuse('stale_challenge')
    const original = entry.payload.kind === 'renew' ? owned(auth, entry.binding.registrationId) : null
    await verify(entry.binding.key, entry.payload.kind, entry.payload, signature)
    // Verification is async: two valid proofs racing still consume this nonce only once.
    if (challenges.get(challengeId) !== entry || entry.payload.challengeExpiresAt <= now()) refuse('stale_challenge')
    if (original && (original.expiresAt <= now() || bindings.get(original.registrationId) !== original || original.revision !== entry.baseRevision)) refuse('stale_registration')
    if (!original && (bindings.size >= 256 || [...bindings.values()].filter(b => b.userId === auth.userId).length >= 16)) refuse('registration_capacity')
    challenges.delete(challengeId)
    if (original) {
      original.expectedSessionId = entry.binding.expectedSessionId
      original.expiresAt = entry.binding.expiresAt
      original.revision++
      return publicBinding(original)
    }
    bindings.set(entry.binding.registrationId, entry.binding)
    return publicBinding(entry.binding)
  }
  function listDocuments(userId: string, expectedSessionId?: string | null) {
    prune()
    return [...bindings.values()].filter(binding => binding.userId === userId &&
      (expectedSessionId === undefined || binding.expectedSessionId === expectedSessionId)).map(publicBinding)
  }
  function select(caller: AppActionCallerContext, intent: AppActionIntent): Binding {
    prune()
    const candidates = [...bindings.values()].filter(binding => binding.userId === caller.userId &&
      binding.expectedSessionId === intent.expectedSessionId && (!intent.targetDocumentId || binding.registrationId === intent.targetDocumentId))
    if (!candidates.length) refuse(intent.targetDocumentId ? 'stale_or_wrong_document' : 'no_tab')
    if (candidates.length !== 1) refuse('ambiguous_target')
    return candidates[0]
  }
  function requestKey(caller: AppActionCallerContext, requestId: string) {
    return canonicalActionJson([caller.userId, caller.scopeId, requestId])
  }
  function status(caller: AppActionCallerContext, requestId: string) {
    prune()
    const entry = pending.get(requestKey(caller, actionTransportId(requestId)))
    if (!entry) refuse('request_not_found')
    return { requestId, targetDocumentId: entry.binding.registrationId,
      status: entry.receipt ? 'settled' : 'pending', receipt: entry.receipt, verified: entry.verified }
  }
  async function dispatch(caller: AppActionCallerContext, intent: AppActionIntent): Promise<{ requestId: string; result: Promise<AppActionResult> }> {
    const checkCaller = () => { if (caller.signal?.aborted) refuse('caller_stopped') }
    checkCaller()
    actionTransportId(intent.requestId)
    const intentHash = canonicalActionJson(intent)
    const key = requestKey(caller, intent.requestId)
    const prior = pending.get(key)
    if (prior) {
      if (prior.intent !== intentHash) refuse('request_id_conflict')
      return { requestId: intent.requestId, result: prior.promise.then(receipt => ({ receipt, verified: prior.verified, targetDocumentId: prior.binding.registrationId })) }
    }
    const binding = select(caller, intent)
    if ([...pending.values()].filter(entry => entry.binding === binding).length >= 128 || pending.size >= 2048) refuse('receipt_capacity')
    const request = parseActionRequest({ requestId: intent.requestId, actionId: intent.actionId, args: intent.args,
      documentId: binding.documentId, documentEpoch: binding.documentEpoch, catalogVersion: APP_ACTIONS_VERSION,
      expectedSessionId: intent.expectedSessionId, expiresAt: Math.min(now() + APP_ACTION_DEADLINE_MS, binding.expiresAt) })
    const admission = async <T>(operation: () => Promise<T>): Promise<T> => {
      checkCaller()
      if (now() >= request.expiresAt) refuse('expired_request')
      let timer: ReturnType<typeof setTimeout> | undefined
      let stop: (() => void) | undefined
      const interrupted = new Promise<never>((_resolve, reject) => {
        stop = () => reject(new AppActionRefusal('caller_stopped'))
        caller.signal?.addEventListener('abort', stop, { once: true })
        timer = setTimeout(() => reject(new AppActionRefusal('expired_request')), Math.max(0, request.expiresAt - now()))
      })
      try {
        // A late read/hash answer is observed by Promise.race but cannot resume
        // this admission after Stop/deadline. These operations have no effects.
        return await Promise.race([Promise.resolve().then(() => {
          checkCaller()
          if (now() >= request.expiresAt) refuse('expired_request')
          return operation()
        }), interrupted])
      } finally {
        clearTimeout(timer)
        if (stop) caller.signal?.removeEventListener('abort', stop)
      }
    }
    if (!await admission(() => ports.validAuthentication(binding))) refuse('retired_authentication')
    checkCaller()
    // Do not route a command after session renewal, logout or a racing duplicate changed it.
    if (select(caller, intent) !== binding || bindings.get(binding.registrationId) !== binding || now() >= request.expiresAt) refuse('stale_registration')
    const racing = pending.get(key)
    if (racing) {
      if (racing.intent !== intentHash) refuse('request_id_conflict')
      return { requestId: intent.requestId, result: racing.promise.then(receipt => ({ receipt, verified: racing.verified, targetDocumentId: racing.binding.registrationId })) }
    }
    const actionHash = toActionBase64(new Uint8Array(await admission(() => webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalActionJson(request))))))
    checkCaller()
    // No await follows the final dedup/freshness decision before admission.
    if (pending.has(key)) return dispatch(caller, intent)
    if (select(caller, intent) !== binding || bindings.get(binding.registrationId) !== binding ||
      binding.expectedSessionId !== request.expectedSessionId || now() >= request.expiresAt) refuse('stale_registration')
    if ([...pending.values()].filter(entry => entry.binding === binding).length >= 128 || pending.size >= 2048) refuse('receipt_capacity')
    const command: AppActionCommand = { type: 'app_action_requested', protocolVersion: APP_ACTION_TRANSPORT_VERSION,
      registrationId: binding.registrationId, registrationEpoch: binding.registrationEpoch, processId,
      nonce: randomUUID(), actionHash, request }
    let resolve!: (receipt: ActionReceipt) => void
    const promise = new Promise<ActionReceipt>(done => { resolve = done })
    const entry: Pending = { userId: caller.userId, scopeId: caller.scopeId, intent: intentHash, command, binding,
      receipt: null, verified: false, promise, timer: undefined as unknown as ReturnType<typeof setTimeout>, releaseAbort: () => {},
      finish(receipt, verified) {
        if (entry.receipt) return
        clearTimeout(entry.timer)
        entry.releaseAbort()
        entry.receipt = receipt; entry.verified = verified; resolve(receipt)
      } }
    entry.timer = setTimeout(() => entry.finish({ requestId: request.requestId, actionId: request.actionId,
      documentId: request.documentId, documentEpoch: request.documentEpoch, catalogVersion: request.catalogVersion,
      status: 'unknown_outcome', reason: 'receipt_timeout', visible: 'unknown',
      saved: request.actionId.startsWith('goon.') ? 'unknown' : 'not_requested' }, false), Math.max(0, request.expiresAt - now()))
    pending.set(key, entry)
    const onAbort = () => {
      // A cancel may reach the tab before its command. The tab keeps this exact nonce retired.
      void Promise.resolve().then(() => ports.publish(caller.userId, { type: 'app_action_cancelled', command })).catch(() => {
        entry.finish({ requestId: request.requestId, actionId: request.actionId, documentId: request.documentId,
          documentEpoch: request.documentEpoch, catalogVersion: request.catalogVersion, status: 'unknown_outcome',
          reason: 'cancel_unconfirmed', visible: 'unknown', saved: request.actionId.startsWith('goon.') ? 'unknown' : 'not_requested' }, false)
      })
    }
    if (caller.signal) {
      caller.signal.addEventListener('abort', onAbort, { once: true })
      entry.releaseAbort = () => caller.signal?.removeEventListener('abort', onAbort)
    }
    // Existing Redis acquisition/PUBLISH can outlive this invocation. Observe that
    // lifetime without making the caller wait past the exact receipt deadline.
    // Timeout does not withdraw a queued command; its late delivery must still
    // obey the original expiry/cancellation, and its request ID stays retained.
    void Promise.resolve().then(() => ports.publish(caller.userId, command)).catch(() => {
      // Publish failure can follow delivery. Uncertainty never instructs the caller to retry.
      entry.finish({ requestId: request.requestId, actionId: request.actionId, documentId: request.documentId,
        documentEpoch: request.documentEpoch, catalogVersion: request.catalogVersion, status: 'unknown_outcome',
        reason: 'delivery_unconfirmed', visible: 'unknown', saved: request.actionId.startsWith('goon.') ? 'unknown' : 'not_requested' }, false)
    })
    return { requestId: request.requestId, result: promise.then(receipt => ({ receipt, verified: entry.verified, targetDocumentId: binding.registrationId })) }
  }
  async function acceptReceipt(auth: DocumentAuth, commandValue: unknown, receiptValue: unknown, signature: unknown) {
    const command = parseAppActionCommand(commandValue)
    if (command.processId !== processId) refuse('wrong_process')
    const binding = owned(auth, command.registrationId)
    const entry = [...pending.values()].find(candidate => candidate.binding === binding && candidate.command.request.requestId === command.request.requestId && candidate.command.nonce === command.nonce)
    if (!entry || entry.receipt) refuse('receipt_replayed_or_unknown')
    if (command.registrationEpoch !== binding.registrationEpoch || canonicalActionJson(command) !== canonicalActionJson(entry.command)) refuse('receipt_mismatch')
    if (now() >= command.request.expiresAt) refuse('expired_request')
    const receipt = parseAppActionReceipt(receiptValue, entry.command.request)
    await verify(binding.key, 'receipt', { command, receipt }, signature)
    if (entry.receipt || bindings.get(binding.registrationId) !== binding || binding.expectedSessionId !== command.request.expectedSessionId || now() >= command.request.expiresAt) refuse('receipt_replayed_or_expired')
    entry.finish(receipt, true)
    return { accepted: true }
  }
  function dispose() {
    for (const entry of pending.values()) {
      entry.finish({ requestId: entry.command.request.requestId, actionId: entry.command.request.actionId,
        documentId: entry.command.request.documentId, documentEpoch: entry.command.request.documentEpoch,
        catalogVersion: APP_ACTIONS_VERSION, status: 'unknown_outcome', reason: 'retired_registration',
        visible: 'unknown', saved: entry.command.request.actionId.startsWith('goon.') ? 'unknown' : 'not_requested' }, false)
    }
    challenges.clear(); bindings.clear(); pending.clear()
  }
  return { processId, beginRegistration, beginRenewal, prove, dispatch, status, acceptReceipt, listDocuments, dispose }
}
export type AppActionRegistry = ReturnType<typeof createAppActionRegistry>
