// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { BUILTIN_VOICE_PROVIDER_IDS } from '$lib/data/builtinVoiceCatalog'
import type { BuiltinVoiceCatalogSnapshot, VoiceCatalogView } from '$lib/types/builtinVoiceCatalog'
import { bundledVoiceCatalogEntries, selectedVoiceCatalogCompatibility } from '$lib/utils/builtinVoiceCatalogProjection'
import { voiceCatalogRevision } from '$lib/utils/builtinVoiceCatalog'
import { agentTypeSnapshotOf, runAgentUpdateScriptTwin } from '$lib/test-utils/agentUpdateScriptTwin'
import { agentUpdateScriptArguments, planAgentRecordUpdate } from './agentRecordUpdate'
import { configuredTtsIssueGuard, configuredTtsSnapshotFromDetail, CONFIGURED_TTS_READ_PATHS, planConfiguredTtsOps } from './configuredTtsGuard'
import { captureSettingsLifecycle } from './services/appActions/settings/lifecycle'
import { matchesVoiceCatalogSelectionGuard, sameVoiceCatalogSelection, voiceCatalogSelectionGuard } from './voiceCatalogSelectionGuard'

const bundled: VoiceCatalogView = { snapshot: null, source: 'bundled', checkedAt: null }
const at = '2026-10-28T03:00:00.000Z'
async function view(sequence = 1): Promise<VoiceCatalogView> {
  const providers = Object.fromEntries(BUILTIN_VOICE_PROVIDER_IDS.map(id => [id, id === 'browser'
    ? { sourceStatus: 'runtime-owned', discoveryCoverage: 'not-applicable', qualificationCoverage: 'not-applicable', lastAttemptAt: at, sourceUrls: [], entries: [] }
    : { sourceStatus: 'blocked', discoveryCoverage: 'unknown', qualificationCoverage: 'pending', lastAttemptAt: at, sourceUrls: [], failure: 'incomplete', entries: bundledVoiceCatalogEntries(id) }])) as BuiltinVoiceCatalogSnapshot['providers']
  const snapshot: BuiltinVoiceCatalogSnapshot = { schemaVersion: 1, generation: 1, sequence, revision: '0'.repeat(64), generatedAt: at, providers }
  snapshot.revision = await voiceCatalogRevision(snapshot)
  return { snapshot, source: 'retained', checkedAt: at }
}
const raw = (view: VoiceCatalogView) => JSON.stringify({ schemaVersion: 1, checkedAt: at, snapshot: view.snapshot })
const guardFor = (view: VoiceCatalogView) => voiceCatalogSelectionGuard(view, 'openai', 'tts-batch', 'gpt-4o-mini-tts')

function issue(source: ReturnType<typeof guardFor>, dependency?: unknown) {
  const id = 'catalog_guard_subject', key = `agent:${id}`
  const record = { id, user_id: 'u', agentType: 'api', created_at: at, voice_profile: { tts: { providerId: 'browser' }, stt: { future: [0, false] }, future: 'keep' } }
  const snapshot = configuredTtsSnapshotFromDetail(id, record, CONFIGURED_TTS_READ_PATHS.map(path => agentTypeSnapshotOf(record, [path])), captureSettingsLifecycle([key]))
  const selection = { providerId: 'openai', modelId: 'gpt-4o-mini-tts', voiceId: 'alloy', profileId: null }
  const plan = planAgentRecordUpdate({ updates: {}, now: at }); plan.ops.push(...planConfiguredTtsOps(snapshot, selection))
  const guard = configuredTtsIssueGuard(snapshot, snapshot.revision, [key], { target: snapshot, selection, sources: [source], sourceLifecycle: captureSettingsLifecycle([]), check() {},
    signal: new AbortController().signal, deadlineAt: Date.now() + 10000, authority: { key, paths: [['$.user_id', '["u"]']] } })
  return { before: record, result: runAgentUpdateScriptTwin(record, agentUpdateScriptArguments(plan, agentTypeSnapshotOf(record), null, undefined, undefined, undefined, undefined, guard), undefined,
    dependency === undefined ? undefined : { 2: { __voiceCatalogString: dependency } }) }
}

describe('selected catalog compatibility at the existing TTS physical write', () => {
  it('permits bundled absence to become identical persisted metadata, but refuses later disappearance', async () => {
    const remote = await view(), absent = guardFor(bundled), present = guardFor(remote)
    expect(sameVoiceCatalogSelection(absent.voiceCatalog, present.voiceCatalog)).toBe(true)
    expect(issue(absent).result.answer).toBe('OK')
    expect(issue(absent, raw(remote)).result.answer).toBe('OK')
    const missing = issue(present)
    expect(missing.result).toEqual({ answer: 'TTS_SELECTION_CHANGED', record: missing.before })
  })

  it('keeps a held selection valid through unrelated publication/order/provider/attempt changes', async () => {
    const before = await view(), after = await view(2)
    after.snapshot!.providers.fish.lastAttemptAt = '2026-10-28T03:01:00.000Z'
    after.snapshot!.revision = await voiceCatalogRevision(after.snapshot!)
    const guard = guardFor(before)
    expect(sameVoiceCatalogSelection(guard.voiceCatalog, guardFor(after).voiceCatalog)).toBe(true)
    expect(issue(guard, raw(after)).result.answer).toBe('OK')
    expect(JSON.stringify(guard)).not.toContain('revision')
    expect(JSON.stringify(guard)).not.toContain('lastAttemptAt')
  })

  it.each(['blocked', 'candidate-contract-changed', 'candidate-profile-unavailable', 'unknown-profile', 'duplicate', 'missing-date', 'missing-evidence', 'invalid-provenance'])('refuses selected semantic/required-shape drift before any sibling write: %s', async change => {
    const before = await view(), after = await view(2), entry = after.snapshot!.providers.openai.entries.find(entry => entry.modelId === 'gpt-4o-mini-tts')!
    if (change === 'blocked') Object.assign(entry, { admission: 'blocked', blockedReason: 'contract-changed' })
    if (change === 'candidate-contract-changed') Object.assign(entry, { admission: 'candidate', blockedReason: 'contract-changed' })
    if (change === 'candidate-profile-unavailable') Object.assign(entry, { admission: 'candidate', blockedReason: 'profile-unavailable' })
    if (change === 'unknown-profile') entry.compatibilityProfileId = 'openai.future.v2'
    if (change === 'duplicate') after.snapshot!.providers.openai.entries.push(structuredClone(entry))
    if (change === 'missing-date') delete (entry as Partial<typeof entry>).qualifiedAt
    if (change === 'missing-evidence') Object.assign(entry, { provenance: 'qualified-source', qualifiedAt: at, evidenceUrls: [] })
    if (change === 'invalid-provenance') Object.assign(entry, { provenance: 'private-account' })
    const result = issue(guardFor(before), raw(after))
    expect(result.result).toEqual({ answer: 'TTS_SELECTION_CHANGED', record: result.before })
  })

  it.each(['{bad', ' '.repeat(1049601), 1, {}])('refuses unreadable or wrong-type persisted selected facts', async value => {
    const result = issue(guardFor(await view()), value)
    expect(result.result).toEqual({ answer: 'TTS_SELECTION_CHANGED', record: result.before })
  })

  it('retains exact existing Deepgram public voice bindings without prefix or model-family grants', async () => {
    const aura = voiceCatalogSelectionGuard(bundled, 'deepgram', 'tts-batch', 'aura-2-thalia-en')
    expect(aura.voiceCatalog.expected.profile).toBe('deepgram.aura-rest.v1')
    expect(voiceCatalogSelectionGuard(bundled, 'deepgram', 'tts-batch', 'flux-hannah-en').voiceCatalog.expected.profile).toBe('deepgram.flux-rest.v1')
    expect(selectedVoiceCatalogCompatibility(bundled, 'deepgram', 'tts-batch', 'aura-invented').state).toBe('unlisted')
    const remote = await view()
    remote.snapshot!.providers.deepgram.entries.push({ modelId: 'aura-2-thalia-en', lane: 'tts-batch', label: 'voice', admission: 'blocked', blockedReason: 'contract-changed', qualifiedAt: null, provenance: 'bundled-legacy', evidenceUrls: [], release: 'unknown' })
    expect(() => voiceCatalogSelectionGuard(remote, 'deepgram', 'tts-batch', 'aura-2-thalia-en')).toThrow('tts_catalog_compatibility_unavailable')
    expect(matchesVoiceCatalogSelectionGuard(aura.voiceCatalog, raw(remote))).toBe(false)
    remote.snapshot!.providers.deepgram.entries.at(-1)!.admission = 'candidate'
    expect(() => voiceCatalogSelectionGuard(remote, 'deepgram', 'tts-batch', 'aura-2-thalia-en')).toThrow('tts_catalog_compatibility_unavailable')
    expect(matchesVoiceCatalogSelectionGuard(aura.voiceCatalog, raw(remote))).toBe(false)
  })
})


describe('selected installed rule eligibility', () => {
  it('refuses a known new contract until attested and retains its selected rule through the physical guard', async () => {
    const before = await view(), entries = before.snapshot!.providers.cartesia.entries
    const entry = entries.find(row => row.modelId === 'sonic-3.6')!
    expect(() => voiceCatalogSelectionGuard(before, 'cartesia', 'tts-batch', entry.modelId)).toThrow('tts_catalog_compatibility_unavailable')
    Object.assign(entry, { admission: 'qualified', compatibilityProfileId: 'cartesia.bytes-20260814.v1', qualificationRuleId: 'cartesia.sonic-36-docs.v1', qualifiedAt: at, provenance: 'qualified-source', evidenceUrls: ['https://docs.cartesia.ai/api-reference/tts/bytes.md'] })
    const guard = voiceCatalogSelectionGuard(before, 'cartesia', 'tts-batch', entry.modelId)
    expect(matchesVoiceCatalogSelectionGuard(guard.voiceCatalog, raw(before))).toBe(true)
    const after = structuredClone(before)
    after.snapshot!.providers.cartesia.entries = after.snapshot!.providers.cartesia.entries.filter(row => row.modelId !== entry.modelId)
    expect(selectedVoiceCatalogCompatibility(after, 'cartesia', 'tts-batch', entry.modelId).state).toBe('candidate')
    expect(matchesVoiceCatalogSelectionGuard(guard.voiceCatalog, raw(after))).toBe(false)
  })
  it('keeps a newly attested compatible model stable across dates, refusing a missing/unknown rule', async () => {
    const before = await view(), entry = { modelId: 'New.Exact-ID', label: 'New', lane: 'tts-direct-stream' as const, admission: 'qualified' as const, compatibilityProfileId: 'fish.timestamp-sse.v1', qualificationRuleId: 'fish.timestamp-schema.v1', qualifiedAt: at, provenance: 'qualified-source' as const, evidenceUrls: ['https://docs.fish.audio/api-reference/openapi.json'], release: 'unknown' as const }
    before.snapshot!.providers.fish.entries.push(entry)
    const guard = voiceCatalogSelectionGuard(before, 'fish', 'tts-direct-stream', entry.modelId)
    expect(guard.voiceCatalog.expected.eligible).toBe(true)
    const after = structuredClone(before); after.snapshot!.sequence++
    after.snapshot!.providers.fish.entries.at(-1)!.qualifiedAt = '2026-10-28T03:02:00.000Z'
    expect(matchesVoiceCatalogSelectionGuard(guard.voiceCatalog, raw(after))).toBe(true)
    for (const rule of [undefined, '', 'future.unknown.v2']) {
      after.snapshot!.providers.fish.entries.at(-1)!.qualificationRuleId = rule
      expect(matchesVoiceCatalogSelectionGuard(guard.voiceCatalog, raw(after))).toBe(false)
    }
  })
  it('does not resurrect an exact legacy model through a candidate unknown-rule fallback', async () => {
    const current = await view(), entry = current.snapshot!.providers.openai.entries.find(entry => entry.modelId === 'gpt-4o-mini-tts')!
    Object.assign(entry, { admission: 'candidate', qualificationRuleId: 'future.unknown.v2', compatibilityProfileId: undefined })
    expect(selectedVoiceCatalogCompatibility(current, 'openai', 'tts-batch', entry.modelId).state).toBe('candidate')
    expect(() => guardFor(current)).toThrow('tts_catalog_compatibility_unavailable')
    expect(matchesVoiceCatalogSelectionGuard(guardFor(bundled).voiceCatalog, raw(current))).toBe(false)
  })
  it('refuses lost selected rule eligibility at the existing twin write without sibling changes', async () => {
    const before = await view(), after = await view(2)
    after.snapshot!.providers.openai.entries.find(entry => entry.modelId === 'gpt-4o-mini-tts')!.qualificationRuleId = 'future.unknown.v2'
    const result = issue(guardFor(before), raw(after))
    expect(result.result).toEqual({ answer: 'TTS_SELECTION_CHANGED', record: result.before })
  })
})
