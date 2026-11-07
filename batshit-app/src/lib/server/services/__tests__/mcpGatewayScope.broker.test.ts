import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
vi.unmock('ai')
import { beforeEach, describe, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ discovered: [] as string[][], executed: [] as string[], options: [] as Array<{ p5ApiRun?: unknown; abortSignal?: AbortSignal }>, model: null as any }))
vi.mock('../mcpGatewayDiscovery', async importOriginal => {
  const actual = await importOriginal<typeof import('../mcpGatewayDiscovery')>()
  return { ...actual, mcpGatewayDiscovery: {
  loadToolsForUser: vi.fn(async (_user: string, ids?: string[]) => {
    calls.discovered.push(ids ?? ['UNSCOPED'])
    const tools: Record<string, any> = {}; const metadata = new Map()
    for (const id of ids ?? []) {
      const name = `mcp_${id}_probe`
      tools[name] = { description: `Probe ${id}`, inputSchema: { type: 'object', properties: {} }, execute: async (_input: unknown, options: { p5ApiRun?: unknown; abortSignal?: AbortSignal }) => { calls.options.push(options); calls.executed.push(id); return { content: [{ type: 'text', text: id }] } } }
      metadata.set(name, { gatewayId: id, gatewayName: id, originalToolName: 'probe', mcpServerName: id })
    }
    return { tools, metadata }
  })
  } }
})
vi.mock('$lib/server/artifacts/artifactsService', () => ({ ArtifactsService: class { async listByUser() { return [] } } }))

vi.mock('../providers', () => {
  const factory = () => ({ getModel: () => calls.model, listAvailableModels: () => [] })
  const ProviderManager = vi.fn(function(this: Record<string, unknown>) { Object.assign(this, factory()) })
  ;(ProviderManager as any).createForUser = vi.fn(async () => factory())
  return { ProviderManager, resolveProviderAccess: vi.fn(async () => ({ apiKeys: {} })) }
})
import { redis } from '$lib/server/redis'
import { nativeToolService } from '../nativeTools'
import { useControl } from '../fabricRegistry'
const owner = { userId: 'broker-gateway-user', agentId: 'broker-gateway-agent', sessionId: 'broker-gateway-chat' }
const settings = { nativeTools: { dynamicMcpEnabled: true, batshitToolsEnabled: true, cliToolsEnabled: false, artifactRuntimeEnabled: false, fetchZipEnabled: false, agentBrowserEnabled: false, webSearchEnabled: false, bashEnabled: false } }
beforeEach(async () => {
  calls.discovered.length = 0; calls.executed.length = 0; calls.options.length = 0; calls.model = null
  await redis.set(`agent:${owner.agentId}`, { id: owner.agentId, user_id: owner.userId, defaultMCPGateways: ['saved'], provider_specific_settings: settings } as any)
})
describe('MCP scope across API broker and Fabric', () => {
  it('API executes a human-selected wider snapshot but ignores forged authority', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({ ...owner, selectedGateways: ['extra'], selectedCliToolIds: [], providerSettings: settings } as any)
    await tools.native_batshit_tool_use.execute({ ref: 'mcp:mcp_extra_probe', input: {}, mcpGatewayScope: ['forbidden'] })
    expect(calls.executed).toEqual(['extra'])
    await tools.native_batshit_tool_use.execute({ ref: 'mcp:mcp_forbidden_probe', input: {}, selectedGateways: ['forbidden'], mcpGatewayScope: ['forbidden'] })
    expect(calls.executed).toEqual(['extra']); expect(calls.discovered.flat()).not.toContain('forbidden')
  })
  it('API honors an empty filter, including brokered Fabric MCP calls', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({ ...owner, selectedGateways: ['extra'], selectedCliToolIds: [], providerSettings: settings } as any)
    await tools.native_batshit_tool_use.execute({ ref: 'mcp:mcp_extra_probe', input: {}, selectedGateways: [] })
    await tools.native_batshit_tool_use.execute({ ref: 'batshit:sys.mcp.dynamic.use', input: { toolName: 'mcp_extra_probe' }, selectedGateways: [] })
    expect(calls.executed).toEqual([]); expect(calls.discovered.every(ids => ids.length === 0)).toBe(true)
  })
  it('an API run with no bound scope cannot reload saved defaults', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({ ...owner, selectedCliToolIds: [], providerSettings: settings } as any)
    await tools.native_batshit_tool_use.execute({ ref: 'mcp:mcp_saved_probe', input: {} })
    expect(calls.executed).toEqual([]); expect(calls.discovered.flat()).toEqual([])
  })
  it('Fabric intersects both outer and inner caller filters with its scope', async () => {
    await useControl({ ...owner, actorType: 'in-process', runtimeMode: 'mode3', controlId: 'sys.mcp.dynamic.use', mcpGatewayScope: ['extra'], selectedGateways: [], input: { toolName: 'mcp_extra_probe', selectedGateways: ['extra'], mcpGatewayScope: ['forbidden'] } })
    expect(calls.executed).toEqual([])
    await useControl({ ...owner, actorType: 'in-process', runtimeMode: 'mode3', controlId: 'sys.mcp.dynamic.use', mcpGatewayScope: ['extra'], input: { toolName: 'mcp_extra_probe', selectedGateways: ['extra', 'forbidden'] } })
    expect(calls.executed).toEqual(['extra']); expect(calls.discovered.flat()).not.toContain('forbidden')
  })

})


describe('actual API Brain private ownership crosses both native broker paths', () => {
  it.each(['direct', 'fabric'] as const)('keeps the genuine original run through %s and leaves an unrelated Settings recipe unarmed', async path => {
    const original = await import('../appActions/mcp/originalTask')
    const turns = await import('../streamAbortRegistry')
    const { settingsOperationRegistry } = await import('../appActions/settings/managementRuntime')
    const { VercelAIBrain, observeP5ApiConsumedStream } = await import('../vercelBrain')
    const { MockLanguageModelV3, convertArrayToReadableStream } = await import('ai/test')
    const identity = { ...owner, sessionId: `${owner.sessionId}-${path}` }
    const replyId = `private-broker-${path}`, stop = new AbortController()
    const registration = turns.registerSessionTurn(identity.sessionId, 'single', replyId)
    if (!registration.ok) throw new Error('Actual registered API turn refused')
    const lookup = original.captureP5OriginalLookup({ ...identity, signal: stop.signal })!
    const preparation = original.prepareP5OriginalTask(lookup, { ...identity, session: { id: identity.sessionId, user_id: identity.userId },
      agent: { id: identity.agentId, user_id: identity.userId, agentType: 'api' }, turn: registration.entry })!
    original.recordP5ResolvedApiScope(preparation, { gateways: ['extra'], tools: [], authority: { humanSelection: true } })
    const part = original.bindP5ApiReplyPart(preparation, { replyId, version: 0 })!
    const memoryInput = { op: 'change', requestId: `${settingsOperationRegistry.boot}:ordinary-memory-${path}`, changes: { recalled: 2 } }
    const effect = vi.fn(async () => [])
    settingsOperationRegistry.capture({ actor: { userId: identity.userId, kind: 'native', id: identity.agentId, sessionId: identity.sessionId, generation: 1, label: 'Actual API memory owner' },
      requestId: memoryInput.requestId, input: memoryInput, preview: { semanticId: 'agent.memory.preferences', targets: [{ subject: { kind: 'primary', id: identity.agentId }, label: 'Primary', changes: [{ field: 'recalled', label: 'Recall budget', before: 1, after: 2 }] }], excluded: [], effects: [] },
      permission: 'ask', preimages: { recalled: 1 }, refresh: async () => {}, execute: effect })
    let actualRun: Parameters<typeof original.p5ApiRunMustPause>[0] | undefined
    let unrelated: ReturnType<typeof settingsOperationRegistry.bindP5ApiMcpOperation> | undefined
    let step = 0
    const forged = { modelSupplied: true }
    const brokerInput = path === 'direct'
      ? { ref: 'mcp:mcp_extra_probe', input: {}, p5ApiRun: forged, mcpGatewayScope: ['forbidden'] }
      : { ref: 'batshit:sys.mcp.dynamic.use', input: { toolName: 'mcp_extra_probe', params: {}, p5ApiRun: forged }, p5ApiRun: forged, mcpGatewayScope: ['forbidden'] }
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } }
    calls.model = new MockLanguageModelV3({ provider: 'fixture', modelId: 'fixture-api', doStream: async () => ({
      stream: convertArrayToReadableStream<LanguageModelV3StreamPart>(++step === 1 ? [
        { type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'private-broker-call', toolName: 'native_batshit_tool_use', input: JSON.stringify(brokerInput) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage }
      ] : [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'done' }, { type: 'text-delta', id: 'done', delta: 'Done.' },
        { type: 'text-end', id: 'done' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }])
    }) })
    const nativeBuild = vi.spyOn(nativeToolService, 'buildMode3NativeTools')
    try {
      const brain = new VercelAIBrain() // No buildToolsForMode3 replacement: actual native/Fabric composition.
      const result = await brain.streamNativeMode({ ...identity, messageId: replyId, model: 'fixture-api',
        messages: [{ role: 'system', content: 'Controlled broker instructions.' }, { role: 'user', content: 'Use the selected probe.' }],
        selectedGateways: ['extra'], selectedCliToolIds: [], providerSettings: settings, toolApprovalMode: 'off',
        abortSignal: stop.signal, mcpOriginalPreparation: preparation, mcpApiPart: part,
        onP5ApiRun(run) {
          actualRun = run
          unrelated = settingsOperationRegistry.bindP5ApiMcpOperation({ ...identity, messageId: replyId, actorType: 'in-process', p5ApiRun: run }, memoryInput)
        } })
      for await (const event of result.stream) if (event.type === 'error') throw event.error
      observeP5ApiConsumedStream(result)
      expect(await unrelated).toBeUndefined()
      expect(actualRun).toBeDefined()
      expect(nativeBuild.mock.calls.some(([context]) => context.p5ApiRun === actualRun)).toBe(true)
      expect(calls.executed).toEqual(['extra'])
      expect(calls.options).toHaveLength(1)
      expect(calls.options[0]).toEqual({ abortSignal: stop.signal, p5ApiRun: actualRun })
      expect(calls.options[0].p5ApiRun).not.toEqual(forged)
      expect(calls.discovered.flat()).not.toContain('forbidden')
      expect(original.p5ApiManagedMcpActive(actualRun!)).toBe(false)
      expect(original.p5ApiRunMustPause(actualRun!)).toBe(false)
      expect(original.p5ApiPreparedScope(preparation)?.gateways).toEqual(['extra'])
      expect(effect).not.toHaveBeenCalled()
      await expect(original.takeP5ApiVerifiedContinuation(preparation)).resolves.toBeUndefined()
    } finally {
      nativeBuild.mockRestore()
      await original.sealP5OriginalPreparation(preparation); original.retireP5OriginalPreparation(preparation)
      turns.releaseSessionTurn(identity.sessionId, registration.entry.turnId)
    }
  })
})
