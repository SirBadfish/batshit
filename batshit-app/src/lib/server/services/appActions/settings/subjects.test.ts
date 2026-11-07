import { describe, expect, it, vi } from 'vitest'
import { settingsSubjectKey, type SettingsSubjectRef } from '$lib/appActions/settings/reportContract'
import { createSettingsSubjectResolver, settingsSubjectType, type SettingsReportReadContext } from './subjects'

const context = (): SettingsReportReadContext => ({ userId: 'owner', canRead: () => true, check() {} })
const agent = (id: string, extra = {}) => ({ id, user_id: 'owner', displayName: id, agentType: 'api', ...extra })
describe('Settings report subject resolution', () => {
  it('includes every stored kind, preserves exact exclusions and never exposes source blocks', async () => {
    const records = new Map([
      ['primary:same', agent('same', { apiKey: 'do-not-report' })],
      ['primary:cli', agent('cli', { agentType: 'cli' })],
      ['subagent:clisub', agent('clisub', { subagentType: 'cli' })],
      ['subagent:same', agent('same', { subagentType: 'api' })],
      ['subagent:workflow', agent('workflow', { subagentType: 'n8n-workflow' })]
    ])
    const read = vi.fn(async (_user: string, ref: SettingsSubjectRef) => records.get(settingsSubjectKey(ref)) ?? null)
    const resolver = createSettingsSubjectResolver({
      listIds: async (_user, kind) => kind === 'primary' ? ['same', 'cli'] : ['workflow', 'same', 'clisub'], read
    })
    const manifest = await resolver({ allAgents: true, except: [{ kind: 'primary', id: 'same' }] }, context())
    expect(manifest.entries.map(item => [settingsSubjectKey(item.subject), item.status, item.type])).toEqual([
      ['primary:cli', 'unavailable', undefined], ['subagent:clisub', 'unavailable', undefined], ['subagent:same', 'available', 'api'],
      ['subagent:workflow', 'unavailable', undefined]
    ])
    // SA-139 R4/R5: a leftover `cli` Primary or Subagent is a retired type, so it is unsupported.
    expect(manifest.entries.find(item => settingsSubjectKey(item.subject) === 'primary:cli')).toMatchObject({ reason: 'unsupported_subject_type' })
    expect(manifest.entries.find(item => settingsSubjectKey(item.subject) === 'subagent:clisub')).toMatchObject({ reason: 'unsupported_subject_type' })
    // SA-139 R2: the removed n8n Workflow Subagent type is unsupported, not a live Subagent type.
    expect(manifest.entries.find(item => item.subject.id === 'workflow')).toMatchObject({ reason: 'unsupported_subject_type' })
    expect(manifest.excluded).toEqual([{ kind: 'primary', id: 'same' }])
    expect(read.mock.calls.some(([, ref]) => settingsSubjectKey(ref) === 'primary:same')).toBe(false)
    expect(JSON.stringify(manifest)).not.toContain('do-not-report')
    records.set('primary:new', agent('new'))
    expect(manifest.entries).toHaveLength(4)
    expect(Object.isFrozen(manifest.entries)).toBe(true)
  })
  // SA-139 R4/R5 (D14): a Primary or Subagent subject is API only.
  it('settingsSubjectType refuses a cli Primary and a cli Subagent', () => {
    expect(settingsSubjectType({ kind: 'primary', id: 'p' }, { agentType: 'cli' })).toBeUndefined()
    expect(settingsSubjectType({ kind: 'primary', id: 'p' }, { agentType: 'n8n' })).toBeUndefined()
    expect(settingsSubjectType({ kind: 'primary', id: 'p' }, { agentType: 'api' })).toBe('api')
    expect(settingsSubjectType({ kind: 'subagent', id: 's' }, { subagentType: 'cli' })).toBeUndefined()
    expect(settingsSubjectType({ kind: 'subagent', id: 's' }, { subagentType: 'api' })).toBe('api')
    // A Subagent record's own `agentType` never makes it a subject; only `subagentType` is read.
    expect(settingsSubjectType({ kind: 'subagent', id: 's' }, { agentType: 'cli' })).toBeUndefined()
  })
  it('checks permission before reading and again after an asynchronous read', async () => {
    const ctx = context()
    ctx.canRead = ref => ref.id !== 'denied'
    const read = vi.fn(async (_user, ref) => {
      if (ref.id === 'revoke') ctx.canRead = () => false
      return agent(ref.id)
    })
    const resolver = createSettingsSubjectResolver({ listIds: async () => [], read })
    const manifest = await resolver({ subjects: [{ kind: 'primary', id: 'denied' }, { kind: 'primary', id: 'revoke' }] }, ctx)
    expect(read).toHaveBeenCalledTimes(1)
    expect(manifest.entries.map(entry => entry.reason)).toEqual(['read_not_allowed', 'read_not_allowed'])
    expect(manifest.entries.every(entry => entry.label === undefined)).toBe(true)
  })
  it('distinguishes missing, failed, foreign, retired and non-agent records', async () => {
    const resolver = createSettingsSubjectResolver({ listIds: async () => [], read: async (_user, ref) => {
      if (ref.id === 'failed') throw new Error('no source')
      if (ref.id === 'missing') return null
      if (ref.id === 'foreign') return agent(ref.id, { user_id: 'other', displayName: 'secret label' })
      return agent(ref.id, { agentType: 'n8n' })
    } })
    const manifest = await resolver({ subjects: [
      ...['failed', 'foreign', 'missing', 'retired'].map(id => ({ kind: 'primary', id })), { kind: 'group', id: 'group' }, { kind: 'worker', id: 'worker' }
    ] }, context())
    expect(manifest.entries.map(entry => entry.reason)).toEqual([
      'not_an_agent_subject', 'subject_unavailable', 'subject_not_owned', 'subject_missing', 'unsupported_subject_type', 'not_an_agent_subject'
    ])
    expect(JSON.stringify(manifest)).not.toContain('secret label')
  })
  it('refuses a complete oversized selection and an unreadable index instead of silently shortening it', async () => {
    const resolver = createSettingsSubjectResolver({ listIds: async (_user, kind) => kind === 'primary' ? Array.from({ length: 257 }, (_, i) => `a${i}`) : [], read: vi.fn() })
    await expect(resolver({ allAgents: true }, context())).rejects.toMatchObject({ reason: 'subject_limit_exceeded', count: 257 })
    const unavailable = createSettingsSubjectResolver({ listIds: async () => { throw new Error('index failed') }, read: vi.fn() })
    await expect(unavailable({ allAgents: true }, context())).rejects.toThrow('index failed')
  })
  it('retains Stop after an awaited source failure and requires explicit server admission', async () => {
    let stopped = false
    const ctx = { ...context(), check() { if (stopped) throw new Error('stopped') } }
    const resolver = createSettingsSubjectResolver({ listIds: async () => [], read: async () => { stopped = true; throw new Error('read failed') } })
    await expect(resolver({ subjects: [{ kind: 'primary', id: 'a' }] }, ctx)).rejects.toThrow('stopped')
    await expect(resolver({ allAgents: true }, { userId: 'owner' } as SettingsReportReadContext)).rejects.toThrow('report_admission_required')
  })
  it('keeps long canonical IDs and explicit unavailable legacy rows without poisoning the complete index', async () => {
    const long = 'valid_'.repeat(30)
    const read = vi.fn(async (_user: string, ref: SettingsSubjectRef) => agent(ref.id))
    const sources = { listIds: async (_user: string, kind: string) => kind === 'primary' ? [long, 'normal'] : ['odd.id'], read }
    const captured = await createSettingsSubjectResolver(sources)({ allAgents: true, except: [{ kind: 'primary', id: 'normal' }] }, context())
    expect(captured.entries).toEqual([
      expect.objectContaining({ subject: { kind: 'primary', id: long }, status: 'available' }),
      { subject: { kind: 'subagent', id: 'odd.id' }, status: 'unavailable', reason: 'unsupported_subject_id' }
    ])
    expect(read).toHaveBeenCalledTimes(1)
    read.mockClear()
    const fresh = await createSettingsSubjectResolver(sources, captured)(undefined, context())
    expect(fresh.entries).toEqual(captured.entries)
    expect(fresh.excluded).toEqual(captured.excluded)
    expect(read).toHaveBeenCalledTimes(1)
    await expect(createSettingsSubjectResolver(sources)({ subjects: [{ kind: 'subagent', id: 'odd.id' }] }, context())).rejects.toThrow()
  })

})
