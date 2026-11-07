vi.unmock('ai')
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeModeRequest } from '../vercelBrain'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { prepareP5OriginalTask, refreshP5OriginalRequest, p5OriginalRequestForPreparation } from '../appActions/mcp/originalTask'
import { persistCanonicalReply } from '../replyStreamRecord'
import * as originalTaskOwner from '../appActions/mcp/originalTask'
import { registerSessionTurn, releaseSessionTurn, stopSessionTurn } from '../streamAbortRegistry'
import { answerApprovalsOnce } from '../approvalAnswerRecord'
import { settingsOperationRegistry } from '../appActions/settings/managementRuntime'
import { MCP_CONFIGURATION_ID, MCP_CONFIGURATION_EFFECTS, MCP_CONFIGURATION_STAGES, mcpConfigurationEffects, type McpConfigurationReview } from '$lib/appActions/settings/mcpConfiguration'
import { endLiveOwnedCommandGroups } from '../ownedCommandGroup'

// App Actions P5 original-task custody for API Primaries: the genuine in-process
// API arm through the real registration/lifecycle, canonical save, approval and
// SDK owners. Redis replies, files, provider and process observations are
// synthetic. No normal home/auth/system file, OS/vendor process or Redis wire is read.
const mock = vi.hoisted(() => ({
  open: vi.fn(), stat: vi.fn(), lstat: vi.fn(), realpath: vi.fn(), lstatSync: vi.fn(), closeSync: vi.fn()
}))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const promises = { ...actual.promises,
    open: mock.open, stat: mock.stat, lstat: mock.lstat, realpath: mock.realpath }
  factoryOwners.actualLstatSync = actual.lstatSync
  factoryOwners.actualCloseSync = actual.closeSync
  return { ...actual, lstatSync: mock.lstatSync, closeSync: mock.closeSync, promises,
    default: { ...((actual as any).default ?? actual), lstatSync: mock.lstatSync, closeSync: mock.closeSync, promises } }
})
const factoryOwners = vi.hoisted(() => ({ records: new Map<string, Record<string, unknown>>(),
  save: vi.fn(), execute: vi.fn(), actualLstatSync: null as any,
  jsonSet: vi.fn(), expire: vi.fn(), updateMessage: vi.fn(), session: vi.fn(), messages: vi.fn(), actualCloseSync: null as any,
  credentialIndexes: new Map<string, Set<string>>(),
  mintGate: null as null | { entered(): void; wait: Promise<void> },
  actualHome: '', guardianSpawn: vi.fn(), table: vi.fn() }))
vi.mock('node:os', async original => {
  const actual = await original<typeof import('node:os')>()
  const homedir = () => factoryOwners.actualHome || '/synthetic/no-original-home'
  return { ...actual, homedir, default: { ...actual, homedir } }
})
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  const spawn = (...args: unknown[]) => factoryOwners.guardianSpawn(...args)
  // CJS interop may resolve named builtin imports through default as well.
  return { ...actual, spawn, default: { ...((actual as any).default ?? actual), spawn } }
})
vi.mock('$lib/server/redis', () => ({ redis: { json: { get: vi.fn(async (key: string) => factoryOwners.records.get(key) ?? null),
  set: (...args: unknown[]) => factoryOwners.jsonSet(...args) },
  get: async (key: string) => factoryOwners.records.get(key) ?? null,
  del: async (key: string) => factoryOwners.records.delete(key) ? 1 : 0,
  expire: (...args: unknown[]) => factoryOwners.expire(...args), getSession: (...args: unknown[]) => factoryOwners.session(...args),
  getRecentMessages: (...args: unknown[]) => factoryOwners.messages(...args), updateMessage: (...args: unknown[]) => factoryOwners.updateMessage(...args),
  saveMessage: (...args: unknown[]) => factoryOwners.save(...args), execute: (...args: unknown[]) => factoryOwners.execute(...args) } }))
vi.mock('../hostProcessIdentity', () => ({
  readHostBootIdentity: async () => ({ bootId: 'synthetic-custody-boot', namespaceId: 'host' }),
  readHostProcessTable: (...args: unknown[]) => factoryOwners.table(...args)
}))
const epoch = 1_800_000_000_000
const missing = () => Object.assign(new Error('synthetic missing'), { code: 'ENOENT' })
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
  vi.clearAllMocks()
  mock.closeSync.mockReset().mockImplementation((fd: number) => factoryOwners.actualCloseSync(fd))
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' })
  vi.spyOn(Date, 'now').mockReturnValue(epoch)
  mock.realpath.mockImplementation(async value => value)
  mock.stat.mockResolvedValue({ isDirectory: () => true })
  mock.lstat.mockRejectedValue(missing())
  mock.open.mockRejectedValue(missing())
  mock.lstatSync.mockImplementation(() => { throw missing() })
})
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, 'platform', platformDescriptor) })

describe('App Actions P5 original-task custody for API Primaries', () => {
  const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch')!
  let root: string, previousRuntime: string | undefined, previousInstalls: string | undefined, previousRecords: string | undefined
  const disposals: Array<() => Promise<void>> = []
  beforeEach(async () => {
    Object.defineProperty(process, 'arch', { ...archDescriptor, value: 'arm64' })
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'batshit-api-custody-')))
    previousRuntime = process.env.BATSHIT_AGENT_RUNTIME_ROOT
    previousInstalls = process.env.BATSHIT_MANAGED_INSTALLS_ROOT
    previousRecords = process.env.BATSHIT_COMMAND_RECORDS_DIR
    process.env.BATSHIT_AGENT_RUNTIME_ROOT = root
    process.env.BATSHIT_MANAGED_INSTALLS_ROOT = path.join(root, 'installs')
    factoryOwners.records.clear()
    factoryOwners.credentialIndexes.clear()
    factoryOwners.mintGate = null
    factoryOwners.actualHome = root
    factoryOwners.table.mockReset().mockImplementation(async () => new Map([[process.pid, { pid: process.pid, parent: 1, group: process.pid,
      started: 'synthetic-test-owner', state: 'S', program: 'node' }]]))
    factoryOwners.guardianSpawn.mockReset().mockImplementation(() => { throw new Error('No native/vendor/OS process is admitted in this synthetic owner fixture.') })
    factoryOwners.execute.mockReset().mockRejectedValue(new Error('No physical Redis command is admitted in this fixture.'))
    factoryOwners.save.mockImplementation(async (message: Record<string, unknown>) => {
      factoryOwners.records.set(`message:${message.session_id}:${message.id}`, structuredClone(message))
    })
    mock.lstatSync.mockImplementation((file: string, options?: unknown) => {
      const installsRoot = path.join(root, 'installs')
      if (file === installsRoot || String(file).startsWith(installsRoot + path.sep)) return factoryOwners.actualLstatSync(file, options)
      throw missing()
    })
  })
  afterEach(async () => {
    // Settle exact live test-owned handles before restoring/deleting their ledger.
    await endLiveOwnedCommandGroups()
    for (const dispose of disposals.splice(0).reverse()) await dispose()
    if (previousRuntime === undefined) delete process.env.BATSHIT_AGENT_RUNTIME_ROOT
    else process.env.BATSHIT_AGENT_RUNTIME_ROOT = previousRuntime
    if (previousInstalls === undefined) delete process.env.BATSHIT_MANAGED_INSTALLS_ROOT
    else process.env.BATSHIT_MANAGED_INSTALLS_ROOT = previousInstalls
    if (previousRecords === undefined) delete process.env.BATSHIT_COMMAND_RECORDS_DIR
    else process.env.BATSHIT_COMMAND_RECORDS_DIR = previousRecords
    Object.defineProperty(process, 'arch', archDescriptor)
    factoryOwners.actualHome = ''
    await rm(root, { recursive: true, force: true })
  })
  /** Extend the EXISTING controlled physical-reply fixture for the new consent
   * consumers. These are synthetic Redis replies, not Redis/Lua qualification. */
  function approvalReplies() {
    const get = async (key: string) => factoryOwners.records.get(key) ?? null
    factoryOwners.jsonSet.mockImplementation(async (key: string, pointer: string, value: unknown) => {
      if (pointer === '$') factoryOwners.records.set(key, structuredClone(value) as Record<string, unknown>)
      else {
        const row = factoryOwners.records.get(key), field = /^\$\.([a-zA-Z]+)$/.exec(pointer)?.[1]
        if (!row || !field) throw new Error('ERR Path does not exist')
        row[field] = structuredClone(value)
      }
      return 'OK'
    })
    factoryOwners.expire.mockResolvedValue(true)
    factoryOwners.session.mockImplementation((id: string) => get(`session:${id}`))
    factoryOwners.messages.mockResolvedValue([{ role: 'user', content: 'Original human task.', metadata: {} }])
    factoryOwners.updateMessage.mockImplementation(async (id: string, sessionId: string, fields: Record<string, unknown>, userId: string) => {
      const row = factoryOwners.records.get(`message:${sessionId}:${id}`)
      if (!row || row.user_id !== userId) throw new Error('wrong saved owner')
      Object.assign(row, structuredClone(fields))
    })
    const client = { ...credentialReplyClient(), json: { get, set: (...args: unknown[]) => factoryOwners.jsonSet(...args) }, zAdd: async () => 1, zRange: async () => [], exists: async (key: string) => factoryOwners.records.has(key) ? 1 : 0 }
    factoryOwners.execute.mockImplementation(async operation => operation(client))
  }
  function credentialReplyClient() {
    const members = (key: string) => {
      let set = factoryOwners.credentialIndexes.get(key)
      if (!set) { set = new Set<string>(); factoryOwners.credentialIndexes.set(key, set) }
      return set
    }
    return { sMembers: async (key: string) => [...members(key)],
      sAdd: async (key: string, values: string[] | string) => {
        const set = members(key), before = set.size
        for (const value of Array.isArray(values) ? values : [values]) set.add(value)
        const gate = factoryOwners.mintGate
        if (gate) { factoryOwners.mintGate = null; gate.entered(); await gate.wait }
        return set.size - before
      }, sRem: async (key: string, values: string[] | string) => {
        let removed = 0
        for (const value of Array.isArray(values) ? values : [values]) if (members(key).delete(value)) removed++
        return removed
      } }
  }
  // API uses the SAME real registration/lifecycle and canonical save owners.
  // Only Redis/file/provider observations remain this owner's existing fakes.
  function apiPreparedFixture(scope: readonly string[] = ['A']) {
    factoryOwners.save.mockClear(); factoryOwners.execute.mockClear()
    const identity = { userId: 'api-custody-user', agentId: 'api-custody-primary', sessionId: 'api-custody-session' }
    const record = { id: identity.agentId, user_id: identity.userId, agentType: 'api', created_at: 'api-custody-incarnation' }
    factoryOwners.records.set(`agent:${identity.agentId}`, record)
    const stop = new AbortController()
    const lookup = originalTaskOwner.captureP5OriginalLookup({ ...identity, signal: stop.signal })!
    const registration = registerSessionTurn(identity.sessionId, 'single', 'api-reply-one')
    if (!registration.ok) throw new Error('API registration refused')
    let preparation: ReturnType<typeof prepareP5OriginalTask>
    disposals.push(async () => {
      if (preparation) { await originalTaskOwner.sealP5OriginalPreparation(preparation); originalTaskOwner.retireP5OriginalPreparation(preparation) }
      releaseSessionTurn(identity.sessionId, registration.entry.turnId)
    })
    preparation = prepareP5OriginalTask(lookup, { ...identity, session: { id: identity.sessionId, user_id: identity.userId }, agent: record, turn: registration.entry })!
    originalTaskOwner.recordP5ResolvedApiScope(preparation, { gateways: scope, tools: [], authority: { humanSelection: true } })
    const part = originalTaskOwner.bindP5ApiReplyPart(preparation, { replyId: 'api-reply-one', version: 0 })!
    originalTaskOwner.recordP5ApiRequestView(preparation, { request: 'Configure the tool, then answer the original question.', history: [] })
    const message = (id = 'api-reply-one', content = 'Saved first part.') => ({ id, role: 'assistant', user_id: identity.userId,
      agent_id: identity.agentId, session_id: identity.sessionId, content, metadata: {}, intermediateSteps: [] })
    return { identity, record, stop, preparation, part, registration, message }
  }

  function apiFixture(scope: readonly string[] = ['A']) {
    const prepared = apiPreparedFixture(scope)
    const run = originalTaskOwner.associateP5ApiOriginalRun(prepared.preparation, prepared.part, { ...prepared.identity, replyId: 'api-reply-one', signal: prepared.stop.signal })!
    return { ...prepared, run }
  }

  // SA-139 R4: only an in-process API turn is a native actor, so a managed (`agent`) caller is
  // refused as no native actor at all; an in-process caller with no API owner keeps its own code.
  it.each([['managed', 'NATIVE_ACTOR_REQUIRED'], ['no-api-owner', 'MCP_PREREQUISITE_API_REQUIRED']] as const)('keeps full MCP setup unavailable to %s callers before a physical store or client', async (lane, code) => {
    const api = apiPreparedFixture([])
    const turns = await import('../streamAbortRegistry')
    const reports = await import('../appActions/mcp/gatewayReport')
    const { managedSettingsStore } = await import('../appActions/settings/managedStore')
    turns.registerStreamAbort(api.identity.sessionId, 'api-reply-one', api.stop)
    factoryOwners.execute.mockClear()
    try {
      const context = { ...api.identity, messageId: 'api-reply-one', actorType: lane === 'managed' ? 'agent' : 'in-process', abortSignal: api.stop.signal,
        originatingReply: { sessionId: api.identity.sessionId, messageId: 'api-reply-one' } }
      await expect(reports.captureMcpGatewayReport({ id: `asr_${settingsOperationRegistry.boot}_mcp_${'9'.repeat(32)}`, boot: settingsOperationRegistry.boot,
        context, lane: 'native', detail: 'summary', store: managedSettingsStore,
        query: { kind: 'prerequisite', target: { subject: { kind: 'primary', id: api.identity.agentId }, gatewayId: 'C', membership: 'disable' } } })).rejects.toMatchObject({ code })
      expect(factoryOwners.execute).not.toHaveBeenCalled()
      expect(originalTaskOwner.p5ApiPreparedGatewayFrontier(api.preparation)).toEqual([])
    } finally { turns.clearStreamAbort(api.identity.sessionId, 'api-reply-one') }
  })

  it('uses only a nonawaiting restrictive API pause, never a verified continuation from pending/save-only data', async () => {
    const api = apiFixture()
    expect(originalTaskOwner.p5ApiRunMustPause(api.run)).toBe(false)
    originalTaskOwner.recordP5ApiManagementIntent(api.run)
    // This is a restrictive pre-issue reservation, not a saved/verified test certificate.
    const ticket = originalTaskOwner.captureP5ApiManagement({ ...api.identity, messageId: 'api-reply-one', actorType: 'in-process', p5ApiRun: api.run }, 'C', { operationId: 'pending-operation', requestId: 'pending-request' })!
    expect(ticket).toBeDefined()
    expect(originalTaskOwner.p5ApiRunMustPause(api.run)).toBe(true)
    expect(originalTaskOwner.p5ApiRunMustPause(api.run)).not.toBeInstanceOf(Promise)
    await expect(originalTaskOwner.takeP5ApiVerifiedContinuation(api.preparation!)).resolves.toBeUndefined()
    await persistCanonicalReply(api.message(), api.preparation, api.part)
    await refreshP5OriginalRequest(p5OriginalRequestForPreparation(api.preparation)!)
    expect(originalTaskOwner.p5CanonicalReplySealed(api.preparation, 'api-reply-one', api.part)).toBe(true)
    const next = originalTaskOwner.bindP5ApiReplyPart(api.preparation, { replyId: 'api-unissued-child', version: 0 })!
    expect(() => originalTaskOwner.associateP5ApiOriginalRun(api.preparation, next, {
      ...api.identity, replyId: 'api-unissued-child', signal: api.stop.signal
    })).toThrow() // unknown/unconsumed SDK work plus save-only pause cannot issue a child
    expect(factoryOwners.save).toHaveBeenCalledOnce()
    expect(factoryOwners.execute).not.toHaveBeenCalled()
  })

  it('does not let newly saved defaults B enter original API A or explicit empty scope', () => {
    const api = apiFixture([])
    expect(originalTaskOwner.p5ApiPreparedScope(api.preparation)?.gateways).toEqual([])
    expect(() => originalTaskOwner.recordP5ResolvedApiScope(api.preparation, { gateways: ['B'], tools: [] })).toThrow()
    expect(originalTaskOwner.p5ApiPreparedGatewayFrontier(api.preparation)).toEqual([])
    expect(() => originalTaskOwner.readP5ApiMcpAuthority(api.run, 'B')).toThrow()
  })

  it('keys actual API canonical ACKs by server part, so an old same-ID late write cannot seal a new part', async () => {
    const api = apiFixture()
    await persistCanonicalReply(api.message(), api.preparation, api.part)
    await refreshP5OriginalRequest(p5OriginalRequestForPreparation(api.preparation)!)
    expect(originalTaskOwner.p5CanonicalReplySealed(api.preparation, 'api-reply-one', api.part)).toBe(true)
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    factoryOwners.save.mockImplementationOnce(async () => { await hold })
    const oldWrite = persistCanonicalReply(api.message('api-reply-one', 'Late old-part enrichment.'), api.preparation, api.part)
    const { createApprovalResumeStart } = await import('../approvalResumeMessage')
    const start = createApprovalResumeStart({ content: 'Saved first part.', metadata: {} }, epoch + 1)
    // Server part DATA is not a successor run/approval grant.
    const next = originalTaskOwner.bindP5ApiReplyPart(api.preparation, { replyId: 'api-reply-one', version: start.version })!
    expect(originalTaskOwner.p5CanonicalReplySealed(api.preparation, 'api-reply-one', next)).toBe(false)
    release(); await oldWrite; await refreshP5OriginalRequest(p5OriginalRequestForPreparation(api.preparation)!)
    expect(originalTaskOwner.p5CanonicalReplySealed(api.preparation, 'api-reply-one', next)).toBe(false)
    await persistCanonicalReply(api.message('api-reply-one', 'Saved first part. Continued.'), api.preparation, next)
    await refreshP5OriginalRequest(p5OriginalRequestForPreparation(api.preparation)!)
    expect(originalTaskOwner.p5CanonicalReplySealed(api.preparation, 'api-reply-one', next)).toBe(true)
  })

  it('preserves the real save rejection and never manufactures an API canonical or continuation receipt', async () => {
    const api = apiFixture(), failure = new Error('synthetic API canonical write rejected')
    factoryOwners.save.mockRejectedValueOnce(failure)
    await expect(persistCanonicalReply(api.message(), api.preparation, api.part)).rejects.toBe(failure)
    expect(originalTaskOwner.p5CanonicalReplySealed(api.preparation, 'api-reply-one', api.part)).toBe(false)
    await expect(originalTaskOwner.takeP5ApiVerifiedContinuation(api.preparation!)).rejects.toThrow()
  })

  it('ends API issuance at actual Stop but still observes a late mandatory canonical save', async () => {
    const api = apiFixture()
    expect(stopSessionTurn(api.identity.sessionId, 'actual owner Stop')).toBe(true)
    expect(() => originalTaskOwner.assertP5ApiRunCurrent(api.run)).toThrow()
    expect(originalTaskOwner.p5ApiRunMustPause(api.run)).toBe(true)
    await persistCanonicalReply(api.message(), api.preparation, api.part)
    await refreshP5OriginalRequest(p5OriginalRequestForPreparation(api.preparation)!)
    expect(originalTaskOwner.p5CanonicalReplySealed(api.preparation, 'api-reply-one', api.part)).toBe(true)
    await expect(originalTaskOwner.takeP5ApiVerifiedContinuation(api.preparation!)).rejects.toThrow()
  })

  it('builds management lineage from actual canonical part receipts, without fake failure/approval metadata or same-ID duplication', async () => {
    const api = apiFixture()
    originalTaskOwner.recordP5ApiManagementIntent(api.run) // restrictive opt-in only
    await persistCanonicalReply(api.message(), api.preparation, api.part)
    const second = originalTaskOwner.bindP5ApiReplyPart(api.preparation, { replyId: 'api-reply-two', version: 0 })!
    await persistCanonicalReply(api.message('api-reply-two', 'Verification remains unavailable.'), api.preparation, second)
    const final = originalTaskOwner.bindP5ApiReplyPart(api.preparation, { replyId: 'api-final', version: 0 })!
    const lineage = (await originalTaskOwner.captureP5ApiCanonicalLineage(api.preparation, final))!
    const { originalApiContinuationReplyTurn } = await import('../typesafe/jevJuiceTurn')
    const whole = await originalApiContinuationReplyTurn(lineage)
    expect(whole.request).toBe('Configure the tool, then answer the original question.')
    expect(whole.earlierParts.map(part => part.text)).toEqual(['Saved first part.', 'Verification remains unavailable.'])
    expect(whole.earlierParts).toHaveLength(2)
    await expect(Reflect.apply(originalApiContinuationReplyTurn, undefined, [Object.freeze({})])).rejects.toThrow()
    expect(api.message().metadata).not.toHaveProperty('response_failed')
  })

  it.each([true, false])('consumes a genuine tagged API %s answer/decision and lets the real SDK handle approval or denial once under original A', async approved => {
    const api = apiPreparedFixture(['A'])
    approvalReplies()
    factoryOwners.records.set(`session:${api.identity.sessionId}`, { id: api.identity.sessionId, user_id: api.identity.userId })
    const { VercelAIBrain, observeP5ApiConsumedStream } = await import('../vercelBrain')
    const { ProviderManager } = await import('../providers')
    const { nativeToolService } = await import('../nativeTools')
    const { attachControlApprovalRecords, resolveApprovalResumeGrants } = await import('../brokerControlApprovals')
    const { MockLanguageModelV3, convertArrayToReadableStream } = await import('ai/test')
    const { tool, jsonSchema } = await import('ai')
    const { createApprovalResumeStart } = await import('../approvalResumeMessage')
    const input = { op: 'change', requestId: `${settingsOperationRegistry.boot}:api-${approved ? 'approve' : 'deny'}`,
      reportId: `asr_${settingsOperationRegistry.boot}_mcp_${'2'.repeat(32)}`, semanticId: MCP_CONFIGURATION_ID,
      changes: { source: { candidateId: `mcpc_${'3'.repeat(32)}` } } }
    const review: McpConfigurationReview = { kind: 'mcp-configuration', planId: `mcpp_${'4'.repeat(32)}`, candidateId: `mcpc_${'3'.repeat(32)}`,
      mode: 'create', resource: { kind: 'mcp-gateway', gatewayId: 'C' }, before: null,
      after: { id: 'C', slug: 'controlled-c', name: 'Controlled C', type: 'custom', enabled: true, url: 'https://fixture.invalid/mcp' }, stages: [...MCP_CONFIGURATION_STAGES] }
    const effect = vi.fn(async () => [])
    const operation = settingsOperationRegistry.capture({ actor: { userId: api.identity.userId, kind: 'native', id: api.identity.agentId,
      sessionId: api.identity.sessionId, generation: 1, label: 'Controlled actual API recipe' }, requestId: input.requestId, input,
      preview: { semanticId: MCP_CONFIGURATION_ID, targets: [], excluded: [], effects: [...MCP_CONFIGURATION_EFFECTS], resource: review },
      resource: review.resource, permission: 'ask', preimages: { planId: review.planId, disclosure: review }, refresh: async () => {}, execute: effect })
    const brokerInput = { ref: 'fabric:sys.app_settings.native.change', input }
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } }
    let providerStep = 0, actualRun: Parameters<typeof originalTaskOwner.p5ApiRunMustPause>[0] | undefined
    let binding: ReturnType<typeof settingsOperationRegistry.bindP5ApiMcpOperation> | undefined
    const executedSdkTool = vi.fn(async () => ({ denied: false })) // No setup/effect/verified-C fact is supplied.
    const model = new MockLanguageModelV3({ provider: 'fixture', modelId: 'fixture-api', doStream: async () => {
      providerStep++
      return { stream: convertArrayToReadableStream<LanguageModelV3StreamPart>(providerStep === 1 ? [
        { type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'api-setup-call', toolName: 'native_batshit_tool_use', input: JSON.stringify(brokerInput) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage }
      ] : [
        { type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'api-final' }, { type: 'text-delta', id: 'api-final', delta: approved ? 'The approved call was handled.' : 'The denied call was not run.' },
        { type: 'text-end', id: 'api-final' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }
      ]) }
    } })
    const provider = vi.spyOn(ProviderManager, 'createForUser').mockResolvedValue({ getModel: () => model, listAvailableModels: () => [] } as any)
    const risk = vi.spyOn(nativeToolService, 'resolveBrokerRiskApprovalTarget').mockImplementation(async () => ({ ref: brokerInput.ref, family: 'fabric', controlId: 'sys.app_settings.native.change', controlTitle: 'Configure MCP',
      riskLevel: 'restricted', scopeKey: null, input, lane: 'api', settingsPreview: settingsOperationRegistry.nativeApprovalPreview(api.identity.userId, api.identity.agentId, api.identity.sessionId, input.requestId)!, p5ApiHeldRecipe: await binding }))
    const brain = new VercelAIBrain()
    ;(brain as any).buildToolsForMode3 = vi.fn(async () => {
      await binding
      return { tools: { native_batshit_tool_use: tool({ inputSchema: jsonSchema<Record<string, unknown>>({ type: 'object', additionalProperties: true }), execute: executedSdkTool }) },
        maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() }, toolApprovals: { native_batshit_tool_use: async () => 'user-approval' }, ephemeralImages: null, initialImageToolIds: [], imageDeferrals: [] }
    })
    let resume: ReturnType<typeof originalTaskOwner.prepareP5ApiApprovalResume> | undefined
    try {
      const initialMessages: NativeModeRequest['messages'] = [{ role: 'system', content: 'Controlled actual API instructions.' }, { role: 'user', content: 'Configure the tool, then answer the original question.' }]
      const first = await brain.streamNativeMode({ ...api.identity, messageId: 'api-reply-one', model: 'fixture-api', messages: initialMessages,
        abortSignal: api.stop.signal, mcpOriginalPreparation: api.preparation, mcpApiPart: api.part, onP5ApiRun(run) {
          actualRun = run; binding = settingsOperationRegistry.bindP5ApiMcpOperation({ ...api.identity, messageId: 'api-reply-one', actorType: 'in-process', p5ApiRun: run }, input)
        } })
      const emitted: any[] = []
      for await (const event of first.stream) emitted.push(event)
      observeP5ApiConsumedStream(first)
      const request = emitted.find(event => event.type === 'tool-approval-request')
      expect(request?.toolCall?.toolCallId).toBe('api-setup-call')
      const entries = await attachControlApprovalRecords({ ...api.identity, messageId: 'api-reply-one', p5ApiRun: actualRun!, abortSignal: api.stop.signal,
        approvals: [{ approvalId: request.approvalId, toolName: request.toolCall.toolName, toolCall: request.toolCall, input: brokerInput, status: 'pending', requestedAt: new Date().toISOString() }] })
      expect(entries[0].control?.approvalId).toMatch(/^apr_/)
      await persistCanonicalReply({ ...api.message('api-reply-one', ''), metadata: { toolApprovals: { source: 'vercel', mode: 'all', approvals: entries } } }, api.preparation, api.part)
      await originalTaskOwner.sealP5OriginalPreparation(api.preparation); originalTaskOwner.retireP5OriginalPreparation(api.preparation)
      releaseSessionTurn(api.identity.sessionId, api.registration.entry.turnId)
      const next = registerSessionTurn(api.identity.sessionId, 'single', 'api-reply-one', { answersApproval: true })
      if (!next.ok) throw new Error('The actual resumed turn was unavailable.')
      disposals.push(async () => { if (resume) { await originalTaskOwner.sealP5OriginalPreparation(resume); originalTaskOwner.retireP5OriginalPreparation(resume) }; releaseSessionTurn(api.identity.sessionId, next.entry.turnId) })
      const responses = [{ approvalId: request.approvalId, approved }]
      const pending = (await originalTaskOwner.pendingP5ApiApproval({ ...api.identity, session: { id: api.identity.sessionId, user_id: api.identity.userId }, agent: api.record,
        turn: next.entry, messageId: 'api-reply-one', responses }))!
      expect(pending).toBeDefined()
      const answer = await answerApprovalsOnce({ ...api.identity, messageId: 'api-reply-one', responses })
      expect(answer).toMatchObject({ ok: true, recorded: true })
      resume = originalTaskOwner.prepareP5ApiApprovalResume({ ...api.identity, session: { id: api.identity.sessionId, user_id: api.identity.userId }, agent: api.record,
        turn: next.entry, signal: next.entry.stop.signal, pending, answer })

      const grants = await resolveApprovalResumeGrants({ ...api.identity, messageId: 'api-reply-one', responses, originalApiPending: pending })
      expect(approved ? grants.approved['api-setup-call'] : grants.denied['api-setup-call']).toBeDefined()
      await expect(originalTaskOwner.settleP5ApiApprovalResume(resume, grants)).resolves.toBeUndefined()
      const prefix = factoryOwners.records.get(`message:${api.identity.sessionId}:api-reply-one`)!
      const version = createApprovalResumeStart(prefix, Date.now()).version
      const part = originalTaskOwner.bindP5ApiReplyPart(resume, { replyId: 'api-reply-one', version })!
      const priorResponse = await first.response
      const second = await brain.streamNativeMode({ ...api.identity, messageId: 'api-reply-one', model: 'fixture-api',
        messages: [...initialMessages, ...priorResponse.messages, { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: request.approvalId, approved }] }],
        controlApprovals: grants, abortSignal: next.entry.stop.signal, mcpOriginalPreparation: resume, mcpApiPart: part, onP5ApiRun(run) { actualRun = run } })
      for await (const _event of second.stream) { /* actual SDK denial/approved callback handling */ }
      observeP5ApiConsumedStream(second)
      expect(executedSdkTool).toHaveBeenCalledTimes(approved ? 1 : 0)
      expect(effect).not.toHaveBeenCalled() // No positive setup/save/verification is fabricated.
      expect(originalTaskOwner.p5ApiPreparedScope(resume)?.gateways).toEqual(['A'])
      expect(() => originalTaskOwner.readP5ApiMcpAuthority(actualRun!, 'B')).toThrow()
      if (!approved) expect(() => originalTaskOwner.captureP5ApiManagement({ ...api.identity, messageId: 'api-reply-one', actorType: 'in-process', p5ApiRun: actualRun! }, 'C', { requestId: input.requestId, operationId: operation.operationId })).toThrow()
      await expect(originalTaskOwner.takeP5ApiVerifiedContinuation(resume)).resolves.toBeUndefined()
    } finally { risk.mockRestore(); provider.mockRestore() }
  })



  it.each([true, false])('keeps the complete full/removal preview on genuine API %s approval without inventing a positive data certificate', async approved => {
    const api = apiPreparedFixture(['A'])
    approvalReplies()
    factoryOwners.records.set(`session:${api.identity.sessionId}`, { id: api.identity.sessionId, user_id: api.identity.userId })
    const { VercelAIBrain, observeP5ApiConsumedStream } = await import('../vercelBrain')
    const { ProviderManager } = await import('../providers')
    const { nativeToolService } = await import('../nativeTools')
    const { attachControlApprovalRecords, resolveApprovalResumeGrants } = await import('../brokerControlApprovals')
    const { MockLanguageModelV3, convertArrayToReadableStream } = await import('ai/test')
    const { tool, jsonSchema } = await import('ai')
    const { createApprovalResumeStart } = await import('../approvalResumeMessage')
    const subject = { kind: 'primary' as const, id: api.identity.agentId }
    const intent = { subject, gatewayId: 'C', membership: 'disable' as const }
    const input = { op: 'change', requestId: `${settingsOperationRegistry.boot}:api-full-${approved ? 'approve' : 'deny'}`,
      reportId: `asr_${settingsOperationRegistry.boot}_mcp_${'2'.repeat(32)}`, semanticId: MCP_CONFIGURATION_ID,
      changes: { target: intent } }
    const review: McpConfigurationReview = { kind: 'mcp-configuration', variant: 'prerequisite', planId: `mcpp_${'4'.repeat(32)}`, candidateId: `mcpc_${'3'.repeat(32)}`,
      mode: 'remove', sourceAction: 'absent', resource: { kind: 'mcp-gateway', gatewayId: 'C' }, before: null, after: null, intent,
      target: { subject, label: 'Actual owned API target', changes: [{ field: 'membership', label: 'Source selected', before: false, after: false }] }, stages: [...MCP_CONFIGURATION_STAGES] }
    const effect = vi.fn(async () => [])
    const operation = settingsOperationRegistry.capture({ actor: { userId: api.identity.userId, kind: 'native', id: api.identity.agentId,
      sessionId: api.identity.sessionId, generation: 1, label: 'Controlled actual API recipe' }, requestId: input.requestId, input,
      preview: { semanticId: MCP_CONFIGURATION_ID, targets: [review.target], excluded: [], effects: [...mcpConfigurationEffects(review)], resource: review },
      resource: review.resource, permission: 'ask', preimages: { planId: review.planId, disclosure: review }, refresh: async () => {}, execute: effect })
    const fullPreview = settingsOperationRegistry.nativeApprovalPreview(api.identity.userId, api.identity.agentId, api.identity.sessionId, input.requestId)!
    expect(fullPreview.preview.resource).toEqual(review)
    expect(fullPreview.preview.targets).toEqual([review.target])
    expect(fullPreview.preview.resource).toMatchObject({ after: null })
    const brokerInput = { ref: 'fabric:sys.app_settings.native.change', input }
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } }
    let providerStep = 0, actualRun: Parameters<typeof originalTaskOwner.p5ApiRunMustPause>[0] | undefined
    let binding: ReturnType<typeof settingsOperationRegistry.bindP5ApiMcpOperation> | undefined
    const executedSdkTool = vi.fn(async () => ({ status: 'unavailable', reason: 'actual physical source/target writer is not admitted in this fixture' })) // No setup/effect/verified-C fact is supplied.
    const model = new MockLanguageModelV3({ provider: 'fixture', modelId: 'fixture-api', doStream: async () => {
      providerStep++
      return { stream: convertArrayToReadableStream<LanguageModelV3StreamPart>(providerStep === 1 ? [
        { type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'api-setup-call', toolName: 'native_batshit_tool_use', input: JSON.stringify(brokerInput) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage }
      ] : [
        { type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'api-final' }, { type: 'text-delta', id: 'api-final', delta: approved ? 'The approved call was handled.' : 'The denied call was not run.' },
        { type: 'text-end', id: 'api-final' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }
      ]) }
    } })
    const provider = vi.spyOn(ProviderManager, 'createForUser').mockResolvedValue({ getModel: () => model, listAvailableModels: () => [] } as any)
    const risk = vi.spyOn(nativeToolService, 'resolveBrokerRiskApprovalTarget').mockImplementation(async () => ({ ref: brokerInput.ref, family: 'fabric', controlId: 'sys.app_settings.native.change', controlTitle: 'Configure MCP',
      riskLevel: 'restricted', scopeKey: null, input, lane: 'api', settingsPreview: settingsOperationRegistry.nativeApprovalPreview(api.identity.userId, api.identity.agentId, api.identity.sessionId, input.requestId)!, p5ApiHeldRecipe: await binding }))
    const brain = new VercelAIBrain()
    ;(brain as any).buildToolsForMode3 = vi.fn(async () => {
      await binding
      return { tools: { native_batshit_tool_use: tool({ inputSchema: jsonSchema<Record<string, unknown>>({ type: 'object', additionalProperties: true }), execute: executedSdkTool }) },
        maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() }, toolApprovals: { native_batshit_tool_use: async () => 'user-approval' }, ephemeralImages: null, initialImageToolIds: [], imageDeferrals: [] }
    })
    let resume: ReturnType<typeof originalTaskOwner.prepareP5ApiApprovalResume> | undefined
    try {
      const initialMessages: NativeModeRequest['messages'] = [{ role: 'system', content: 'Controlled actual API instructions.' }, { role: 'user', content: 'Configure the tool, then answer the original question.' }]
      const first = await brain.streamNativeMode({ ...api.identity, messageId: 'api-reply-one', model: 'fixture-api', messages: initialMessages,
        abortSignal: api.stop.signal, mcpOriginalPreparation: api.preparation, mcpApiPart: api.part, onP5ApiRun(run) {
          actualRun = run; binding = settingsOperationRegistry.bindP5ApiMcpOperation({ ...api.identity, messageId: 'api-reply-one', actorType: 'in-process', p5ApiRun: run }, input)
        } })
      const emitted: any[] = []
      for await (const event of first.stream) emitted.push(event)
      observeP5ApiConsumedStream(first)
      const request = emitted.find(event => event.type === 'tool-approval-request')
      expect(request?.toolCall?.toolCallId).toBe('api-setup-call')
      const entries = await attachControlApprovalRecords({ ...api.identity, messageId: 'api-reply-one', p5ApiRun: actualRun!, abortSignal: api.stop.signal,
        approvals: [{ approvalId: request.approvalId, toolName: request.toolCall.toolName, toolCall: request.toolCall, input: brokerInput, status: 'pending', requestedAt: new Date().toISOString() }] })
      expect(entries[0].control?.approvalId).toMatch(/^apr_/)
      await persistCanonicalReply({ ...api.message('api-reply-one', ''), metadata: { toolApprovals: { source: 'vercel', mode: 'all', approvals: entries } } }, api.preparation, api.part)
      await originalTaskOwner.sealP5OriginalPreparation(api.preparation); originalTaskOwner.retireP5OriginalPreparation(api.preparation)
      releaseSessionTurn(api.identity.sessionId, api.registration.entry.turnId)
      const next = registerSessionTurn(api.identity.sessionId, 'single', 'api-reply-one', { answersApproval: true })
      if (!next.ok) throw new Error('The actual resumed turn was unavailable.')
      disposals.push(async () => { if (resume) { await originalTaskOwner.sealP5OriginalPreparation(resume); originalTaskOwner.retireP5OriginalPreparation(resume) }; releaseSessionTurn(api.identity.sessionId, next.entry.turnId) })
      const responses = [{ approvalId: request.approvalId, approved }]
      const pending = (await originalTaskOwner.pendingP5ApiApproval({ ...api.identity, session: { id: api.identity.sessionId, user_id: api.identity.userId }, agent: api.record,
        turn: next.entry, messageId: 'api-reply-one', responses }))!
      expect(pending).toBeDefined()
      const answer = await answerApprovalsOnce({ ...api.identity, messageId: 'api-reply-one', responses })
      expect(answer).toMatchObject({ ok: true, recorded: true })
      resume = originalTaskOwner.prepareP5ApiApprovalResume({ ...api.identity, session: { id: api.identity.sessionId, user_id: api.identity.userId }, agent: api.record,
        turn: next.entry, signal: next.entry.stop.signal, pending, answer })

      const grants = await resolveApprovalResumeGrants({ ...api.identity, messageId: 'api-reply-one', responses, originalApiPending: pending })
      expect(approved ? grants.approved['api-setup-call'] : grants.denied['api-setup-call']).toBeDefined()
      await expect(originalTaskOwner.settleP5ApiApprovalResume(resume, grants)).resolves.toBeUndefined()
      const prefix = factoryOwners.records.get(`message:${api.identity.sessionId}:api-reply-one`)!
      const version = createApprovalResumeStart(prefix, Date.now()).version
      const part = originalTaskOwner.bindP5ApiReplyPart(resume, { replyId: 'api-reply-one', version })!
      const priorResponse = await first.response
      const second = await brain.streamNativeMode({ ...api.identity, messageId: 'api-reply-one', model: 'fixture-api',
        messages: [...initialMessages, ...priorResponse.messages, { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: request.approvalId, approved }] }],
        controlApprovals: grants, abortSignal: next.entry.stop.signal, mcpOriginalPreparation: resume, mcpApiPart: part, onP5ApiRun(run) { actualRun = run } })
      for await (const _event of second.stream) { /* actual SDK denial/approved callback handling */ }
      observeP5ApiConsumedStream(second)
      expect(executedSdkTool).toHaveBeenCalledTimes(approved ? 1 : 0)
      expect(effect).not.toHaveBeenCalled() // No positive setup/save/verification is fabricated.
      expect(originalTaskOwner.p5ApiPreparedScope(resume)?.gateways).toEqual(['A'])
      expect(() => originalTaskOwner.readP5ApiMcpAuthority(actualRun!, 'B')).toThrow()
      if (!approved) expect(() => originalTaskOwner.captureP5ApiManagement({ ...api.identity, messageId: 'api-reply-one', actorType: 'in-process', p5ApiRun: actualRun! }, 'C', { requestId: input.requestId, operationId: operation.operationId })).toThrow()
      await expect(originalTaskOwner.takeP5ApiVerifiedContinuation(resume)).resolves.toBeUndefined()
    } finally { risk.mockRestore(); provider.mockRestore() }
  })

})
