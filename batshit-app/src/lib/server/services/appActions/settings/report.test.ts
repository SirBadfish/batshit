import { describe, expect, it } from 'vitest'
import { SETTINGS_REPORT_BYTE_LIMITS, settingsSubjectKey, type SettingsSubjectRef } from '$lib/appActions/settings/reportContract'
import { createSettingsSubjectResolver, type SettingsReportReadContext } from './subjects'
import { createSettingsReportSnapshot, settingsReportSerializedBytes } from './report'

function fixture(count = 3) {
  const records = new Map<string, Record<string, unknown>>()
  for (let i = 0; i < count; i++) records.set(`primary:a${i}`, {
    id: `a${i}`, user_id: 'owner', agentType: 'api', displayName: `Agent ${i}`, memory_enabled: false,
    memory_lane_budgets: { on_my_mind: 0, triggers: 1200, recalled: 2400 }, system_prompt: 'PRIVATE INSTRUCTIONS', apiKey: 'PRIVATE KEY'
  })
  const context: SettingsReportReadContext = { userId: 'owner', canRead: () => true, check() {} }
  const sources = {
    listIds: async (_user: string, kind: string) => [...records.values()].filter(row => (kind === 'primary' ? row.agentType : row.subagentType) !== undefined).map(row => String(row.id)),
    read: async (_user: string, ref: SettingsSubjectRef) => records.get(settingsSubjectKey(ref)) ?? null
  }
  const resolve = createSettingsSubjectResolver(sources)
  return { records, context, sources, resolve }
}
describe('internal bounded Agent Settings report snapshot', () => {
  it('keeps instruction summaries metadata-only and never groups different equal-length prompts', async () => {
    const f = fixture(2)
    f.records.get('primary:a0')!.system_prompt = 'UNIQUE_PRIVATE_A'.repeat(20000)
    f.records.get('primary:a1')!.system_prompt = 'UNIQUE_PRIVATE_B'.repeat(20000)
    const page = (await createSettingsReportSnapshot(await f.resolve({ allAgents: true }, f.context),
      { focus: ['agent.instructions'] }, f.context, f.sources)).page()
    expect(page.common).toEqual([])
    expect(page.rows).toHaveLength(2)
    expect(page.rows[0]).toMatchObject({ groups: [{ id: 'agent.instructions', fields: { customPrompt: {
      stored: 'set', codeUnits: 320000, utf8Bytes: null, read: 'too_large' }, includeGlobalPrompt: { effective: { value: true } } } }] })
    expect(JSON.stringify(page)).not.toMatch(/UNIQUE_PRIVATE|system_prompt|promptPreimage/)
    expect(settingsReportSerializedBytes(page)).toBeLessThanOrEqual(8192)
  })
  it('reports common values once, preserves zero/false/unset and never copies unadopted data', async () => {
    const f = fixture()
    const manifest = await f.resolve({ allAgents: true }, f.context)
    const snapshot = await createSettingsReportSnapshot(manifest, {}, f.context, f.sources)
    const page = snapshot.page()
    expect(page.common.find(group => group.id === 'agent.memory.preferences')).toMatchObject({ id: 'agent.memory.preferences', matchingSubjects: 3,
      fields: { enabled: { stored: { state: 'set', value: false }, effective: { state: 'known', value: false }, source: 'agent' },
        onMyMind: { stored: { state: 'set', value: 0 }, effective: { state: 'known', value: 0 } },
        triggerLingerTurns: { stored: { state: 'unset' }, effective: { state: 'known', value: 2 }, source: 'factory' } } })
    expect(page.rows[0]).toMatchObject({ groups: [{ id: 'agent.voice.tts-selection', status: 'unavailable', reason: 'tts_source_unavailable' }, { id: 'agent.context.auto-compact', common: true }, { id: 'agent.instructions', fields: { customPrompt: { stored: 'set', read: 'available' } } }, { id: 'agent.model.selection', common: true }, { id: 'agent.model.preset-copy' }, { id: 'agent.identity' }, { id: 'agent.memory.preferences', common: true },
      { id: 'agent.reasoning.presentation', common: true }, { id: 'agent.reasoning.retention', common: true }] })
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE|system_prompt|apiKey|expectedRevision|operationRef/)
    expect(page.change).toBe('not-integrated')
    expect(settingsReportSerializedBytes(page)).toBeLessThanOrEqual(SETTINGS_REPORT_BYTE_LIMITS.summary)
  })
  it('uses actual memory precedence and makes malformed containers/values unknown rather than factory defaults', async () => {
    const f = fixture(3)
    f.records.set('primary:a0', { ...f.records.get('primary:a0'), memory_lane_budgets: null, memoryLaneBudgets: { recalled: 0 }, memory_enabled: 'bad', memoryEnabled: false })
    f.records.set('primary:a1', { ...f.records.get('primary:a1'), memory_lane_budgets: 'bad' })
    f.records.set('primary:a2', { ...f.records.get('primary:a2'), memory_lane_budgets: { recalled: -1 }, memory_linger_turns: false })
    const snapshot = await createSettingsReportSnapshot(await f.resolve({ allAgents: true }, f.context), { focus: ['agent.memory.preferences'], detail: 'values' }, f.context, f.sources)
    const rows = snapshot.page().rows as any[]
    expect(rows[0].groups[0].fields.recalled).toMatchObject({ stored: { state: 'set', value: 0 }, effective: { value: 0 } })
    expect(rows[0].groups[0].fields.enabled.stored.value).toBe(false)
    expect(rows[1].groups[0]).toMatchObject({ status: 'unavailable', reason: 'invalid_memory_budget_container' })
    expect(rows[2].groups[0].fields.recalled).toMatchObject({ stored: { state: 'invalid' }, effective: { state: 'unknown' } })
    expect(rows[2].groups[0].fields.triggerLingerTurns.effective.state).toBe('unknown')
  })
  it('keeps Subagent name support while identifying its Primary-only memory boundary', async () => {
    const f = fixture(0)
    f.records.set('subagent:child', { id: 'child', user_id: 'owner', displayName: 'Workflow', subagentType: 'api', slug: 'unchanged' })
    // SA-139 R2: the removed n8n Workflow Subagent type is an unsupported subject, not a live Subagent.
    f.records.set('subagent:retired', { id: 'retired', user_id: 'owner', displayName: 'Retired', subagentType: 'n8n-workflow' })
    const page = (await createSettingsReportSnapshot(await f.resolve({ allAgents: true }, f.context), {}, f.context, f.sources)).page()
    expect(page.rows[0]).toMatchObject({ type: 'api', groups: [
      { id: 'agent.voice.tts-selection', status: 'unavailable', reason: 'tts_primary_only' },
      { id: 'agent.context.auto-compact', status: 'unavailable', reason: 'auto_compact_primary_only' },
      { id: 'agent.instructions', status: 'available', fields: { includeGlobalPrompt: { effective: { value: false } } } },
      { id: 'agent.model.selection', status: 'available' },
      { id: 'agent.model.preset-copy' },
      { id: 'agent.identity', fields: { displayName: { effective: { value: 'Workflow' } } } },
      { id: 'agent.memory.preferences', status: 'unavailable', reason: 'memory_is_primary_only' },
      { id: 'agent.reasoning.presentation', status: 'unavailable', reason: 'api_primary_only' },
      { id: 'agent.reasoning.retention', status: 'unavailable', reason: 'api_primary_only' }
    ] })
    expect(page.rows[1]).toEqual({ subject: { kind: 'subagent', id: 'retired' }, status: 'unavailable', reason: 'unsupported_subject_type' })
    expect(JSON.stringify(page)).not.toContain('slug')
  })
  it.each(['summary', 'values', 'choices'] as const)('pages %s under the actual serialized UTF-8 budget without losing targets/exclusions', async detail => {
    const f = fixture(256)
    for (let i = 0; i < 256; i++) f.records.get(`primary:a${i}`)!.displayName = '🖤'.repeat(100)
    const manifest = await f.resolve({ allAgents: true, except: [{ kind: 'primary', id: 'a0' }] }, f.context)
    const snapshot = await createSettingsReportSnapshot(manifest, { detail }, f.context, f.sources)
    const seen: string[] = []
    let page = snapshot.page()
    let pages = 0
    while (true) {
      pages++
      expect(settingsReportSerializedBytes(page)).toBeLessThanOrEqual(SETTINGS_REPORT_BYTE_LIMITS[detail])
      expect(page.rows.length).toBeLessThanOrEqual(64)
      expect(Object.isFrozen(page.common)).toBe(true)
      seen.push(...page.rows.map(row => settingsSubjectKey(row.subject)))
      expect(page.continuation.totalRows).toBe(256)
      if (!page.continuation.nextCursor) break
      page = snapshot.page(page.continuation.nextCursor)
    }
    expect(pages).toBeGreaterThan(1)
    expect(new Set(seen).size).toBe(256)
    expect(seen).toHaveLength(256)
    expect(manifest.entries).toHaveLength(255)
    expect(manifest.excluded).toHaveLength(1)
  })
  it('holds pages stable across later data changes, rejects another snapshot cursor and fails after revocation', async () => {
    const f = fixture(100)
    const manifest = await f.resolve({ allAgents: true }, f.context)
    const snapshot = await createSettingsReportSnapshot(manifest, {}, f.context, f.sources)
    const first = snapshot.page()
    f.records.get('primary:a0')!.displayName = 'changed later'
    expect(snapshot.page()).toEqual(first)
    const other = await createSettingsReportSnapshot(manifest, { detail: 'choices' }, f.context, f.sources)
    expect(() => other.page(first.continuation.nextCursor!)).toThrow('cursor_snapshot_mismatch')
    f.context.canRead = () => false
    expect(() => snapshot.page(first.continuation.nextCursor!)).toThrow('report_admission_changed')
  })
  it('rechecks owner/type after resolution and does not return a foreign or changed record', async () => {
    const f = fixture(2)
    const manifest = await f.resolve({ allAgents: true }, f.context)
    f.records.get('primary:a0')!.user_id = 'other'
    f.records.get('primary:a1')!.agentType = 'cli'
    const page = (await createSettingsReportSnapshot(manifest, {}, f.context, f.sources)).page()
    expect(page.rows.every(row => row.status === 'unavailable')).toBe(true)
    expect(page.manifest.unavailable).toBe(2)
    expect(JSON.stringify(page)).not.toContain('Agent 0')
  })
})
