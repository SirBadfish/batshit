import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModelV4 } from '@ai-sdk/provider'
import { ChatgptPlanError, type ChatgptPlanVault, type PlanRegistration, type PlanTokens } from './chatgptPlanVault'
import { ChatgptPlanOAuth, PlanRenewalError } from './chatgptPlanOAuth'
import { batshitProviderHeaders } from './providers/batshitIdentity'

// Identity-only capabilities, passed by the owning server call site. A model,
// browser or service-token body cannot create one by supplying a purpose word.
export const PLAN_AGENT = Symbol('ChatGPT text-agent request')
export const PLAN_COMPACT = Symbol('ChatGPT Compact request')
export const PLAN_CATALOG = Symbol('ChatGPT account catalog')
type PlanPurpose = typeof PLAN_AGENT | typeof PLAN_COMPACT | typeof PLAN_CATALOG
export type PlanLease = {
  readonly accountId: string; readonly userId: string; readonly binding: string; readonly signal: AbortSignal
  readonly purpose: PlanPurpose; release(): void
}
type OwnedLease = PlanLease & { controller: AbortController; done: Promise<void> }
type RefreshFlight = { promise: Promise<PlanTokens>; uncertain: boolean; staleRevocation?: boolean }
export type PlanModel = { slug: string; displayName: string }
const UNSUPPORTED = ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id']

export function assertPlanWireBody(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ChatgptPlanError('request_unsupported', 'ChatGPT plan request is invalid.')
  const record = body as Record<string, unknown>
  const unsupported = UNSUPPORTED.find(key => key in record)
  if (record.stream !== true || record.store !== false || unsupported) throw new ChatgptPlanError('request_unsupported', unsupported ? `ChatGPT plan does not support ${unsupported}. Clear that preset setting.` : 'ChatGPT plan requires streaming with response storage off.')
  if (Array.isArray(record.input) && record.input.some(item => item?.role === 'system')) throw new ChatgptPlanError('request_unsupported', 'ChatGPT plan requires the developer instruction role.')
  if (Array.isArray(record.tools) && record.tools.some(item => item?.type !== 'namespace' || !Array.isArray(item.tools) || item.tools.some((tool: { type?: string }) => tool.type !== 'function' && tool.type !== 'custom'))) {
    throw new ChatgptPlanError('tool_unsupported', 'This ChatGPT plan connection supports Batshit client tools. OpenAI hosted tools are unavailable.')
  }
}

/** All leases are owned until their caller's actual finally, including writes. */
export class ChatgptPlanRuntime {
  private leases = new Set<OwnedLease>()
  private refreshes = new Map<string, RefreshFlight>()
  private closing = false
  private poisonedBindings = new Set<string>()
  private disconnecting = new Set<string>()
  constructor(readonly vault: ChatgptPlanVault, readonly oauth: ChatgptPlanOAuth, private http: typeof fetch = fetch) {}

  acquire(userId: string, accountId: string, purpose: PlanPurpose, stop?: AbortSignal, expectedBinding?: string): PlanLease {
    if (![PLAN_AGENT, PLAN_COMPACT, PLAN_CATALOG].includes(purpose)) throw new ChatgptPlanError('consumer_unsupported', 'This feature cannot use ChatGPT plan credentials.')
    if (this.closing || stop?.aborted) throw new ChatgptPlanError('request_stopped', 'This request was stopped before ChatGPT inference began.')
    const row = this.vault.get(userId, accountId), binding = this.vault.binding(row)
    if (this.disconnecting.has(accountId)) throw new ChatgptPlanError('account_changed', 'This ChatGPT account is disconnecting. Start a new turn after reconnecting.')
    if (this.poisonedBindings.has(binding)) throw new ChatgptPlanError('reconnect_required', 'ChatGPT credential persistence failed. Disconnect and reconnect this account.')
    if (row.state !== 'ready') throw new ChatgptPlanError('reconnect_required', 'Continue with ChatGPT in API Keys to enable or reconnect plan use.')
    if (expectedBinding !== undefined && expectedBinding !== binding) throw new ChatgptPlanError('account_changed', 'This paused reply belongs to a different ChatGPT session. Start a new turn.')
    const controller = new AbortController()
    let resolveDone!: () => void
    const done = new Promise<void>(resolve => { resolveDone = resolve })
    const lease: OwnedLease = { userId, accountId, binding, purpose, controller, done,
      signal: stop ? AbortSignal.any([controller.signal, stop]) : controller.signal,
      release: () => { this.leases.delete(lease); resolveDone() } }
    this.leases.add(lease)
    return lease
  }
  assertLease(lease: PlanLease) {
    if (![...this.leases].includes(lease as OwnedLease) || lease.signal.aborted || this.closing) throw new ChatgptPlanError('request_stopped', 'ChatGPT request was stopped.')
    if (this.disconnecting.has(lease.accountId)) throw new ChatgptPlanError('account_changed', 'This ChatGPT account is disconnecting.')
    const row = this.vault.get(lease.userId, lease.accountId)
    if (this.poisonedBindings.has(lease.binding)) throw new ChatgptPlanError('reconnect_required', 'ChatGPT credential persistence failed. Disconnect and reconnect this account.')
    if (row.state !== 'ready' || this.vault.binding(row) !== lease.binding) throw new ChatgptPlanError('account_changed', 'The ChatGPT connection changed. Start a new turn.')
    return row
  }
  /**
   * Check at the actual mutation boundary, then hold the vault incarnation over
   * every awaited Redis write. Disconnect blocks new owners synchronously and
   * drains already-dispatched writes BEFORE durably invalidating the account.
   */
  async mutate<T>(lease: PlanLease, write: () => Promise<T>): Promise<T> {
    if (lease.purpose !== PLAN_AGENT) throw new ChatgptPlanError('consumer_unsupported', 'This ChatGPT lease cannot save tool consent.')
    this.assertLease(lease)
    const release = this.vault.holdMutation(lease.userId, lease.accountId, lease.binding)
    try { return await write() } finally { release() }
  }
  private async bearer(lease: PlanLease): Promise<string> {
    this.assertLease(lease)
    let flight = this.refreshes.get(lease.accountId)
    if (!flight) {
      const current = this.vault.tokens(lease.userId, lease.accountId, lease.binding)
      if (current.expiresAt > Date.now() + 60_000) return current.accessToken
      const refresh = this.vault.beginRefresh(lease.userId, lease.accountId, lease.binding)
      flight = { uncertain: false, promise: Promise.resolve(current) }
      const owned = flight
      owned.promise = (async () => {
        let tokens: PlanTokens
        try { tokens = await this.oauth.refresh(refresh.registration, refresh.tokens, AbortSignal.timeout(30_000)) } catch (error) {
          owned.uncertain = !(error instanceof PlanRenewalError && error.cleanupConfirmed)
          this.poisonedBindings.add(lease.binding)
          await this.vault.drainMutations(lease.accountId)
          try { this.vault.invalidateRenewal(refresh.registration) } catch { owned.uncertain = true }
          throw error instanceof PlanRenewalError ? error : new ChatgptPlanError('reconnect_required', 'ChatGPT renewal could not be confirmed. Continue with ChatGPT again in API Keys.')
        }
        let persisted = false
        try { persisted = this.vault.finishRefresh(refresh.registration, tokens) } catch {
          this.poisonedBindings.add(lease.binding)
          owned.staleRevocation = await this.oauth.revoke(refresh.registration, tokens.refreshToken)
          owned.uncertain = !owned.staleRevocation
          await this.vault.drainMutations(lease.accountId)
          try { this.vault.invalidateRenewal(refresh.registration) } catch { owned.uncertain = true }
          if (owned.uncertain) { try { this.vault.recordUnconfirmedCleanup(lease.userId) } catch { /* The poisoned binding still blocks admission. */ } }
          throw new PlanRenewalError(!owned.uncertain)
        }
        if (!persisted) {
          // Sign-out/reconnect fenced this response. A rotated replacement
          // still needs revocation; never discard it and revoke only its stale
          // predecessor while claiming the renewable session ended.
          owned.staleRevocation = await this.oauth.revoke(refresh.registration, tokens.refreshToken)
          if (!owned.staleRevocation) this.vault.recordUnconfirmedCleanup(lease.userId)
          throw new ChatgptPlanError('account_changed', 'The ChatGPT connection changed during renewal.')
        }
        return tokens
      })().finally(() => { if (this.refreshes.get(lease.accountId) === owned) this.refreshes.delete(lease.accountId) })
      this.refreshes.set(lease.accountId, owned)
    }
    const tokens = await flight.promise
    this.assertLease(lease) // Stop during shared renewal forbids this caller's late start.
    return tokens.accessToken
  }
  async models(lease: PlanLease): Promise<PlanModel[]> {
    if (lease.purpose !== PLAN_CATALOG && lease.purpose !== PLAN_AGENT && lease.purpose !== PLAN_COMPACT) throw new ChatgptPlanError('consumer_unsupported', 'ChatGPT catalog is unavailable here.')
    const bearer = await this.bearer(lease)
    const response = await this.safeFetch('https://api.openai.com/v1/models', { headers: { ...batshitProviderHeaders(), Authorization: `Bearer ${bearer}` }, signal: AbortSignal.any([lease.signal, AbortSignal.timeout(30_000)]) })
    let value: { models?: { slug?: unknown; display_name?: unknown; visibility?: unknown }[] }
    try { value = await response.json() } catch { throw new ChatgptPlanError('catalog_invalid', 'ChatGPT returned an unreadable account model list.') }
    if (!Array.isArray(value.models) || value.models.some(row => !row || typeof row.slug !== 'string' || typeof row.display_name !== 'string')) throw new ChatgptPlanError('catalog_invalid', 'ChatGPT returned an unreadable account model list.')
    this.assertLease(lease)
    return value.models.filter(row => row.visibility === 'list').map(row => ({ slug: row.slug as string, displayName: row.display_name as string }))
  }
  private async safeFetch(url: string, init: RequestInit): Promise<Response> {
    let response: Response
    try { response = await this.http(url, { ...init, redirect: 'error' }) } catch {
      if (init.signal?.aborted) throw new ChatgptPlanError('request_stopped', 'ChatGPT request was stopped.')
      throw new ChatgptPlanError('upstream_unavailable', 'ChatGPT could not complete this request. Retry deliberately after checking the connection.')
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new ChatgptPlanError(response.status === 429 ? 'usage_limit' : 'inference_refused', response.status === 429 ? 'ChatGPT usage limit reached. Manage your plan or app limit at https://chatgpt.com/settings/usage.' : 'ChatGPT refused this request. Check the connection and supported preset settings. No API-key fallback was used.')
    }
    return response
  }
  model(lease: PlanLease, slug: string): LanguageModelV4 {
    this.assertLease(lease)
    if (lease.purpose === PLAN_CATALOG) throw new ChatgptPlanError('consumer_unsupported', 'Catalog access does not authorize inference.')
    const provider = createOpenAI({ apiKey: 'managed-chatgpt-plan', headers: batshitProviderHeaders(), fetch: async (input, init) => {
      if (String(input) !== 'https://api.openai.com/v1/responses' || init?.method !== 'POST') throw new ChatgptPlanError('endpoint_unsupported', 'This ChatGPT plan endpoint is not supported.')
      let body: unknown
      try { body = JSON.parse(String(init.body)) } catch { throw new ChatgptPlanError('request_unsupported', 'ChatGPT request body is invalid.') }
      assertPlanWireBody(body)
      const token = await this.bearer(lease)
      const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${token}`)
      this.assertLease(lease)
      return this.safeFetch(String(input), { ...init, headers, signal: init.signal ? AbortSignal.any([lease.signal, init.signal]) : lease.signal })
    } })
    const model = provider.responses(slug)
    return { specificationVersion: 'v4', provider: model.provider, modelId: model.modelId, supportedUrls: model.supportedUrls,
      doGenerate: async () => { throw new ChatgptPlanError('stream_required', 'ChatGPT plan supports streaming requests only.') },
      doStream: async options => {
        this.assertLease(lease)
        let result: Awaited<ReturnType<typeof model.doStream>>
        try { result = await model.doStream({ ...options, includeRawChunks: true }) } catch (error) {
          throw error instanceof ChatgptPlanError ? error : new ChatgptPlanError('inference_failed', 'ChatGPT could not start this reply. No API-key fallback was used.')
        }
        let completed = false
        const reader = result.stream.getReader()
        // Own the reader boundary as well as emitted error parts. Raw provider
        // events are private completion evidence, never an outward error lane.
        const stream = new ReadableStream<Awaited<ReturnType<typeof reader.read>>['value']>({
          async pull(controller) {
            try {
              while (true) {
                const next = await reader.read()
                if (next.done) {
                  if (!completed) throw new ChatgptPlanError('response_incomplete', 'ChatGPT ended without a completed response. Partial text was preserved; this reply did not complete.')
                  controller.close(); reader.releaseLock(); return
                }
                const part = next.value!
                if (part.type === 'raw') { if ((part.rawValue as { type?: string })?.type === 'response.completed') completed = true; continue }
                if (part.type === 'error') {
                  controller.enqueue({ type: 'error', error: new ChatgptPlanError('inference_failed', 'ChatGPT inference failed. Partial text was preserved; this reply did not complete.') }); return
                }
                if (part.type === 'finish' && !completed) throw new ChatgptPlanError('response_incomplete', 'ChatGPT ended without a completed response. Partial text was preserved; this reply did not complete.')
                controller.enqueue(part); return
              }
            } catch (error) {
              controller.error(error instanceof ChatgptPlanError ? error : new ChatgptPlanError('inference_failed', 'ChatGPT inference failed. Partial text was preserved; this reply did not complete.'))
              await reader.cancel().catch(() => undefined); reader.releaseLock()
            }
          },
          async cancel(reason) { await reader.cancel(reason); reader.releaseLock() }
        })
        return { ...result, stream: stream as typeof result.stream }
      }
    }
  }
  async disconnect(userId: string, accountId: string) {
    this.vault.get(userId, accountId) // Establish owner before fencing an account id.
    this.disconnecting.add(accountId)
    const flight = this.refreshes.get(accountId)
    this.oauth.cancel(userId)
    const owned = [...this.leases].filter(lease => lease.userId === userId && lease.accountId === accountId)
    for (const lease of owned) lease.controller.abort('chatgpt_disconnected')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (this.vault.hasMutations(accountId)) {
        await Promise.race([this.vault.drainMutations(accountId), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ChatgptPlanError('requests_stopping', 'An approval save is still finishing. ChatGPT admission is blocked; retry Disconnect after it settles.')), 30_000) })])
        if (timer) { clearTimeout(timer); timer = undefined }
      }
      const disconnected = this.vault.disconnect(userId, accountId)
      let drainError: unknown
      try { await Promise.race([Promise.all(owned.map(lease => lease.done)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ChatgptPlanError('requests_stopping', 'ChatGPT was disconnected locally, but a request has not finished stopping.')), 30_000) })]) } catch (error) { drainError = error }
      if (flight) await flight.promise.catch(() => undefined)
      const revoked = disconnected.refreshToken ? await this.oauth.revoke(disconnected.registration, disconnected.refreshToken) : false
      const confirmed = revoked && !flight?.uncertain && flight?.staleRevocation !== false
      this.vault.finishRevocation(disconnected.registration, confirmed)
      if (drainError) throw drainError
      return { remoteRevocation: confirmed ? 'confirmed' as const : 'unconfirmed' as const }
    } finally { if (timer) clearTimeout(timer); if (!this.vault.hasMutations(accountId)) this.disconnecting.delete(accountId) }
  }
  async close() {
    this.closing = true; this.oauth.close()
    for (const lease of this.leases) lease.controller.abort('runtime_shutdown')
    // One reporting deadline covers the entire drain. A refresh may itself be
    // awaiting a dispatched consent save; it cannot precede the deadline.
    const drain = Promise.all([
      Promise.allSettled([...this.refreshes.values()].map(flight => flight.promise)),
      Promise.all([...this.leases].map(lease => lease.done)),
    ])
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([drain, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ChatgptPlanError('requests_stopping', 'ChatGPT requests have not finished shutting down.')), 30_000) })]) } finally { if (timer) clearTimeout(timer) }
    this.vault.close()
  }
}
