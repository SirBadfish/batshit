import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('$lib/server/redis', async () => vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis'))
vi.mock('../claudeProfileManager', () => ({ deleteAgentClaudeConfig: vi.fn(), agentClaudeProfileResource: vi.fn() }))
vi.mock('../cliSubagentProfileSync', () => ({ deleteManagedCliSubagentProfile: vi.fn(), holdManagedCliSubagentProfileFolder: vi.fn(), planManagedCliSubagentProfileDeletion: vi.fn() }))
import { redis } from '$lib/server/redis'
import { useSkillSessionRedisTestServer } from '$lib/test-utils/skillSessionCommitTwin'
import { readTypedToolsSnapshot } from '$lib/server/typedFileToolsSettingsGuard'
import { withSettingsRecordReplacement } from '../appActions/settings/lifecycle'
const USER = 'typed_tools_sparse_test'
const id = 'typed_tools_sparse_subject'
const admission = useSkillSessionRedisTestServer()

describe.runIf(process.env.VITEST_USE_REAL_REDIS === 'true').each(['agent', 'subagent'] as const)('%s original Typed File Tools sparse write', kind => {
  const key = `${kind}:${id}`
  afterEach(async () => { vi.restoreAllMocks(); admission.requireAdmission(); await redis.del(key) })
  async function seed() {
    admission.requireAdmission()
    await redis.execute(client => client.sendCommand(['JSON.SET', key, '$', JSON.stringify({ id, user_id: USER,
      [kind === 'agent' ? 'agentType' : 'subagentType']: 'api', created_at: 'original-birth', updated_at: 'original-stamp',
      displayName: 'Original', provider_specific_settings: { nativeTools: { typedFileToolsEnabled: false, bashEnabled: false, unknown: 'BIG' } } }).replace('"BIG"', '9007199254740993')]))
    return redis.execute(client => readTypedToolsSnapshot(client, id, kind))
  }
  async function update(revision?: string, extra: Record<string, unknown> = {}, onSaved?: (value: unknown) => void) {
    const body = { ...extra, provider_specific_settings: { nativeTools: { typedFileToolsEnabled: true } } }
    const options = { expectedTypedFileTools: revision, onTypedFileToolsSaved: onSaved }
    return kind === 'agent' ? redis.updateAgent(id, body, options) : redis.updateSubagent(id, body, options)
  }
  it('saves the exact leaf with a same-command acknowledgement and preserves unknown precision/Bashfalse', async () => {
    const original = await seed(); const ack = vi.fn()
    await update(original.revision, {}, ack)
    expect(await redis.json.getRaw(key, '$.provider_specific_settings.nativeTools.unknown')).toBe('[9007199254740993]')
    expect(await redis.json.getRaw(key, '$.provider_specific_settings.nativeTools.bashEnabled')).toBe('[false]')
    expect(await redis.json.getRaw(key, '$.provider_specific_settings.nativeTools.typedFileToolsEnabled')).toBe('[true]')
    expect(ack).toHaveBeenCalledOnce(); expect(ack.mock.calls[0][0]).toMatchObject({ value: true, revision: expect.stringMatching(/^sha256:/) })
    expect((ack.mock.calls[0][0] as any).revision).not.toBe(original.revision)
  })
  it('refuses a missing original base and a changed original grant without writing another field or timestamp', async () => {
    const original = await seed()
    await expect(update(undefined, { displayName: 'Stale' })).rejects.toMatchObject({ code: 'typed_file_tools_base_required' })
    await redis.json.set(key, '$.provider_specific_settings.nativeTools.typedFileToolsEnabled', true)
    await expect(update(original.revision, { displayName: 'Stale' })).rejects.toMatchObject({ code: 'typed_file_tools_changed' })
    expect(await redis.json.get(key)).toMatchObject({ displayName: 'Original', updated_at: 'original-stamp' })
  })
  it('checks the original raw grant again at physical EVAL after all awaited preparation', async () => {
    const original = await seed(); const execute = redis.execute.bind(redis); let raced = false
    vi.spyOn(redis, 'execute').mockImplementationOnce((fn: any) => execute(client => fn(new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        if (script.includes("return {'TYPED_TOOLS_SAVED'")) {
          raced = true; await target.json.set(key, '$.provider_specific_settings.nativeTools.typedFileToolsEnabled', true)
        }
        return target.eval(script, options)
      }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } }))))
    await expect(update(original.revision, { displayName: 'Stale', claude_settings: { permissionMode: 'plan' } })).rejects.toMatchObject({ code: 'typed_file_tools_changed' })
    expect(raced).toBe(true)
    await expect(withSettingsRecordReplacement(key, async () => 'known-no-write')).resolves.toBe('known-no-write')
    expect(await redis.json.get(key)).toMatchObject({ displayName: 'Original', updated_at: 'original-stamp' })
  })
  it('invalidates a same-id replacement before applying an old displayed choice', async () => {
    const original = await seed()
    await withSettingsRecordReplacement(key, async () => {})
    await expect(update(original.revision)).rejects.toMatchObject({ code: 'typed_file_tools_changed' })
    expect(await redis.json.getRaw(key, '$.provider_specific_settings.nativeTools.typedFileToolsEnabled')).toBe('[false]')
  })
  it('carries the atomic displayed base through the actual detail GET and PUT with a same-write receipt', async () => {
    await seed()
    const events = vi.spyOn(await import('$lib/server/ssePublisher'), 'publishUserEvent')
    const route = kind === 'agent' ? await import('../../../../routes/api/agents/[id]/+server') : await import('../../../../routes/api/subagents/[id]/+server')
    const event = { params: { id }, locals: { user: { id: USER } } }
    const detail = await route.GET(event as any)
    expect(detail.ok).toBe(true)
    const base = detail.headers.get('x-batshit-typed-file-tools-revision')
    expect(base).toMatch(/^sha256:/)
    const body = { provider_specific_settings: { nativeTools: { typedFileToolsEnabled: true } }, expectedTypedFileTools: base }
    const request = () => new Request('http://localhost/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const saved = await route.PUT({ ...event, request: request() } as any)
    if (kind === 'subagent') expect(events).toHaveBeenCalledWith(USER, { type: 'subagent_settings_changed', agentId: id, family: 'provider-settings' })
    expect(saved.ok).toBe(true)
    const data = await saved.json()
    expect(data.typedFileTools).toMatchObject({ value: true, revision: expect.stringMatching(/^sha256:/) })
    expect(data.typedFileTools.revision).not.toBe(base)
    expect(await redis.json.getRaw(key, '$.expectedTypedFileTools')).toBe('[]')
    const stale = await route.PUT({ ...event, request: request() } as any)
    expect(stale.status).toBe(409)
    expect((await stale.json()).code).toBe('typed_file_tools_changed')
  })

  it('keeps unrelated sparse changes usable without touching the explicit choice', async () => {
    await seed()
    const body = { displayName: 'Current', provider_specific_settings: { nativeTools: { bashEnabled: true } } }
    if (kind === 'agent') await redis.updateAgent(id, body); else await redis.updateSubagent(id, body)
    expect(await redis.json.get(key)).toMatchObject({ displayName: 'Current', provider_specific_settings: { nativeTools: { typedFileToolsEnabled: false, bashEnabled: true } } })
  })

  it.runIf(kind === 'agent')('settles the target write after a known MCP raw refusal', async () => {
    await seed()
    const route = await import('../../../../routes/api/agents/[id]/+server')
    const event = { params: { id }, locals: { user: { id: USER } } }
    const detail = await route.GET(event as any)
    const body = { provider_specific_settings: { nativeTools: { typedFileToolsEnabled: true } }, claude_settings: { permissionMode: 'plan' }, defaultMCPGateways: [],
      expectedTypedFileTools: detail.headers.get('x-batshit-typed-file-tools-revision'),
      expectedMcpSettings: { defaultMCPGateways: JSON.parse(detail.headers.get('x-batshit-mcp-settings-revisions')!).defaultMCPGateways } }
    const originalExecute = redis.execute.bind(redis); let raced = false
    const interceptor = vi.spyOn(redis, 'execute').mockImplementation((fn: any) => originalExecute(client => fn(new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        if (script.includes("return {'TYPED_TOOLS_SAVED'")) { raced = true; await target.json.set(key, '$.defaultMCPGateways', ['late']) }
        return target.eval(script, options)
      }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } }))))
    const response = await route.PUT({ ...event, request: new Request('http://localhost/api/agents/fixture', { method: 'PUT',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) } as any)
    interceptor.mockRestore()
    expect(raced).toBe(true); expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('mcp_settings_changed')
    await expect(withSettingsRecordReplacement(key, async () => 'known-no-write')).resolves.toBe('known-no-write')
    expect(await redis.json.getRaw(key, '$.provider_specific_settings.nativeTools.typedFileToolsEnabled')).toBe('[false]')
    expect(await redis.json.getRaw(key, '$.claude_settings')).toBe('[]')
  })

  // SA-139 R5 removed the Claude Code CLI preset selection stack, and with it the case whose CLI
  // configuration follow-up failed after the typed and MCP receipts were saved.

  it.each(['refusal', 'replacement'] as const)('retains known final %s before EVAL with zero mutation and no saved callback', async change => {
    const original = await seed(); const ack = vi.fn(); const issued = vi.fn(); const execute = redis.execute.bind(redis)
    const lifecycle = await import('../appActions/settings/lifecycle')
    const acquire = lifecycle.acquireSettingsMutation
    let replacement: Promise<void> | undefined
    let first = true
    vi.spyOn(lifecycle, 'acquireSettingsMutation').mockImplementation(snapshot => {
      const lease = acquire(snapshot)
      if (!first) return lease
      first = false
      return { ...lease, check() {
        if (change === 'refusal') throw new Error('Known final source refusal')
        replacement = withSettingsRecordReplacement(key, async () => {})
        lease.check()
      } }
    })
    vi.spyOn(redis, 'execute').mockImplementationOnce((fn: any) => execute(client => fn(new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        if (script.includes("return {'TYPED_TOOLS_SAVED'")) issued()
        return target.eval(script, options)
      }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } }))))
    await expect(update(original.revision, { claude_settings: { permissionMode: 'plan' } }, ack)).rejects.not.toMatchObject({ code: 'typed_file_tools_save_unconfirmed' })
    await replacement
    await expect(withSettingsRecordReplacement(key, async () => 'known-no-write')).resolves.toBe('known-no-write')
    expect(issued).not.toHaveBeenCalled(); expect(ack).not.toHaveBeenCalled()
    expect(await redis.json.getRaw(key, '$.provider_specific_settings.nativeTools.typedFileToolsEnabled')).toBe('[false]')
  })

  it.each(['OK', 'malformed', 'throw'] as const)('requires the promised typed receipt and retains %s uncertainty without a saved callback', async fault => {
    const original = await seed(); const execute = redis.execute.bind(redis); const ack = vi.fn(); const issued = vi.fn()
    vi.spyOn(redis, 'execute').mockImplementationOnce((fn: any) => execute(client => fn(new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        if (script.includes("return {'TYPED_TOOLS_SAVED'")) {
          issued(); if (fault === 'throw') throw new Error('Reply lost after issue')
          return fault === 'OK' ? 'OK' : ['TYPED_TOOLS_SAVED', ['malformed']]
        }
        return target.eval(script, options)
      }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } }))))
    await expect(update(original.revision, {}, ack)).rejects.toMatchObject({ code: 'typed_file_tools_save_unconfirmed' })
    expect(issued).toHaveBeenCalledOnce(); expect(ack).not.toHaveBeenCalled()
  })

  it('holds the actual target incarnation until an issued ordinary sparse save settles', async () => {
    const waitId = `typed_tools_wait_${kind}`, waitKey = `${kind}:${waitId}`
    await redis.json.set(waitKey, '$', { id: waitId, user_id: USER,
      [kind === 'agent' ? 'agentType' : 'subagentType']: 'api', displayName: 'Original' })
    const execute = redis.execute.bind(redis)
    let entered!: () => void, release!: () => void, replaced = false
    const issuing = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(redis, 'execute').mockImplementationOnce((fn: any) => execute(client => fn(new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        if (script.includes(kind === 'agent' ? 'local guard = ARGV[5]' : 'local modelSelection = cjson.decode(ARGV[2])')) {
          const answer = await target.eval(script, options)
          entered(); await held; return answer
        }
        return target.eval(script, options)
      }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } }))))
    const saving = kind === 'agent' ? redis.updateAgent(waitId, { displayName: 'Saved' }) : redis.updateSubagent(waitId, { displayName: 'Saved' })
    let replacing: Promise<unknown> | undefined
    try {
      await Promise.race([issuing, saving.then(() => { throw new Error('The actual save issue was not intercepted.') })])
      replacing = withSettingsRecordReplacement(waitKey, async () => { replaced = true })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(replaced).toBe(false)
    } finally { release() }
    await saving
    await replacing
    expect(replaced).toBe(true)
    expect(await redis.json.get(waitKey)).toMatchObject({ displayName: 'Saved' })
    await redis.del(waitKey)
  })

  it('holds replacement when an ordinary sparse save was issued but its answer is lost', async () => {
    const unknownId = `typed_tools_unknown_${kind}`, unknownKey = `${kind}:${unknownId}`
    await redis.json.set(unknownKey, '$', { id: unknownId, user_id: USER,
      [kind === 'agent' ? 'agentType' : 'subagentType']: 'api', displayName: 'Original' })
    const execute = redis.execute.bind(redis)
    vi.spyOn(redis, 'execute').mockImplementationOnce((fn: any) => execute(client => fn(new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: any) => {
        const answer = await target.eval(script, options)
        if (script.includes(kind === 'agent' ? 'local guard = ARGV[5]' : 'local modelSelection = cjson.decode(ARGV[2])')) throw new Error('Reply lost after write')
        return answer
      }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } }))))
    try {
      const saving = kind === 'agent' ? redis.updateAgent(unknownId, { displayName: 'Maybe saved' }) : redis.updateSubagent(unknownId, { displayName: 'Maybe saved' })
      await expect(saving).rejects.toMatchObject({ code: 'subject_save_unconfirmed', status: 503 })
      expect(await redis.json.get(unknownKey)).toMatchObject({ displayName: 'Maybe saved' })
      await expect(withSettingsRecordReplacement(unknownKey, async () => 'must not replace')).rejects.toThrow('unknown')
    } finally { vi.restoreAllMocks(); await redis.del(unknownKey) }
  })


})
