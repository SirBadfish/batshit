import { APP_ACTIONS_VERSION, AppActionRefusal, refuse } from './catalog'
import type { AppActionsDocument } from './document'
import {
  APP_ACTION_DEADLINE_MS, APP_ACTION_LEASE_MS, actionProofBytes, actionTransportRecord,
  canonicalActionJson, parseAppActionCommand, parseAppActionReceipt, parseDocumentIdentity, toActionBase64
} from './protocol'
import type { DocumentChallenge, DocumentIdentity, Registration } from './protocol'

type TransportPorts = {
  fetch: typeof fetch
  crypto: Crypto
  /** The mounted page's existing onUserChannelEvent, never a new EventSource. */
  onEvent(listener: (event: unknown) => void): () => void
  connected(): boolean
  feedback(reason: string): void
  now?: () => number
}
/** A submitted register/renew proof without a confirmed answer: the server may have admitted or extended it. */
type Candidate = Pick<DocumentChallenge, 'registrationId' | 'registrationEpoch' | 'processId' | 'challengeExpiresAt' | 'expiresAt'> & {
  /** Page-clock bound: the challenge was issued before this page held it, so it ends before now + deadline. */
  localHorizon: number
}
const RENEW_INTERVAL_MS = 20_000
/** Three transient attempts in a row, then visible exhaustion until refresh, reconnect or a visible page. */
const RETRY_DELAYS_MS = [1000, 2000]
/** Past a challenge's horizon its proof can no longer be admitted, so absence then means retirement. */
const HORIZON_MARGIN_MS = 1000
/** Never auth, origin, signature, schema or capacity refusals. */
const TRANSIENT_REASONS = new Set(['transport_failed', 'live_document_unavailable', 'stale_session', 'stale_registration', 'stale_challenge'])

/** The signing key never leaves this owner closure or appears in window/state/storage. */
export function createAppActionsBrowserTransport(document: AppActionsDocument, ports: TransportPorts) {
  const now = ports.now ?? Date.now
  let alive = true
  let registration: Registration | null = null
  let failure: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let key: CryptoKey | null = null
  let fingerprint = ''
  const flights = new Map<string, Promise<void>>()
  const inFlightRequests = new Set<string>()
  const cancelledCommands = new Map<string, string>()
  const observedCommands = new Map<string, string>()
  // Lease maintenance (BL-1273): one flight and one timer. Expiry/restart never revives an expired identity
  // or retries an action; this still-mounted document may obtain a NEW challenged binding.
  let publicKey: Record<string, unknown> | null = null
  let started = false
  let generation = 0
  let maintenance: Promise<void> | null = null
  let again = false
  let attempts = 0
  const candidates = new Map<string, Candidate>()

  function identity(): DocumentIdentity {
    const state = document.state()
    if (!alive || !state.mounted) refuse('unmounted_document')
    return parseDocumentIdentity({ catalogVersion: state.catalogVersion, documentId: state.documentId,
      documentEpoch: state.documentEpoch, expectedSessionId: state.expectedSessionId })
  }
  function report(error: unknown) {
    const reason = error instanceof AppActionRefusal ? error.reason : 'transport_failed'
    if (alive && failure !== reason) ports.feedback(reason)
    failure = reason
  }
  async function post(path: string, body: unknown): Promise<unknown> {
    const signal = AbortSignal.timeout(APP_ACTION_DEADLINE_MS)
    const response = await ports.fetch(`/api/app/actions/${path}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: canonicalActionJson(body), signal })
    const value: unknown = await response.json()
    if (!response.ok) {
      const reason = value && typeof value === 'object' ? (value as { reason?: unknown }).reason : null
      refuse(typeof reason === 'string' ? reason : 'transport_failed')
    }
    return value
  }
  function checkedChallenge(value: unknown, expected: DocumentIdentity, kind: 'register' | 'renew',
    target?: Pick<Registration, 'registrationId' | 'registrationEpoch' | 'processId'>): DocumentChallenge {
    const raw = actionTransportRecord(value, ['catalogVersion', 'documentId', 'documentEpoch', 'expectedSessionId',
      'registrationId', 'registrationEpoch', 'processId', 'expiresAt', 'kind', 'challengeId', 'nonce', 'challengeExpiresAt', 'keyFingerprint'])
    const challenge = raw as unknown as DocumentChallenge
    if (challenge.kind !== kind || challenge.catalogVersion !== APP_ACTIONS_VERSION ||
      challenge.keyFingerprint !== fingerprint || !Number.isFinite(challenge.challengeExpiresAt) ||
      challenge.challengeExpiresAt > now() + APP_ACTION_DEADLINE_MS ||
      !Number.isFinite(challenge.expiresAt) || challenge.expiresAt > now() + APP_ACTION_LEASE_MS) refuse('invalid_challenge')
    // A challenge or lease that elapsed while this page was stalled is stale, not malformed.
    if (challenge.challengeExpiresAt <= now() || challenge.expiresAt <= now()) refuse('stale_challenge')
    for (const field of ['catalogVersion', 'documentId', 'documentEpoch', 'expectedSessionId'] as const) if (challenge[field] !== expected[field]) refuse('stale_document')
    if (kind === 'renew' && (!target || challenge.registrationId !== target.registrationId ||
      challenge.registrationEpoch !== target.registrationEpoch || challenge.processId !== target.processId)) refuse('stale_registration')
    if (canonicalActionJson(identity()) !== canonicalActionJson(expected)) refuse('stale_session')
    return challenge
  }
  function bindingFromChallenge(challenge: DocumentChallenge): Registration {
    const { catalogVersion, documentId, documentEpoch, expectedSessionId, registrationId, registrationEpoch, processId, expiresAt } = challenge
    return { catalogVersion, documentId, documentEpoch, expectedSessionId, registrationId, registrationEpoch, processId, expiresAt }
  }
  async function sign(domain: 'register' | 'renew' | 'receipt', value: unknown) {
    if (!alive || !key) refuse('unmounted_document')
    return toActionBase64(new Uint8Array(await ports.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, actionProofBytes(domain, value))))
  }
  /** Every async result answers only the alive mount, exact document/session and generation it started with. */
  function fence(capturedGeneration: number, expected: DocumentIdentity) {
    if (!alive || canonicalActionJson(identity()) !== canonicalActionJson(expected)) refuse('stale_session')
    if (generation !== capturedGeneration) refuse('stale_registration')
  }
  async function proof(path: 'register' | 'renew', challenge: DocumentChallenge, signature: string): Promise<Registration> {
    const { registrationId, registrationEpoch, processId, challengeExpiresAt, expiresAt } = challenge
    candidates.set(challenge.challengeId, { registrationId, registrationEpoch, processId, challengeExpiresAt, expiresAt,
      localHorizon: now() + APP_ACTION_DEADLINE_MS })
    let answer: unknown
    try { answer = await post(path, { challengeId: challenge.challengeId, signature }) } catch (error) {
      // A server refusal proves this proof was not admitted. A lost or failed answer proves nothing.
      if (error instanceof AppActionRefusal && error.reason !== 'transport_failed') candidates.delete(challenge.challengeId)
      throw error
    }
    if (canonicalActionJson(answer) !== canonicalActionJson(bindingFromChallenge(challenge))) refuse('invalid_registration')
    return bindingFromChallenge(challenge)
  }
  /** Same key, exact registration: renew it, or null once the server holds no live binding with this ID. */
  async function reconcile(target: Pick<Registration, 'registrationId' | 'registrationEpoch' | 'processId'>,
    capturedGeneration: number, expected: DocumentIdentity): Promise<Registration | null> {
    let value: unknown
    try { value = await post('renew', { registrationId: target.registrationId, identity: expected }) } catch (error) {
      if (!(error instanceof AppActionRefusal) || error.reason !== 'stale_registration') throw error
      fence(capturedGeneration, expected) // A "gone" answer is an async result too.
      return null
    }
    fence(capturedGeneration, expected)
    const challenge = checkedChallenge(value, expected, 'renew', target)
    const signature = await sign('renew', challenge)
    fence(capturedGeneration, expected)
    const binding = await proof('renew', challenge, signature)
    fence(capturedGeneration, expected)
    return binding
  }
  async function registerCurrent(capturedGeneration: number, expected: DocumentIdentity): Promise<Registration> {
    if (!publicKey) refuse('unmounted_document')
    fence(capturedGeneration, expected)
    const value = await post('register', { identity: expected, publicKey })
    fence(capturedGeneration, expected)
    const challenge = checkedChallenge(value, expected, 'register')
    const signature = await sign('register', challenge)
    fence(capturedGeneration, expected)
    const binding = await proof('register', challenge, signature)
    fence(capturedGeneration, expected)
    return binding
  }
  function adopt(binding: Registration) {
    for (const [id, candidate] of candidates) if (candidate.registrationId === binding.registrationId) candidates.delete(id)
    if (registration?.registrationId !== binding.registrationId) generation++
    registration = binding
    failure = null
    attempts = 0
  }
  function retireRegistration(registrationId: string) {
    // The server holds no live binding with this ID, so no outstanding renewal proof can extend it.
    for (const [id, candidate] of candidates) if (candidate.registrationId === registrationId) candidates.delete(id)
    if (registration?.registrationId === registrationId) { registration = null; generation++ }
  }
  function latestCandidate(): Candidate | undefined {
    return [...candidates.values()].sort((a, b) => b.expiresAt - a.expiresAt)[0]
  }
  /** One pass. Returns the delay before the next pass; throws when this pass failed. */
  async function maintain(): Promise<number> {
    const expected = identity()
    if (!ports.connected()) refuse('live_document_unavailable')
    // 1. Same key, exact registration first: a lost renewal answer may already have extended the lease.
    if (registration) {
      const current = registration
      const renewed = await reconcile(current, generation, expected)
      if (renewed) { adopt(renewed); return RENEW_INTERVAL_MS }
      retireRegistration(current.registrationId)
    }
    // 2. A proof whose answer was lost can still be admitted until its challenge horizon passes.
    const waiting = Math.max(0, ...[...candidates.values()].map(candidate =>
      Math.max(candidate.challengeExpiresAt, candidate.localHorizon) + HORIZON_MARGIN_MS - now()))
    if (waiting > 0) return waiting
    for (let candidate = latestCandidate(); candidate; candidate = latestCandidate()) {
      const adopted = await reconcile(candidate, generation, expected)
      if (adopted) { adopt(adopted); return RENEW_INTERVAL_MS }
      retireRegistration(candidate.registrationId)
    }
    // 3. Old binding and every candidate retired: this still-mounted document may obtain a NEW challenged binding.
    adopt(await registerCurrent(generation, expected))
    return RENEW_INTERVAL_MS
  }
  function schedule(delay: number) {
    clearTimeout(timer)
    if (alive) timer = setTimeout(() => { void runMaintenance().catch(() => {}) }, delay)
  }
  function settle(error: unknown) {
    if (!alive) return
    report(error)
    if (error instanceof AppActionRefusal && !TRANSIENT_REASONS.has(error.reason)) return // Visible; no retry.
    const delay = RETRY_DELAYS_MS[attempts++]
    if (delay === undefined) { report(new AppActionRefusal('recovery_exhausted')); return }
    schedule(delay)
  }
  function runMaintenance(): Promise<void> {
    if (!started || !alive) return Promise.resolve()
    if (maintenance) { again = true; return maintenance }
    clearTimeout(timer)
    maintenance = (async () => {
      try { schedule(await maintain()) } catch (error) { settle(error); throw error }
    })().finally(() => {
      maintenance = null
      if (again && alive) { again = false; void runMaintenance().catch(() => {}) }
    })
    return maintenance
  }
  async function receive(value: unknown) {
    if (!alive || !registration || !value || typeof value !== 'object') return
    if ((value as { type?: unknown }).type === 'app_action_cancelled') {
      const { userId: _userId, ...event } = value as Record<string, unknown>
      const cancellation = actionTransportRecord(event, ['type', 'command'])
      const command = parseAppActionCommand(cancellation.command)
      if (command.registrationId !== registration.registrationId) return
      if (command.processId !== registration.processId || command.registrationEpoch !== registration.registrationEpoch ||
        command.request.documentId !== registration.documentId || command.request.documentEpoch !== registration.documentEpoch) refuse('stale_registration')
      if (now() >= command.request.expiresAt) refuse('expired_request')
      const encoded = canonicalActionJson(command)
      const known = observedCommands.get(command.request.requestId)
      if (known && known !== encoded) refuse('command_mismatch')
      const prior = cancelledCommands.get(command.nonce)
      if (prior) { if (prior !== encoded) refuse('command_mismatch'); return }
      if (cancelledCommands.size >= 128) refuse('receipt_capacity')
      cancelledCommands.set(command.nonce, encoded)
      if (known === encoded) document.cancel(command.request.requestId)
      return
    }
    if ((value as { type?: unknown }).type !== 'app_action_requested') return
    // Only the exact registered document observes this broadcast. Others cannot sign for it.
    if ((value as { registrationId?: unknown }).registrationId !== registration.registrationId) return
    // publishUserEvent adds userId as routing metadata, never part of the signed command.
    const { userId: _userId, ...payload } = value as Record<string, unknown>
    const command = parseAppActionCommand(payload)
    if (command.processId !== registration.processId || command.registrationEpoch !== registration.registrationEpoch ||
      registration.expiresAt <= now() || command.request.documentId !== registration.documentId ||
      command.request.documentEpoch !== registration.documentEpoch) refuse('stale_registration')
    const prior = flights.get(command.nonce)
    if (prior) return prior
    if (flights.size >= 128) refuse('receipt_capacity')
    const encoded = canonicalActionJson(command)
    const known = observedCommands.get(command.request.requestId)
    if (known && known !== encoded) refuse('command_mismatch')
    if (cancelledCommands.has(command.nonce) && cancelledCommands.get(command.nonce) !== encoded) refuse('command_mismatch')
    observedCommands.set(command.request.requestId, encoded)
    const capturedGeneration = generation
    const flight = (async () => {
      const hash = toActionBase64(new Uint8Array(await ports.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalActionJson(command.request)))))
      if (hash !== command.actionHash) refuse('command_mismatch')
      if (now() >= command.request.expiresAt || command.request.expiresAt > now() + APP_ACTION_DEADLINE_MS) refuse('expired_request')
      identity() // recheck unmount after async digest, before an owner is admitted
      if (generation !== capturedGeneration) refuse('stale_registration')
      if (inFlightRequests.has(command.request.requestId)) refuse('request_id_conflict')
      inFlightRequests.add(command.request.requestId)
      try {
        // Only the real five-action owner result is signed. There is no public signing helper.
        const owner = document.execute(command.request)
        if (cancelledCommands.has(command.nonce)) document.cancel(command.request.requestId)
        const result = await owner
        const receipt = parseAppActionReceipt(JSON.parse(JSON.stringify(result)), command.request)
        if (!alive || now() >= command.request.expiresAt) refuse('expired_request')
        // Sign only for the exact mounted document and the registration generation that received the command.
        const current = identity()
        if (current.documentId !== command.request.documentId || current.documentEpoch !== command.request.documentEpoch) refuse('stale_document')
        if (generation !== capturedGeneration) refuse('stale_registration')
        const signature = await sign('receipt', { command, receipt })
        if (!alive || generation !== capturedGeneration) refuse('stale_registration')
        await post('receipt', { command, receipt, signature })
      } finally { inFlightRequests.delete(command.request.requestId) }
    })()
    flights.set(command.nonce, flight)
    return flight
  }
  const unsubscribe = ports.onEvent(value => {
    // The existing user channel came back: the lease may have lapsed meanwhile.
    if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'reconnected') {
      attempts = 0
      void runMaintenance().catch(() => {})
      return
    }
    void receive(value).catch(report)
  })
  const ready = (async () => {
    if (!ports.crypto?.subtle) refuse('document_crypto_unavailable')
    const connectionDeadline = now() + APP_ACTION_DEADLINE_MS
    while (!ports.connected()) {
      identity()
      if (now() >= connectionDeadline) refuse('live_document_unavailable')
      await new Promise<void>(resolve => setTimeout(resolve, 25))
    }
    const pair = await ports.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
    key = pair.privateKey
    const exported = await ports.crypto.subtle.exportKey('jwk', pair.publicKey)
    publicKey = { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y }
    fingerprint = toActionBase64(new Uint8Array(await ports.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalActionJson(publicKey)))))
    started = true
    await runMaintenance()
  })()
  // The page may await ready; this observer also prevents an unhandled initialization failure.
  void ready.catch(report)
  return {
    ready,
    refresh: () => { attempts = 0; return runMaintenance() },
    state: () => ({ registration: registration && { ...registration }, ready: Boolean(registration && registration.expiresAt > now() && !failure && ports.connected()), failure }),
    retire() { alive = false; clearTimeout(timer); key = null; registration = null; generation++; unsubscribe(); flights.clear(); cancelledCommands.clear(); observedCommands.clear(); candidates.clear() }
  }
}
