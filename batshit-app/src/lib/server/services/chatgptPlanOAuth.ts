import { createServer, type Server } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose'
import { ChatgptPlanError, type ChatgptPlanVault, type PlanRegistration, type PlanTokens } from './chatgptPlanVault'

const ISSUER = 'https://auth.openai.com'
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`
const TOKEN = `${ISSUER}/api/accounts/oauth/token`
const RESOURCE = 'https://api.openai.com/v1'
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const ATTEMPT_TIMEOUT_MS = 5 * 60_000
type Discovery = { issuer: string; jwks_uri: string; revocation_endpoint: string }
type Pending = {
  userId: string; sessionToken: string; state: string; nonce: string; verifier: string; redirect: string
  epoch: string; selected?: PlanRegistration; server: Server; timer: ReturnType<typeof setTimeout>
  controller: AbortController; consumed: boolean
}
export type PlanAttemptStatus = { state: 'idle' | 'waiting' | 'complete' | 'error'; code?: string; accountId?: string; cleanup?: 'confirmed' | 'unconfirmed' }
export class PlanRenewalError extends ChatgptPlanError {
  constructor(readonly cleanupConfirmed: boolean) { super('reconnect_required', cleanupConfirmed ? 'ChatGPT renewal was rejected and its returned renewable credential was revoked. Connect again from API Keys.' : 'ChatGPT renewal failed. Remote credential cleanup could not be confirmed. Manage this app in ChatGPT settings, then connect again from API Keys.') }
}

// Error messages never include raw endpoint bodies, nested errors or URLs.
export function planDiagnostic(error: unknown): { code: string; message: string } {
  return error instanceof ChatgptPlanError
    ? { code: error.code, message: error.message }
    : { code: 'connection_failed', message: 'ChatGPT connection failed. Try again from API Keys.' }
}
function authError(code: string): ChatgptPlanError {
  const terminal = ['invalid_grant', 'invalid_client', 'access_denied'].includes(code) ? code : 'oauth_exchange_failed'
  return new ChatgptPlanError(terminal, terminal === 'access_denied' ? 'ChatGPT sign-in was cancelled.' : 'ChatGPT could not authorize this connection. Start sign-in again from API Keys.')
}
function equalSecret(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
function boundedString(value: unknown, limit = 16_384): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
}

/** Public OpenAI endpoints only. Injectable fetch exists for fixture proof. */
export class ChatgptPlanOAuth {
  private closed = false
  private pending = new Map<string, Pending>()
  private starts = new Map<string, AbortController>()
  private statuses = new Map<string, PlanAttemptStatus>()
  private cleanupNotices = new Set<string>()
  constructor(
    private vault: ChatgptPlanVault,
    private sessionIsValid: (token: string, userId: string) => Promise<boolean>,
    private http: typeof fetch = fetch
  ) {}

  private async json(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response
    try { response = await this.http(url, { ...init, redirect: 'error' }) } catch { throw authError('network') }
    // Bound the token/discovery/JWKS response before JSON parsing; never log it.
    const reader = response.body?.getReader()
    if (!reader) throw authError('invalid_response')
    const chunks: Uint8Array[] = []; let size = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > 128_000) { await reader.cancel(); throw authError('response_too_large') }
        chunks.push(next.value)
      }
    } finally { reader.releaseLock() }
    const body = Buffer.concat(chunks).toString('utf8')
    let value: unknown
    try { value = JSON.parse(body) } catch { throw authError('invalid_response') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw authError('invalid_response')
    const record = value as Record<string, unknown>
    if (!response.ok) throw authError(typeof record.error === 'string' ? record.error : '')
    return record
  }
  private async discovery(signal: AbortSignal): Promise<Discovery> {
    const value = await this.json(`${ISSUER}/.well-known/openid-configuration`, { signal })
    if (value.issuer !== ISSUER || value.jwks_uri !== `${ISSUER}/.well-known/jwks.json` || value.revocation_endpoint !== `${ISSUER}/api/accounts/oauth/revoke`) {
      throw new ChatgptPlanError('oidc_configuration', 'OpenAI identity configuration changed. This connection needs an app update.')
    }
    return value as Discovery
  }
  private async verifyId(idToken: string, clientId: string, signal: AbortSignal, nonce?: string) {
    const discovery = await this.discovery(signal)
    const jwks = await this.json(discovery.jwks_uri, { signal })
    try {
      const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks as unknown as JSONWebKeySet), {
        issuer: ISSUER, audience: clientId, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5
      })
      if (!boundedString(payload.sub, 1024) || (nonce !== undefined && (typeof payload.nonce !== 'string' || !equalSecret(payload.nonce, nonce)))) throw authError('identity')
      return { issuer: ISSUER, subject: payload.sub, email: typeof payload.email === 'string' ? payload.email.slice(0, 320) : '' }
    } catch { throw new ChatgptPlanError('identity_invalid', 'ChatGPT identity could not be verified. The existing account was kept.') }
  }
  private parseTokens(value: Record<string, unknown>, previous?: PlanTokens): PlanTokens {
    if (!boundedString(value.access_token) || !boundedString(value.refresh_token) || value.token_type !== 'Bearer' ||
        typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 86_400 ||
        (!boundedString(value.id_token) && !previous?.idToken) || (typeof value.scope !== 'string' && !previous)) throw authError('tokens')
    // The reference names earliest_refresh_at without defining its format or
    // scheduling semantics. Do not infer a timestamp or expose quota telemetry.
    return { accessToken: value.access_token, refreshToken: value.refresh_token, idToken: boundedString(value.id_token) ? value.id_token : previous!.idToken,
      scopes: typeof value.scope === 'string' ? value.scope.split(/\s+/).filter(Boolean) : previous!.scopes,
      expiresAt: Date.now() + value.expires_in * 1000 }
  }
  status(userId: string): PlanAttemptStatus { return { ...(this.statuses.get(userId) ?? { state: 'idle' }), ...(this.cleanupNotices.has(userId) || this.vault.cleanupUnconfirmed(userId) ? { cleanup: 'unconfirmed' } : {}) } }
  private unconfirmedCleanup(userId: string) {
    this.cleanupNotices.add(userId)
    try { this.vault.recordUnconfirmedCleanup(userId) } catch { /* Keep the warning in memory; custody itself refuses admission. */ }
  }
  cancel(userId: string) {
    this.starts.get(userId)?.abort(); this.starts.delete(userId)
    const attempt = this.pending.get(userId)
    if (attempt) { attempt.controller.abort(); this.dispose(attempt) }
    this.vault.cancelAuthorization(userId)
    this.statuses.set(userId, { state: 'idle' })
  }
  private dispose(attempt: Pending) {
    clearTimeout(attempt.timer); attempt.server.close(); attempt.server.closeAllConnections()
    if (this.pending.get(attempt.userId) === attempt) this.pending.delete(attempt.userId)
  }
  async start(userId: string, sessionToken: string, accountId?: string): Promise<string> {
    if (this.closed) throw new ChatgptPlanError('request_stopped', 'Batshit is stopping. Restart it before connecting ChatGPT.')
    if (!(await this.sessionIsValid(sessionToken, userId))) throw new ChatgptPlanError('session_required', 'Sign in to Batshit before connecting ChatGPT.')
    // Session validation can outlive close before this start has a controller.
    if (this.closed) throw new ChatgptPlanError('request_stopped', 'Batshit is stopping. Restart it before connecting ChatGPT.')
    this.cancel(userId)
    const selected = accountId ? this.vault.get(userId, accountId) : undefined
    if (selected?.revocationStatus === 'pending') throw new ChatgptPlanError('disconnect_pending', 'Wait for ChatGPT disconnect to finish before signing in again.')
    if (selected && (selected.state === 'ready' || selected.state === 'identity-only' || selected.refreshPending)) throw new ChatgptPlanError('disconnect_required', 'Disconnect the existing ChatGPT account before signing in again.')
    const epoch = this.vault.beginAuthorization(userId)
    const controller = new AbortController()
    this.starts.set(userId, controller)
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url')
    let attempt: Pending | undefined
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/plain; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
      response.setHeader('X-Content-Type-Options', 'nosniff')
      const active = attempt
      let callback: URL | null = null
      try { callback = active ? new URL(request.url ?? '/', active.redirect) : null } catch {
        response.statusCode = 400; response.end('This callback is not a pending Batshit sign-in.'); return
      }
      const invalid = !active || active.consumed || request.method !== 'GET' || request.headers.host !== new URL(active.redirect).host ||
        callback?.origin !== new URL(active.redirect).origin || callback?.pathname !== '/auth/callback' || ['state', 'code', 'client_id', 'error'].some(key => callback!.searchParams.getAll(key).length > 1) ||
        !equalSecret(callback!.searchParams.get('state') ?? '', active.state)
      if (invalid) { response.statusCode = 400; response.end('This callback is not a pending Batshit sign-in.'); return }
      active.consumed = true
      // Keep the response inert and generic. Never echo any callback parameter.
      response.end('Return to Batshit to see the connection status.')
      void this.complete(active, callback!).catch(() => {
        this.unconfirmedCleanup(active.userId)
        if (this.pending.get(active.userId) === active) this.statuses.set(active.userId, { state: 'error', code: 'connection_failed', cleanup: 'unconfirmed' })
      }).finally(() => this.dispose(active))
    })
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      if (controller.signal.aborted || this.starts.get(userId) !== controller) throw authError('attempt_stale')
      const address = server.address()
      if (!address || typeof address === 'string') throw authError('listener')
      const redirect = `http://127.0.0.1:${address.port}/auth/callback`
      const timer = setTimeout(() => {
        if (!attempt) return
        controller.abort(); this.dispose(attempt); this.statuses.set(userId, { state: 'error', code: 'sign_in_expired' })
      }, ATTEMPT_TIMEOUT_MS)
      timer.unref()
      attempt = { userId, sessionToken, state, nonce, verifier, redirect, epoch, selected, server, timer, controller, consumed: false }
      this.pending.set(userId, attempt); this.statuses.set(userId, { state: 'waiting' })
      this.starts.delete(userId)
      const url = new URL(AUTHORIZE)
      const params = { client_id: selected?.clientId ?? 'dynamic_agent_client', ext_agent_host_id: this.vault.hostId,
        response_type: 'code', redirect_uri: redirect, scope: SCOPES, resource: RESOURCE, state, nonce,
        code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
      if (!selected) url.searchParams.set('agent_name_hint', 'Batshit')
      return url.href
    } catch {
      server.close(); server.closeAllConnections()
      if (this.starts.get(userId) === controller) this.starts.delete(userId)
      throw new ChatgptPlanError('callback_unavailable', 'Batshit could not open its local sign-in callback. Try again.')
    }
  }
  private async complete(attempt: Pending, callback: URL) {
    let issued: { clientId: string; refreshToken: string } | undefined
    let activated = false
    let failureCode: string | undefined
    try {
      const params = callback.searchParams
      if (params.has('error')) throw authError(params.get('error') ?? '')
      const clientId = params.get('client_id') ?? attempt.selected?.clientId
      const code = params.get('code')
      if (!boundedString(clientId, 1024) || clientId === 'dynamic_agent_client' || !boundedString(code) ||
          (attempt.selected && clientId !== attempt.selected.clientId)) throw new ChatgptPlanError('client_mismatch', 'ChatGPT registration did not match this sign-in. The existing account was kept.')
      if (!(await this.sessionIsValid(attempt.sessionToken, attempt.userId)) || attempt.controller.signal.aborted) throw new ChatgptPlanError('session_expired', 'Batshit sign-in expired. Connect ChatGPT again after signing in.')
      const signal = AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(30_000)])
      const value = await this.json(TOKEN, { method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirect, resource: RESOURCE }) })
      if (boundedString(value.refresh_token)) issued = { clientId, refreshToken: value.refresh_token }
      const tokens = this.parseTokens(value)
      const identity = await this.verifyId(tokens.idToken, clientId, signal, attempt.nonce)
      if (!(await this.sessionIsValid(attempt.sessionToken, attempt.userId)) || signal.aborted || this.pending.get(attempt.userId) !== attempt) throw new ChatgptPlanError('attempt_stale', 'This sign-in attempt was cancelled or replaced.')
      const row = this.vault.connect({ ...identity, clientId, userId: attempt.userId }, tokens, attempt.epoch, attempt.selected)
      activated = true
      this.statuses.set(attempt.userId, { state: 'complete', accountId: row.id })
    } catch (error) {
      failureCode = planDiagnostic(error).code
    } finally {
      // An exchanged but cancelled/rejected grant must not become an orphan
      // renewable credential merely because it never reached the vault.
      const confirmed = issued && !activated ? await this.revoke({ clientId: issued.clientId }, issued.refreshToken) : undefined
      if (confirmed === false) this.unconfirmedCleanup(attempt.userId)
      if (!activated && this.pending.get(attempt.userId) === attempt) this.statuses.set(attempt.userId, { state: 'error', code: failureCode ?? 'connection_failed', ...(confirmed === undefined ? {} : { cleanup: confirmed ? 'confirmed' : 'unconfirmed' }) })
    }
  }
  async refresh(registration: PlanRegistration, previous: PlanTokens, signal: AbortSignal): Promise<PlanTokens> {
    const value = await this.json(TOKEN, { method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: registration.clientId, refresh_token: previous.refreshToken, resource: RESOURCE }) })
    const candidate = boundedString(value.refresh_token) ? value.refresh_token : undefined
    try {
      const tokens = this.parseTokens(value, previous)
      if (boundedString(value.id_token)) {
        const identity = await this.verifyId(tokens.idToken, registration.clientId, signal)
        if (identity.subject !== registration.subject || identity.issuer !== registration.issuer) throw authError('identity')
      }
      if (!['resource.invoke', 'chatgpt.tokens.use.direct'].every(scope => tokens.scopes.includes(scope))) throw authError('scope')
      return tokens
    } catch {
      const confirmed = candidate ? await this.revoke(registration, candidate) : false
      if (!confirmed) this.unconfirmedCleanup(registration.userId)
      throw new PlanRenewalError(confirmed)
    }
  }
  async revoke(registration: Pick<PlanRegistration, 'clientId'>, refreshToken: string): Promise<boolean> {
    try {
      const signal = AbortSignal.timeout(15_000)
      const discovery = await this.discovery(signal)
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await this.http(discovery.revocation_endpoint, { method: 'POST', signal, redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: registration.clientId }) })
        await response.body?.cancel()
        if (response.status === 200) return true
        if (response.status < 500) return false
        await new Promise(resolve => setTimeout(resolve, 300))
      }
    } catch { /* Local clearing and remote uncertainty remain separate. */ }
    return false
  }
  close() {
    this.closed = true
    for (const controller of this.starts.values()) controller.abort()
    this.starts.clear()
    for (const attempt of this.pending.values()) { attempt.controller.abort(); this.dispose(attempt) }
  }
}
