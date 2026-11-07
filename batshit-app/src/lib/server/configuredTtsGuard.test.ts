import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { agentTypeSnapshotOf, runAgentUpdateScriptTwin } from '$lib/test-utils/agentUpdateScriptTwin'
import { agentUpdateScriptArguments, planAgentRecordUpdate } from './agentRecordUpdate'
import { CONFIGURED_TTS_READ_PATHS, configuredTtsSnapshotFromDetail, configuredTtsIssueGuard, planConfiguredTtsOps, type ConfiguredTtsMutation, type TtsSourceGuard } from './configuredTtsGuard'
import { captureSettingsLifecycle, withSettingsRecordReplacement } from './services/appActions/settings/lifecycle'
import { normalizeAgentVoiceProfile } from '$lib/utils/voiceSchema'
const id = 'a10_guard', key = `agent:${id}`
const row = (voice_profile: unknown) => ({ id, user_id: 'a10_user', agentType: 'api', created_at: '2026-10-17', voice_profile })
const snapshot = (record: Record<string, unknown>) => configuredTtsSnapshotFromDetail(id, record, CONFIGURED_TTS_READ_PATHS.map(path => agentTypeSnapshotOf(record, [path])), captureSettingsLifecycle([key]))
function run(record: Record<string, unknown>, selection: ConfiguredTtsMutation['selection'], original = snapshot(record), sources: TtsSourceGuard[] = [], dependencies?: Readonly<Record<number, Record<string, unknown>>>) {
  const plan = planAgentRecordUpdate({ updates: {}, now: '2026-10-17' }); plan.ops.push(...planConfiguredTtsOps(original, selection))
  const mutation: ConfiguredTtsMutation = { target: original, selection, sources, sourceLifecycle: captureSettingsLifecycle([]), check() {}, signal: new AbortController().signal,
    deadlineAt: Date.now() + 10000, authority: { key, paths: [['$.user_id', '["a10_user"]']] } }
  const guard = configuredTtsIssueGuard(original, original.revision, [key], mutation)
  return runAgentUpdateScriptTwin(record, agentUpdateScriptArguments(plan, agentTypeSnapshotOf(record), null, undefined, undefined, undefined, undefined, guard), undefined, dependencies)
}
describe('configured TTS raw selection owner', () => {
  it('preserves unrelated nested raw values and clears active aliases without normalizing the record', () => {
    const voice = { schemaVersion: 17, stt: { future: [1], providerId: 'browser' }, realtimeStt: null, voiceMode: { inputMode: 'text', future: true }, voiceSessionRuntime: 'direct',
      future: { keep: 'literal' }, tts: { provider: 'fish', model: 'old', voiceId: 'old', profileId: 'old_profile', narration: { future: true, italicBehavior: 'silent' }, style: { exact: [1] },
        common: { speed: 0 }, providerOptions: { fish: { reference_id: 'old', temperature: 0 }, future: { keep: false } } } }
    const result = run(row(voice), { providerId: 'fish', modelId: null, voiceId: null, profileId: null })
    expect(result.answer).toBe('OK')
    expect(result.record.voice_profile).toEqual({ ...voice, tts: { narration: voice.tts.narration, style: voice.tts.style, common: voice.tts.common,
      providerId: 'fish', providerOptions: { fish: { temperature: 0 }, future: { keep: false } } } })
    expect(normalizeAgentVoiceProfile(result.record.voice_profile)?.tts?.voiceId).toBeUndefined()
  })
  it('bridges legacy style/narration once and retains empty nested TTS to prevent selector resurrection', () => {
    const voice = { provider: 'openai', model: 'tts-1', voiceId: 'alloy', profileId: 'legacy', style: { speed: 0.8, future: 'keep' }, ttsItalicNarrationBehavior: 'silent', sttProvider: 'browser', custom: [0, false] }
    const result = run(row(voice), { providerId: null, modelId: null, voiceId: null, profileId: null })
    expect(result.answer).toBe('OK')
    expect(result.record.voice_profile).toEqual({ ...voice, tts: { style: voice.style, narration: { italicBehavior: 'silent' } } })
    expect(normalizeAgentVoiceProfile(result.record.voice_profile)?.tts).toMatchObject({ common: { speed: 0.8 }, narration: { italicBehavior: 'silent' } })
    expect(normalizeAgentVoiceProfile(result.record.voice_profile)?.tts?.providerId).toBeUndefined()
  })
  it('does not delete a dormant Fish option belonging to another provider', () => {
    const original = row({ tts: { providerId: 'google', voiceId: 'Kore', providerOptions: { fish: { reference_id: 'dormant' } } } })
    expect(run(original, { providerId: 'openai', modelId: null, voiceId: 'alloy', profileId: null }).record.voice_profile).toMatchObject({ tts: { providerOptions: { fish: { reference_id: 'dormant' } } } })
  })
  it('rejects an old human selection token before any sibling write', () => {
    const before = row({ tts: { providerId: 'openai', voiceId: 'alloy' }, stt: { providerId: 'browser' } }), original = snapshot(before)
    const changed = row({ tts: { providerId: 'openai', voiceId: 'cedar' }, stt: { providerId: 'browser' } })
    expect(run(changed, { providerId: null, modelId: null, voiceId: null, profileId: null }, original)).toEqual({ answer: 'TTS_SELECTION_CHANGED', record: changed })
  })
  it('guards opaque private-source fingerprints and their byte limit at final issue', () => {
    const record = row({ tts: { providerId: 'google', voiceId: 'Kore' } }), original = snapshot(record)
    const dependency = { id: 'private_profile', settings: { privateOption: 'ORIGINAL_PRIVATE_VALUE' } }
    const raw = agentTypeSnapshotOf(dependency, ['$']), fingerprint = createHash('sha1').update(raw).digest('hex')
    const guard = { key: 'voice_profile:private_profile', path: '$', fingerprint, byteLimit: Buffer.byteLength(raw) }
    const next = { providerId: 'browser', modelId: null, voiceId: null, profileId: null }
    expect(run(record, next, original, [guard], { 2: dependency }).answer).toBe('OK')
    expect(run(record, next, original, [guard], { 2: { ...dependency, settings: { privateOption: 'CHANGED_PRIVATE_VALUE' } } })).toEqual({ answer: 'TTS_SELECTION_CHANGED', record })
    expect(run(record, next, original, [{ ...guard, byteLimit: Buffer.byteLength(raw) - 1 }], { 2: dependency })).toEqual({ answer: 'TTS_SELECTION_CHANGED', record })
    expect(JSON.stringify(guard)).not.toContain('PRIVATE_VALUE')
  })
  it('does not revive a report after same-id replacement or accept malformed relevant parents/leaves', async () => {
    const original = snapshot(row({ tts: { providerId: 'openai' } }))
    await withSettingsRecordReplacement(key, async () => {})
    expect(() => configuredTtsIssueGuard(snapshot(row({ tts: { providerId: 'openai' } })), original.revision, [key])).toThrow()
    for (const voice of [[], { tts: 1 }, { tts: { providerId: { raw: 'bad' } } }]) expect(() => snapshot(row(voice))).toThrow()
  })
  it('BL-1683 admits automatic top-level delnull on an ordinary save but guards an explicit whole-null delete', () => {
    const record = row({ tts: { providerId: 'google', voiceId: 'Kore' }, stt: { future: [0] } })
    const ordinary = planAgentRecordUpdate({ updates: { displayName: 'Ordinary change' }, now: '2026-10-18' })
    expect(runAgentUpdateScriptTwin(record, agentUpdateScriptArguments(ordinary, agentTypeSnapshotOf(record)))).toMatchObject({ answer: 'OK', record: { displayName: 'Ordinary change', voice_profile: record.voice_profile } })
    const explicit = planAgentRecordUpdate({ updates: { displayName: 'Must not save', voice_profile: null }, now: '2026-10-18' })
    expect(runAgentUpdateScriptTwin(record, agentUpdateScriptArguments(explicit, agentTypeSnapshotOf(record)))).toEqual({ answer: 'TTS_SELECTION_BASE_REQUIRED', record })
  })
})
