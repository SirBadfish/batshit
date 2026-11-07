import { EventEmitter } from 'node:events'
import { AbortError } from 'redis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAppActionsPolicy } from '$lib/appActions/settings/managementContract'
import type { AdapterContext } from '../appActions/managementTypes'
import type { GatewayConditionalClient } from '../appActions/mcp/gatewayWriteContext'

// Actual ready-client / withAbortSignal interface, not a plain eval-only fake.
// Actual node-redis toWrite behavior and Lua require the existing Redis lane too.
beforeEach(() => { vi.resetModules() })
type Eval = (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>
function readyClient(command: Eval) {
  return Object.assign(new EventEmitter(), { isOpen: true, isReady: true,
    eval: vi.fn<Eval>(async () => { throw new Error('unbounded raw eval is forbidden') }),
    withAbortSignal: vi.fn((_signal: AbortSignal) => ({ eval: command }))
  }) satisfies GatewayConditionalClient
}
async function fixture(deadlineMs = 10_000, separateOperationStop = false) {
  const lifecycle = await import('../appActions/settings/lifecycle')
  const gateway = await import('../appActions/mcp/gatewayWriteContext')
  const stop = new AbortController()
  const operationStop = separateOperationStop ? new AbortController() : stop
  const adapter: AdapterContext = {
    admission: { actor: { userId: 'user', kind: 'native', id: 'agent', generation: 1, label: 'agent' },
      policy: defaultAppActionsPolicy(), fence: { key: 'agent:fixture', paths: [['$.id', '["fixture"]']],
        lifecycle: lifecycle.captureSettingsLifecycle(['agent:fixture']) }, signal: stop.signal },
    signal: operationStop.signal, deadlineAt: Date.now() + deadlineMs,
    assertCurrent() { if (stop.signal.aborted) throw new Error('stopped') }, async refreshAuthority() {}
  }
  const beforeIssue = vi.fn(), onSaved = vi.fn()
  const write = { mode: 'create' as const, gatewayId: 'assigned', key: 'mcp_gateways:user', path: '$', raw: '', value: { gateways: [{ id: 'assigned' }] } }
  const context = gateway.createGatewayManagementWriteContext({ mode: 'create', gatewayId: 'assigned', expectedRaw: '', approvedPostimage: write.value, adapter,
    fences: [{ key: 'source:fixture', paths: [['$.revision', '[1]']] }], beforeIssue, onSaved })
  return { ...gateway, lifecycle, context, write, adapter, beforeIssue, onSaved, deadlineAt: adapter.deadlineAt,
    stop: () => stop.abort(), stopOperation: () => operationStop.abort() }
}
function unsentClient() {
  let entered!: () => void
  const queued = new Promise<void>(resolve => { entered = resolve })
  const client = readyClient(async () => { throw new Error('wrong command owner') })
  client.withAbortSignal.mockImplementation(signal => ({ eval: async () => new Promise((_, reject) => {
    entered()
    const abort = () => { signal.removeEventListener('abort', abort); reject(new AbortError()) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  }) }))
  return { client, queued }
}
describe('conditional MCP gateway operation writes', () => {
  it('I1 the actual normalization owner prepares one assigned immutable create before approval without writing', async () => {
    const f = await fixture(), { redis } = await import('$lib/server/redis')
    const { MCPGatewayService, READ_MCP_GATEWAY_PLAN_SCRIPT } = await import('../mcpGatewayService')
    const command = vi.fn<Eval>(async () => ['OK', '[]']), client = readyClient(command)
    const registry = { gateways: [{ id: 'existing', name: 'Source', slug: 'source', type: 'custom', url: 'https://existing.example/mcp', enabled: true, created_at: '2026-10-18T00:00:00.000Z' }] }
    client.eval.mockImplementation(async (script: string) => {
      if (script !== READ_MCP_GATEWAY_PLAN_SCRIPT) throw new Error('Unexpected read owner')
      return [JSON.stringify([registry]), '', '-1'] as never
    })
    const execute = vi.spyOn(redis, 'execute').mockImplementation(async callback => callback(client as never))
    try {
      const owner = new MCPGatewayService(), gateway = { name: 'Source', type: 'custom' as const, enabled: true, url: 'https://source.example/mcp' }
      const captured = await owner.prepareGatewaySave('user', { mode: 'create', gateway })
      gateway.url = 'https://unapproved.example/mcp'
      expect(captured.review.after).toMatchObject({ slug: 'source_1', url: 'https://source.example/mcp' })
      expect(command).not.toHaveBeenCalled(); expect(JSON.stringify(captured.plan)).toBe('{}')
      await expect(owner.assertPreparedGatewayCurrent(structuredClone(captured.plan))).rejects.toThrow('original prepared')
      await owner.commitPreparedGatewaySave(captured.plan, { adapter: f.adapter, fences: [], beforeIssue: f.beforeIssue, onSaved: f.onSaved })
      expect(command).toHaveBeenCalledOnce()
      const stored = JSON.parse(command.mock.calls[0][1].arguments[2]).gateways.at(-1)
      expect(stored).toMatchObject({ id: captured.review.after.id, slug: 'source_1', url: 'https://source.example/mcp' })
      expect(stored.created_at).toBe(stored.updated_at)
      await expect(owner.commitPreparedGatewaySave(captured.plan, { adapter: f.adapter, fences: [], beforeIssue: f.beforeIssue, onSaved: f.onSaved })).rejects.toThrow('cannot issue again')
    } finally { execute.mockRestore() }
  })
  it('I1 refuses a stored literal that a JavaScript postimage would change instead of silently rounding unrelated data', async () => {
    const f = await fixture(), { redis } = await import('$lib/server/redis'), { MCPGatewayService } = await import('../mcpGatewayService')
    const command = vi.fn<Eval>(async () => ['OK', '[]']), client = readyClient(command)
    client.eval.mockResolvedValue(['[{"gateways":[],"legacy_number":9007199254740993}]', '', '-1'] as never)
    const execute = vi.spyOn(redis, 'execute').mockImplementation(async callback => callback(client as never))
    try {
      await expect(new MCPGatewayService().prepareGatewaySave('user', { mode: 'create', gateway: { name: 'Source', type: 'custom', enabled: true, url: 'https://source.example/mcp' } })).rejects.toThrow('literal representation')
      expect(command).not.toHaveBeenCalled(); expect(f.onSaved).not.toHaveBeenCalled()
    } finally { execute.mockRestore() }
  })
  it('I1 prepared updates retain actual stored STDIO check metadata and private legacy bytes outside disclosure', async () => {
    const f = await fixture(), { redis } = await import('$lib/server/redis')
    const { MCPGatewayService } = await import('../mcpGatewayService')
    const command = vi.fn<Eval>(async () => ['OK', '[]']), client = readyClient(command)
    const gateway = { id: 'stored', name: 'Stored', slug: 'stored', type: 'stdio', enabled: true, created_at: '2026-10-18T00:00:00.000Z',
      metadata: { authToken: 'PRIVATE_LEGACY_VALUE' }, stdioConfig: { command: 'npx', args: ['old'], cwdPolicy: 'none', lastTestStatus: 'passed', lastTestAt: '2026-10-18T01:00:00.000Z', toolCount: 7 } }
    client.eval.mockResolvedValue([JSON.stringify([{ gateways: [gateway] }]), JSON.stringify([gateway]), '0'] as never)
    const execute = vi.spyOn(redis, 'execute').mockImplementation(async callback => callback(client as never))
    try {
      const owner = new MCPGatewayService(), captured = await owner.prepareGatewaySave('user', { mode: 'update', gatewayId: 'stored', updates: {
        stdioConfig: { command: ' npx ', args: ['new'], cwdPolicy: 'none', lastTestStatus: 'failed', toolCount: 0 }
      } })
      expect(JSON.stringify(captured.review)).not.toContain('PRIVATE_LEGACY_VALUE')
      expect(captured.review.after.stdio).toMatchObject({ command: 'npx', args: ['new'], startupTimeoutMs: 10_000, toolCallTimeoutMs: 60_000 })
      await owner.commitPreparedGatewaySave(captured.plan, { adapter: f.adapter, fences: [], beforeIssue: f.beforeIssue, onSaved: f.onSaved })
      const stored = JSON.parse(command.mock.calls[0][1].arguments[2])
      expect(stored).toMatchObject({ metadata: { authToken: 'PRIVATE_LEGACY_VALUE' }, stdioConfig: { args: ['new'], lastTestStatus: 'passed', toolCount: 7 } })
      expect(f.onSaved).toHaveBeenCalledOnce()
    } finally { execute.mockRestore() }
  })
  it.each(['before', 'after'] as const)('BL1804 refuses secret-bearing stored/update %s argv before returning any automatic review or write', async side => {
    const f = await fixture(), { redis } = await import('$lib/server/redis'), { MCPGatewayService } = await import('../mcpGatewayService')
    const command = vi.fn<Eval>(async () => ['OK', '[]']), client = readyClient(command)
    const gateway = { id: 'legacy', slug: 'legacy', name: 'Legacy source', type: 'stdio', enabled: true, created_at: '2026-10-18T00:00:00.000Z',
      stdioConfig: { command: 'npx', args: side === 'before' ? ['--api-key=LEGACY_SECRET'] : ['--mode=read'], cwdPolicy: 'none',
        envRefs: [{ envVar: 'SOURCE_API_KEY', savedKeyRef: 'custom-mcp' }] } }
    const raw = JSON.stringify([{ gateways: [gateway] }]), element = JSON.stringify([gateway])
    client.eval.mockResolvedValue([raw, element, '0'] as never)
    const execute = vi.spyOn(redis, 'execute').mockImplementation(async callback => callback(client as never))
    let delivered: unknown, failure: unknown
    try {
      const updates = side === 'after' ? { stdioConfig: { command: 'npx', args: ['--api-key=LEGACY_SECRET'], cwdPolicy: 'none' as const } } : {}
      try { delivered = await new MCPGatewayService().prepareGatewaySave('user', { mode: 'update', gatewayId: 'legacy', updates }) }
      catch (error) { failure = error }
      expect(delivered).toBeUndefined()
      expect(failure).toBeInstanceOf(Error)
      expect(String(failure)).not.toContain('LEGACY_SECRET')
      expect(String(failure)).toContain('nonsecret gateway disclosure is unavailable')
      expect(command).not.toHaveBeenCalled(); expect(f.onSaved).not.toHaveBeenCalled()
      expect(JSON.stringify([{ gateways: [gateway] }])).toBe(raw)
      expect(JSON.stringify([gateway])).toBe(element)
    } finally { execute.mockRestore() }
  })
  it('issues once through withAbortSignal with frozen target, owner, authority/source checks and deadline', async () => {
    const f = await fixture(), command = vi.fn<Eval>(async () => ['OK', '[]']), client = readyClient(command)
    await f.writeManagedGateway(client, f.context, f.write)
    expect(command).toHaveBeenCalledOnce()
    const [script, options] = command.mock.calls[0]
    expect(script).toBe(f.CONDITIONAL_MCP_GATEWAY_WRITE_SCRIPT)
    expect(options.keys).toEqual(['mcp_gateways:user', 'agent:fixture', 'source:fixture'])
    expect(options.arguments[1]).toBe('')
    expect(JSON.parse(options.arguments[4])).toEqual([[['$.id', '["fixture"]']], [['$.revision', '[1]']]])
    expect(f.beforeIssue).toHaveBeenCalledOnce(); expect(f.onSaved).toHaveBeenCalledOnce()
    expect(client.eval).not.toHaveBeenCalled()
    await expect(f.writeManagedGateway(client, f.context, f.write)).rejects.toMatchObject({ code: 'MCP_WRITE_ALREADY_ISSUED' })
    expect(command).toHaveBeenCalledOnce()
    for (const event of ['error', 'end', 'reconnecting']) expect(client.listenerCount(event)).toBe(0)
  })
  it('refuses wrong destination/user, changed logical write, raw target, ID or path before issue', async () => {
    const f = await fixture(), command = vi.fn<Eval>(async () => ['OK', '[]']), client = readyClient(command)
    expect(() => f.assertGatewayManagementDestination(f.context, 'create', 'assigned', 'other-user', 'mcp_gateways:other-user')).toThrow(/destination/)
    await expect(f.writeManagedGateway(client, f.context, { ...f.write, key: 'mcp_gateways:other-user' })).rejects.toMatchObject({ code: 'MCP_DESTINATION_CONFLICT' })
    await expect(f.writeManagedGateway(client, f.context, { ...f.write, value: { gateways: [{ id: 'assigned', enabled: true }] } })).rejects.toMatchObject({ code: 'MCP_INTENT_CONFLICT' })
    await expect(f.writeManagedGateway(client, f.context, { ...f.write, gatewayId: 'other' })).rejects.toMatchObject({ code: 'MCP_DESTINATION_CONFLICT' })
    await expect(f.writeManagedGateway(client, f.context, { ...f.write, raw: '[{}]' })).rejects.toMatchObject({ code: 'MCP_CONFIGURATION_CONFLICT' })
    await expect(f.writeManagedGateway(client, f.context, { ...f.write, path: '$.unrelated' })).rejects.toMatchObject({ code: 'MCP_DESTINATION_CONFLICT' })
    expect(command).not.toHaveBeenCalled()
  })
  it('does not let later mutation of approved input change the pinned logical write', async () => {
    const f = await fixture(), command = vi.fn<Eval>(async () => ['OK', '[]'])
    Object.assign(f.write.value.gateways[0], { enabled: false })
    await expect(f.writeManagedGateway(readyClient(command), f.context, f.write)).rejects.toMatchObject({ code: 'MCP_INTENT_CONFLICT' })
    expect(command).not.toHaveBeenCalled()
  })
  it('exposes no raw postimage, actor, adapter, secret fingerprint or forgeable context fields', async () => {
    const f = await fixture(), command = vi.fn<Eval>(async () => ['OK', '[]'])
    expect(Object.keys(f.context)).toEqual([])
    expect(JSON.stringify(f.context)).toBe('{}')
    await expect(f.writeManagedGateway(readyClient(command), { ...f.context } as any, f.write)).rejects.toMatchObject({ code: 'MCP_WRITE_CUSTODY_REQUIRED' })
    f.adapter.admission.actor.userId = 'other-user'
    await expect(f.writeManagedGateway(readyClient(command), f.context, f.write)).rejects.toMatchObject({ code: 'MCP_OPERATION_ENDED' })
    expect(command).not.toHaveBeenCalled()
  })
  it('compares and sends one same serialized postimage instead of reevaluating toJSON', async () => {
    const f = await fixture(), command = vi.fn<Eval>(async () => ['OK', '[]'])
    const toJSON = vi.fn().mockReturnValueOnce({ gateways: [{ id: 'assigned' }] }).mockReturnValue({ gateways: [{ id: 'assigned', url: 'unapproved' }] })
    await f.writeManagedGateway(readyClient(command), f.context, { ...f.write, value: { toJSON } })
    expect(toJSON).toHaveBeenCalledOnce()
    expect(JSON.parse(command.mock.calls[0][1].arguments[2])).toEqual({ gateways: [{ id: 'assigned' }] })
  })
  it('holds the exact destination/raw/serialized payload through a later issue hook', async () => {
    const f = await fixture(), command = vi.fn<Eval>(async () => ['OK', '[]'])
    f.beforeIssue.mockImplementation(() => {
      Object.assign(f.write, { key: 'mcp_gateways:other-user', path: '$.unrelated', raw: '["other"]', gatewayId: 'other' })
      Object.assign(f.write.value.gateways[0], { url: 'unapproved' })
    })
    await f.writeManagedGateway(readyClient(command), f.context, f.write)
    expect(command.mock.calls[0][1].keys[0]).toBe('mcp_gateways:user')
    expect(command.mock.calls[0][1].arguments.slice(0, 3)).toEqual(['$', '', '{"gateways":[{"id":"assigned"}]}'])
  })
  it('binds CREATE updated_at exactly because only UPDATE generates that field', async () => {
    const f = await fixture(), command = vi.fn<Eval>(async () => ['OK', '[]'])
    const approved = { gateways: [{ id: 'assigned', updated_at: 'approved' }] }
    const context = f.createGatewayManagementWriteContext({ mode: 'create', gatewayId: 'assigned', expectedRaw: '', approvedPostimage: approved,
      adapter: f.adapter, fences: [], beforeIssue: f.beforeIssue, onSaved: f.onSaved })
    await expect(f.writeManagedGateway(readyClient(command), context, { ...f.write, value: { gateways: [{ id: 'assigned', updated_at: 'changed' }] } }))
      .rejects.toMatchObject({ code: 'MCP_INTENT_CONFLICT' })
    expect(command).not.toHaveBeenCalled()
  })
  it('refuses current Stop or an unready client before command admission', async () => {
    const f = await fixture(), command = vi.fn<Eval>(async () => ['OK', '[]']), client = readyClient(command)
    client.isReady = false
    await expect(f.writeManagedGateway(client, f.context, f.write)).rejects.toMatchObject({ code: 'MCP_STORE_NOT_READY' })
    expect(client.withAbortSignal).not.toHaveBeenCalled()
    const other = await fixture(); other.stop()
    await expect(other.writeManagedGateway(readyClient(command), other.context, other.write)).rejects.toThrow('stopped')
    expect(command).not.toHaveBeenCalled()
  })
  it('settles an actual-shape unsent AbortError after Stop without replay or unknown custody', async () => {
    const f = await fixture(), { client, queued } = unsentClient()
    const pending = f.writeManagedGateway(client, f.context, f.write)
    const refused = expect(pending).rejects.toMatchObject({ code: 'MCP_WRITE_UNSENT' })
    await queued; f.stop(); await refused
    await expect(f.lifecycle.withSettingsRecordReplacement('agent:fixture', async () => undefined)).resolves.toBeUndefined()
    expect(f.onSaved).not.toHaveBeenCalled(); expect(client.eval).not.toHaveBeenCalled()
  })
  it('settles the same unsent queue when the actual client disconnects', async () => {
    const f = await fixture(), { client, queued } = unsentClient()
    const pending = f.writeManagedGateway(client, f.context, f.write)
    const refused = expect(pending).rejects.toMatchObject({ code: 'MCP_WRITE_UNSENT' })
    await queued; client.emit('reconnecting'); await refused
    await expect(f.lifecycle.withSettingsRecordReplacement('agent:fixture', async () => undefined)).resolves.toBeUndefined()
  })
  it('settles an unsent command at the inherited deadline without a global timeout change', async () => {
    vi.useFakeTimers()
    try {
      const f = await fixture(20), { client, queued } = unsentClient()
      const pending = f.writeManagedGateway(client, f.context, f.write)
      const refused = expect(pending).rejects.toMatchObject({ code: 'MCP_WRITE_UNSENT' })
      await queued; await vi.advanceTimersByTimeAsync(20); await refused
      await expect(f.lifecycle.withSettingsRecordReplacement('agent:fixture', async () => undefined)).resolves.toBeUndefined()
    } finally { vi.useRealTimers() }
  })
  it.each(['original reply', 'operation'] as const)('removes an unsent command on the %s Stop when the signals are distinct', async source => {
    const f = await fixture(10_000, true), { client, queued } = unsentClient()
    const pending = f.writeManagedGateway(client, f.context, f.write)
    const refused = expect(pending).rejects.toMatchObject({ code: 'MCP_WRITE_UNSENT' })
    await queued
    if (source === 'original reply') f.stop(); else f.stopOperation()
    await refused
    await expect(f.lifecycle.withSettingsRecordReplacement('agent:fixture', async () => undefined)).resolves.toBeUndefined()
    expect(f.onSaved).not.toHaveBeenCalled()
  })
  it.each(['Stop', 'deadline', 'authority'] as const)('checks %s after an awaited client acquisition before queue admission', async ending => {
    const f = await fixture(), command = vi.fn<Eval>(async () => ['OK', '[]']), client = readyClient(command)
    let release!: () => void
    const acquired = new Promise<void>(resolve => { release = resolve })
    // Same acquisition/operation ordering as existing redis.execute/getClient;
    // this is a synthetic executor boundary, not actual Redis proof.
    const pending = (async () => { await acquired; return f.writeManagedGateway(client, f.context, f.write) })()
    const refused = expect(pending).rejects.toBeTruthy()
    try {
      if (ending === 'Stop') f.stop()
      if (ending === 'deadline') vi.spyOn(Date, 'now').mockReturnValue(f.deadlineAt)
      if (ending === 'authority') await f.lifecycle.withSettingsRecordReplacement('agent:fixture', async () => undefined)
    } finally { release(); await refused; vi.restoreAllMocks() }
    expect(client.withAbortSignal).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled()
  })
  it.each(['hook', 'command'] as const)('checks the absolute deadline after the final %s without timer dispatch', async where => {
    const f = await fixture(), command = vi.fn<Eval>(async () => ['OK', '[]']), client = readyClient(command)
    const expire = () => { vi.spyOn(Date, 'now').mockReturnValue(f.deadlineAt) }
    if (where === 'hook') f.beforeIssue.mockImplementation(expire)
    else client.withAbortSignal.mockImplementation(() => { expire(); return { eval: command } })
    try { await expect(f.writeManagedGateway(client, f.context, f.write)).rejects.toMatchObject({ code: 'MCP_OPERATION_ENDED' }) }
    finally { vi.restoreAllMocks() }
    expect(command).not.toHaveBeenCalled()
  })
  it('retains actual issued-promise custody after Stop until its lost result settles, then refuses replay', async () => {
    const f = await fixture()
    let entered!: () => void, reject!: (error: Error) => void, ended = false
    const issued = new Promise<void>(resolve => { entered = resolve })
    const command = vi.fn<Eval>(() => { entered(); return new Promise((_resolve, refuse) => { reject = refuse }) })
    const client = readyClient(command)
    const pending = f.writeManagedGateway(client, f.context, f.write).then(value => value, error => error).finally(() => { ended = true })
    await issued
    try { f.stop(); await Promise.resolve(); expect(ended).toBe(false) }
    finally { reject(new Error('synthetic sent response lost')); await pending }
    expect(await pending).toMatchObject({ code: 'MCP_GATEWAY_WRITE_UNCONFIRMED', gatewaySaved: false, gatewayId: 'assigned' })
    await expect(f.lifecycle.withSettingsRecordReplacement('agent:fixture', async () => undefined)).rejects.toThrow(/unknown outcome/)
    // The stopped original cannot issue; the one physical command remains the only attempt.
    await expect(f.writeManagedGateway(client, f.context, f.write)).rejects.toBeTruthy()
    expect(command).toHaveBeenCalledOnce()
  })
  it('binds the approved update postimage while retaining the actual selected array index', async () => {
    const f = await fixture(), command = vi.fn<Eval>(async () => ['OK', '[]']), raw = '[{"id":"assigned","enabled":false}]'
    const approved = { id: 'assigned', enabled: true, updated_at: 'captured-owner-time' }
    const context = f.createGatewayManagementWriteContext({ mode: 'update', gatewayId: 'assigned', expectedRaw: raw, approvedPostimage: approved,
      adapter: f.adapter, fences: [], beforeIssue: f.beforeIssue, onSaved: f.onSaved })
    const write = { mode: 'update' as const, gatewayId: 'assigned', key: 'mcp_gateways:user', path: '$.gateways[3]', raw,
      value: { ...approved, updated_at: 'current-owner-time' } }
    await f.writeManagedGateway(readyClient(command), context, write)
    expect(command.mock.calls[0][1].arguments[0]).toBe('$.gateways[3]')
  })
  it('keeps known atomic refusal distinct from a saved or unknown gateway', async () => {
    const f = await fixture(), command = vi.fn<Eval>(async () => 'AUTHORITY_CHANGED'), client = readyClient(command)
    await expect(f.writeManagedGateway(client, f.context, f.write)).rejects.toMatchObject({ code: 'MCP_WRITE_AUTHORITY_CHANGED' })
    expect(f.onSaved).not.toHaveBeenCalled()
    await expect(f.lifecycle.withSettingsRecordReplacement('agent:fixture', async () => undefined)).resolves.toBeUndefined()
  })
  it('retains custody for a sent/lost answer after Stop; ordinary error is not proof of unsent', async () => {
    const f = await fixture(), command = vi.fn<Eval>(async () => { f.stop(); throw new Error('sent answer lost') })
    await expect(f.writeManagedGateway(readyClient(command), f.context, f.write)).rejects.toMatchObject({ code: 'MCP_GATEWAY_WRITE_UNCONFIRMED', gatewaySaved: false, gatewayId: 'assigned' })
    expect(command).toHaveBeenCalledOnce()
    await expect(f.lifecycle.withSettingsRecordReplacement('agent:fixture', async () => undefined)).rejects.toThrow(/unknown outcome/)
  })
  it('keeps a confirmed save when its journal callback fails', async () => {
    const f = await fixture(); f.onSaved.mockImplementation(() => { throw new Error('journal failed') })
    await expect(f.writeManagedGateway(readyClient(async () => ['OK', '[]']), f.context, f.write)).rejects.toMatchObject({ gatewaySaved: true, gatewayId: 'assigned' })
  })
})

describe('MCP source ACK evidence and exact setup-auth cohort', () => {
  it.each(['tuple','legacy-known','missing-postimage'] as const)('keeps known source truth distinct from usable actual %s evidence', async mode => {
    const f = await fixture(), { redis } = await import('$lib/server/redis'), { MCPGatewayService } = await import('../mcpGatewayService')
    let actualPost = ''
    const command = vi.fn<Eval>(async (_script, options) => {
      const value = JSON.parse(options.arguments[2])
      actualPost = JSON.stringify([value.gateways[0]])
      return mode === 'tuple' ? ['OK', actualPost] : mode === 'legacy-known' ? 'OK' : ['SAVED_POSTIMAGE_UNAVAILABLE']
    })
    const client = readyClient(command); client.eval.mockResolvedValue(['', '', '-1'] as never)
    const execute = vi.spyOn(redis, 'execute').mockImplementation(async callback => callback(client as never))
    try {
      const owner = new MCPGatewayService(), captured = await owner.prepareGatewaySave('user', { mode: 'create', gateway: { name: 'Source', type: 'custom', enabled: true, url: 'https://source.example/mcp' } })
      const committed = owner.commitPreparedGatewaySave(captured.plan, { adapter: f.adapter, fences: [], beforeIssue: f.beforeIssue, onSaved: f.onSaved })
      if (mode === 'legacy-known') {
        await expect(committed).rejects.toMatchObject({ gatewaySaved: false, code: 'MCP_GATEWAY_WRITE_UNCONFIRMED' })
        expect(f.onSaved).not.toHaveBeenCalled()
      } else { await committed; expect(f.onSaved).toHaveBeenCalledOnce() }
      expect(command).toHaveBeenCalledOnce()
      if (mode === 'tuple') expect(owner.readPreparedMcpSource(captured.plan).raw).toBe(actualPost)
      else expect(() => owner.readPreparedMcpSource(captured.plan)).toThrow('actual source ACK postimage')
      await expect(owner.commitPreparedGatewaySave(captured.plan, { adapter: f.adapter, fences: [], beforeIssue: f.beforeIssue, onSaved: f.onSaved })).rejects.toThrow('cannot issue again')
    } finally { execute.mockRestore() }
  })
  it('refuses legacy inline or malformed declared auth before entering an effect callback', async () => {
    const f = await fixture(), { redis } = await import('$lib/server/redis'), { MCPGatewayService } = await import('../mcpGatewayService')
    const command = vi.fn<Eval>(async () => ['OK', '[]']), client = readyClient(command)
    const gateway = { id: 'stored', slug: 'stored', name: 'Stored', type: 'custom', enabled: true, created_at: '2026-10-18T00:00:00.000Z', url: 'https://source.example/mcp', metadata: { authToken: 'PRIVATE_LEGACY' } }
    client.eval.mockResolvedValue([JSON.stringify([{ gateways: [gateway] }]), JSON.stringify([gateway]), '0'] as never)
    const execute = vi.spyOn(redis, 'execute').mockImplementation(async callback => callback(client as never)), effect = vi.fn(async () => {})
    try {
      const owner = new MCPGatewayService(), captured = await owner.prepareGatewaySave('user', { mode: 'update', gatewayId: 'stored', updates: {} })
      await expect(owner.withPreparedMcpHttpAuth(captured.plan, [], effect)).rejects.toThrow('HTTP prerequisite cohort')
      expect(effect).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled()
    } finally { execute.mockRestore() }
  })
})
