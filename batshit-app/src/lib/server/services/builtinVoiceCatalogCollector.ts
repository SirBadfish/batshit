import { BUILTIN_VOICE_CATALOG_CONTEXT, BUILTIN_VOICE_CATALOG_RULES, BUILTIN_VOICE_PROVIDER_IDS } from '$lib/data/builtinVoiceCatalog'
import type { BuiltinVoiceCatalogEntry, BuiltinVoiceCatalogSnapshot, BuiltinVoiceLane, BuiltinVoiceProviderCatalog, BuiltinVoiceProviderId } from '$lib/types/builtinVoiceCatalog'
import { bundledVoiceCatalogEntries } from '$lib/utils/builtinVoiceCatalogProjection'
import { canRequalifyVoiceCatalogEntry, mergeVoiceCatalogRecoveryAnchors, runVoiceCatalogCasAttempt, voiceCatalogCompatibilityFacts, voiceCatalogEntryCompatibility, voiceCatalogEntryHasRestriction, voiceCatalogEntryIdentity, voiceCatalogEvaluatedEntryFacts, voiceCatalogRestrictionFacts } from '$lib/utils/builtinVoiceCatalog'
import { inspectFishTimestampOpenApi } from './builtinVoiceCatalogSources'
import { inspectMistralAudioDocuments, inspectMistralSmallIdentity } from './builtinVoiceCatalogMistralSource'
import { inspectDeepgramPublicModels, inspectElevenLabsPublicModels } from './builtinVoiceCatalogPublicModelSources'
import { inspectCartesiaVoiceDocument, inspectMinimaxVoiceDocument, inspectMistralVoiceApi, voiceSourceCodeId, voiceSourceHtml, voiceSourceIdentity, voiceSourceTable } from './builtinVoiceCatalogDocuments'
import { inspectAlibabaVoiceInventory, inspectAsyncVoiceInventory, inspectGoogleVoiceInventory, inspectOpenaiVoiceInventory, inspectStepfunVoiceInventory, type VoiceInventoryModel } from './builtinVoiceCatalogInventory'
import { inspectOpenaiRecordedOperation, inspectOpenaiRecordedSource, inspectElevenMedicalSource, inspectAsyncRecordedSource } from './builtinVoiceCatalogRecordedSources'
import { inspectAsyncRecordedOperation } from './builtinVoiceCatalogAsyncOperation'
import { inspectGemini38TtsSources, inspectQwenAudioTtsSources } from './builtinVoiceCatalogGoogleQwenSources'
import { inspectCartesia36Source, inspectElevenV4Source, inspectInworldFlashSource, inspectStep3Source, cartesia36ContractChanged, elevenV4ContractChanged, inworldFlashContractChanged, step3ContractChanged } from './builtinVoiceCatalogSpeechSources'
import { readVoiceSourceBody, VOICE_SOURCE_HTTP_CONTRACTS, type VoiceSourceBodyRead, type VoiceSourceHttpKey } from './builtinVoiceCatalogSourceHttp'
import type { VoiceCatalogStringStore } from './builtinVoiceCatalogStore'

const roster = Object.freeze({
  browser: [], google: ['googleSpeech','googleTranscribe'], openai: ['openaiSpeech','openaiTranscribe','openaiFile'],
  elevenlabs: ['elevenlabsModels','elevenlabsDocs','elevenlabsSpeechV4','elevenlabsSpeechApi'], deepgram: ['deepgramLatest','deepgramAll'], fish: ['fishTimestamp'],
  mistral: ['mistralInventory','mistralSpeech','mistralTranscribe','mistralMigration','mistralApi','mistralSmallModel','mistralChangelog'], minimax: ['minimaxSpeech'],
  mimo: ['mimoSpeech'], alibaba: ['alibabaSpeech','alibabaAudioHttp','alibabaAudioVoices','alibabaAudioModels','alibabaOssHttps','alibabaOssV1','alibabaOssV4'], inworld: ['inworldModels','inworldSpeech','inworldSteering'], cartesia: ['cartesiaModels','cartesiaBytes'],
  async: ['asyncModels','asyncTranscribe'], stepfun: ['stepfunSpeech','stepfunGlobalCookbook','stepfunApi'], azure: ['azureSpeech']
} as const satisfies Record<BuiltinVoiceProviderId, readonly VoiceSourceHttpKey[]>)
type Report = Readonly<{ providerId: BuiltinVoiceProviderId; status: 'current' | 'changed' | 'blocked' | 'runtime-owned'; discovery: BuiltinVoiceProviderCatalog['discoveryCoverage']; pending: number; followUp: 'none' | 'source-incomplete' | 'adapter-contract' }>
const unique = <T>(values: T[]) => [...new Set(values)]
const displayLabel = (modelId: string): string => {
  let label = '', bytes = 0
  for (const point of modelId) {
    const size = Buffer.byteLength(point, 'utf8')
    if (bytes + size > 200) break
    label += point; bytes += size
  }
  return label
}
/** Report installed eligibility and lifecycle changes, excluding source/issuer/order churn. */
const reportEntryFacts = (providerId: BuiltinVoiceProviderId, entries: readonly BuiltinVoiceCatalogEntry[]) => JSON.stringify(entries.map(entry => [
  voiceCatalogCompatibilityFacts(providerId, entry), entry.release, entry.shutdownAt ? Date.parse(entry.shutdownAt) : null
]).map(facts => JSON.stringify(facts)).sort())

export type VoiceCatalogRequalificationTarget = Readonly<{ providerId: BuiltinVoiceProviderId; lane: BuiltinVoiceLane; modelId: string; previousCompatibility: string }>

/** One finite roster/source episode. Raw caller assertions are never this producer's authority. */
export function createBuiltinVoiceCatalogCollector(options: { http: typeof fetch; now: () => number; requalify?: readonly VoiceCatalogRequalificationTarget[] }) {
  let ledger = new Set<string>(), report: Report[] = [], used = false
  const getReport = (): readonly Report[] => structuredClone(report)
  const admitEvaluatedEntry = (providerId: BuiltinVoiceProviderId, entry: BuiltinVoiceCatalogEntry) => ledger.has(voiceCatalogEvaluatedEntryFacts(providerId, entry))
  async function collect(previous: BuiltinVoiceCatalogSnapshot | null): Promise<BuiltinVoiceCatalogSnapshot['providers']> {
    if (used) throw new Error('voice_source_episode_already_used')
    used = true; ledger = new Set(); report = []
    if (options.requalify && (!Array.isArray(options.requalify) || options.requalify.length > 16)) throw new Error('invalid_exact_requalification')
    const requalifyTargets: readonly VoiceCatalogRequalificationTarget[] = options.requalify ?? []
    for (const target of requalifyTargets) {
      const old = previous?.providers[target.providerId]?.entries.find(entry => entry.modelId === target.modelId && entry.lane === target.lane)
      if (!old || target.previousCompatibility !== voiceCatalogRestrictionFacts(target.providerId, old)) throw new Error('requalification_predecessor_changed')
    }
    const reads = new Map<VoiceSourceHttpKey, VoiceSourceBodyRead>()
    const keys = unique(Object.values(roster).flat())
    // Bounded concurrency, one GET per fixed key, no retries or source-directed following.
    for (let index = 0; index < keys.length; index += 4) await Promise.all(keys.slice(index, index + 4).map(async key => reads.set(key, await readVoiceSourceBody(key, options.http, options.now))))
    const body = (key: VoiceSourceHttpKey) => { const value = reads.get(key); if (value?.kind !== 'body') throw new Error('source-incomplete'); return value }
    const capture = (key: VoiceSourceHttpKey) => { const value = body(key); return { body: value.body, retrievedAt: value.checkedAt } }
    const providers = {} as BuiltinVoiceCatalogSnapshot['providers']
    for (const providerId of BUILTIN_VOICE_PROVIDER_IDS) {
      const attempt = new Date(options.now()).toISOString()
      if (providerId === 'browser') {
        providers.browser = { sourceStatus: 'runtime-owned', discoveryCoverage: 'not-applicable', qualificationCoverage: 'not-applicable', lastAttemptAt: attempt, sourceUrls: [], entries: [] }
        report.push({ providerId, status: 'runtime-owned', discovery: 'not-applicable', pending: 0, followUp: 'none' }); continue
      }
      const sourceKeys = roster[providerId], urls = sourceKeys.map(key => VOICE_SOURCE_HTTP_CONTRACTS[key].url)
      const entries: BuiltinVoiceCatalogEntry[] = []
      const evaluated = new Set<string>()
      let discovery: 'complete' | 'partial' | 'unknown' = 'partial'
      let incompleteScope = false
      const candidate = (modelId: string, lane: BuiltinVoiceLane, evidenceUrls: string[] = urls, release: BuiltinVoiceCatalogEntry['release'] = 'unknown', shutdownAt?: string) => {
        entries.push({ modelId: voiceSourceIdentity(modelId), label: displayLabel(modelId), lane, admission: 'candidate', qualifiedAt: null, provenance: 'qualified-source', evidenceUrls, release,
          ...(shutdownAt ? { shutdownAt } : {}) })
      }
      const qualified = (modelId: string, ruleId: string, evidenceUrls: string[], checkedAt: string, release: BuiltinVoiceCatalogEntry['release'] = 'unknown') => {
        if (ruleId === 'mistral.small-transcribe-docs.v1' && modelId !== 'voxtral-small-transcribe-3-0') throw new Error('source-incomplete')
        const rule = BUILTIN_VOICE_CATALOG_RULES.find(rule => rule.id === ruleId && rule.providerId === providerId)
        if (!rule) throw new Error('source-incomplete')
        const entry: BuiltinVoiceCatalogEntry = { modelId: voiceSourceIdentity(modelId), label: displayLabel(modelId), lane: rule.lane,
          admission: 'qualified', compatibilityProfileId: rule.compatibilityProfileId, qualificationRuleId: rule.id,
          qualifiedAt: checkedAt, provenance: 'qualified-source', evidenceUrls, release }
        const old = previous?.providers[providerId].entries.find(old => old.lane === entry.lane && old.modelId === entry.modelId)
        const target = requalifyTargets.find(target => target.providerId === providerId && target.lane === entry.lane && target.modelId === entry.modelId)
        if (old && target && previous && voiceCatalogEntryHasRestriction(providerId, old)) {
          const anchors = mergeVoiceCatalogRecoveryAnchors(old.requalifiedFrom, [{ compatibility: target.previousCompatibility,
            order: { generation: previous.generation, sequence: previous.sequence, revision: previous.revision } }])
          if (!anchors) { entries.push({ ...structuredClone(old), evidenceUrls }); return }
          const recovery = { ...entry, requalifiedFrom: anchors }
          if (canRequalifyVoiceCatalogEntry(providerId, old, recovery, previous)) Object.assign(entry, recovery)
        }
        evaluated.add(voiceCatalogEvaluatedEntryFacts(providerId, entry)); entries.push(entry)
      }
      const inventory = (key: VoiceSourceHttpKey, inspect: (source: string) => readonly VoiceInventoryModel[]) => {
        try {
          const observed = inspect(body(key).body)
          for (const model of observed) candidate(model.modelId, model.lane, [VOICE_SOURCE_HTTP_CONTRACTS[key].url], model.release ?? 'unknown', model.shutdownAt)
        } catch { incompleteScope = true }
      }
      const blockPriorProfile = (profile: string, key: VoiceSourceHttpKey, modelId?: string) => {
        for (const old of previous?.providers[providerId].entries ?? []) {
          if (old.admission !== 'qualified' || old.compatibilityProfileId !== profile || modelId && old.modelId !== modelId) continue
          const blocked: BuiltinVoiceCatalogEntry = { ...old, admission: 'blocked', blockedReason: 'contract-changed', evidenceUrls: [VOICE_SOURCE_HTTP_CONTRACTS[key].url] }
          const index = entries.findIndex(entry => entry.modelId === old.modelId && entry.lane === old.lane)
          if (index < 0) entries.push(blocked); else entries[index] = blocked
        }
      }
      try {
        if (providerId === 'google') {
          const speech = reads.get('googleSpeech')
          if (speech?.kind === 'body') {
            const observed = inspectGemini38TtsSources(speech.body)
            if (observed.status === 'changed') blockPriorProfile('google.interactions-tts.v1', 'googleSpeech')
          }
          try {
            const read = body('googleSpeech'), observed = inspectGemini38TtsSources(read.body)
            const qualifiedIds = new Set<string>(observed.status === 'matches' ? observed.modelIds : [])
            for (const model of inspectGoogleVoiceInventory(read.body, 'speech')) {
              if (qualifiedIds.has(model.modelId) && model.lane === 'tts-batch') qualified(model.modelId, 'google.interactions-tts-docs.v1', [VOICE_SOURCE_HTTP_CONTRACTS.googleSpeech.url], read.checkedAt, model.release)
              else if (!entries.some(entry => entry.modelId === model.modelId && entry.lane === model.lane)) candidate(model.modelId, model.lane, [VOICE_SOURCE_HTTP_CONTRACTS.googleSpeech.url], model.release ?? 'unknown', model.shutdownAt)
            }
          } catch { incompleteScope = true }
          inventory('googleTranscribe', source => inspectGoogleVoiceInventory(source, 'transcribe'))
        } else if (providerId === 'openai') {
          inventory('openaiSpeech', source => inspectOpenaiVoiceInventory(source, 'speech'))
          const operation = reads.get('openaiFile')
          if (operation?.kind === 'body' && inspectOpenaiRecordedOperation(operation.body).state === 'changed') blockPriorProfile('openai.file-transcription.v2', 'openaiFile')
          try {
            const read = body('openaiTranscribe'), models = inspectOpenaiVoiceInventory(read.body, 'transcribe')
            const file = reads.get('openaiFile')
            const state = file?.kind === 'body' ? inspectOpenaiRecordedSource(read.body, file.body).state : 'insufficient'
            if (state === 'changed') blockPriorProfile('openai.file-transcription.v2', 'openaiFile')
            for (const model of models) {
              if (model.modelId === 'gpt-transcribe' && model.lane === 'stt-recorded' && file?.kind === 'body' && state === 'matches')
                qualified(model.modelId, 'openai.transcribe-docs.v2', [VOICE_SOURCE_HTTP_CONTRACTS.openaiTranscribe.url, VOICE_SOURCE_HTTP_CONTRACTS.openaiFile.url], [read.checkedAt, file.checkedAt].sort()[0])
              else if (!entries.some(entry => entry.modelId === model.modelId && entry.lane === model.lane)) candidate(model.modelId, model.lane, [VOICE_SOURCE_HTTP_CONTRACTS.openaiTranscribe.url], model.release ?? 'unknown', model.shutdownAt)
            }
            if (file?.kind !== 'body') incompleteScope = true
          } catch { incompleteScope = true }
        } else if (providerId === 'fish') {
          const read = body('fishTimestamp'), observed = inspectFishTimestampOpenApi(read.body, read.checkedAt)
          if (observed.status === 'insufficient') throw new Error('source-incomplete')
          if (observed.status === 'changed') {
            for (const old of previous?.providers.fish.entries ?? bundledVoiceCatalogEntries('fish')) if (old.lane === 'tts-direct-stream') entries.push({ ...old, admission: 'blocked', blockedReason: 'contract-changed', evidenceUrls: [VOICE_SOURCE_HTTP_CONTRACTS.fishTimestamp.url] })
          } else for (const id of observed.modelIds) qualified(id, 'fish.timestamp-schema.v1', [observed.sourceUrl], read.checkedAt)
        } else if (providerId === 'mistral') {
          let api: ReturnType<typeof inspectMistralVoiceApi> | null = null
          try { api = inspectMistralVoiceApi(body('mistralApi').body) } catch { /* Independent inventory/other successful scopes remain visible. */ }
          const available = (key: VoiceSourceHttpKey) => reads.get(key)?.kind === 'body' ? capture(key) : undefined
          const observed = inspectMistralAudioDocuments({ inventory: available('mistralInventory'), tts: available('mistralSpeech'), stt: available('mistralTranscribe'), migration: available('mistralMigration') }, options.now())
          const inventoryComplete = observed.inventory.structuralCoverage === 'complete-designated-table'
          if (!inventoryComplete) { incompleteScope = true; discovery = 'unknown' }
          const facets = (...names: (keyof typeof observed.facets)[]) => names.every(name => observed.facets[name].state === 'matches')
          for (const model of inventoryComplete ? observed.models : []) {
            const consistent = observed.subjectComparisons.some(item => item.subject === model.subject && item.state === 'documented')
            const dependencies: VoiceSourceHttpKey[] = model.task === 'tts-batch'
              ? ['mistralInventory','mistralSpeech','mistralMigration','mistralApi'] : ['mistralInventory','mistralTranscribe','mistralMigration','mistralApi']
            const evidence = dependencies.map(key => VOICE_SOURCE_HTTP_CONTRACTS[key].url)
            if (['voxtral-small-transcribe-3-0', 'voxtral-small-transcribe-3', 'voxtral-small-transcribe-latest'].includes(model.modelId) && model.task === 'stt-recorded') candidate(model.modelId, model.task, [VOICE_SOURCE_HTTP_CONTRACTS.mistralInventory.url])
            else if (model.task === 'tts-batch' && consistent && api?.tts && facets('ttsVoiceInput','ttsFormats','ttsAudioData','ttsStyleUnavailable','migrationLegacyVoices')) qualified(model.modelId, 'mistral.speech-docs.v1', evidence, dependencies.map(key => body(key).checkedAt).sort()[0])
            else if (model.task === 'stt-recorded' && consistent && api?.recorded && facets('sttMultipartInput','sttLanguageInput','sttLanguageOutput','sttSegmentTimestamps','migrationSegmentOnly','migrationOverlapWarning')) qualified(model.modelId, 'mistral.transcribe-segments.v2', evidence, dependencies.map(key => body(key).checkedAt).sort()[0])
            else if (model.task === 'tts-batch' || model.task === 'stt-recorded') candidate(model.modelId, model.task, [VOICE_SOURCE_HTTP_CONTRACTS.mistralInventory.url])
          }
          const card = reads.get('mistralSmallModel'), changelog = reads.get('mistralChangelog'), stt = reads.get('mistralTranscribe'), apiSource = reads.get('mistralApi')
          if (card?.kind === 'body' && changelog?.kind === 'body' && stt?.kind === 'body' && apiSource?.kind === 'body' &&
            inspectMistralSmallIdentity(card.body, changelog.body) && api?.recorded && facets('sttMultipartInput','sttLanguageInput','sttLanguageOutput','sttSegmentTimestamps')) {
            const index = entries.findIndex(entry => entry.modelId === 'voxtral-small-transcribe-3-0' && entry.lane === 'stt-recorded')
            if (index >= 0) entries.splice(index, 1)
            qualified('voxtral-small-transcribe-3-0', 'mistral.small-transcribe-docs.v1', ['mistralSmallModel','mistralChangelog','mistralTranscribe','mistralApi'].map(key => VOICE_SOURCE_HTTP_CONTRACTS[key as VoiceSourceHttpKey].url), [card.checkedAt, changelog.checkedAt, stt.checkedAt, apiSource.checkedAt].sort()[0], 'preview')
          }
          for (const lane of ['tts-batch','stt-recorded'] as const) if ((lane === 'tts-batch' ? api?.contracts.tts.state : api?.contracts.recorded.state) === 'changed') {
            for (const old of previous?.providers.mistral.entries ?? bundledVoiceCatalogEntries('mistral')) if (old.lane === lane) {
              const index = entries.findIndex(entry => entry.modelId === old.modelId && entry.lane === lane)
              const blocked: BuiltinVoiceCatalogEntry = { ...old, admission: 'blocked', blockedReason: 'contract-changed', evidenceUrls: [VOICE_SOURCE_HTTP_CONTRACTS.mistralApi.url] }
              if (index < 0) entries.push(blocked); else entries[index] = blocked
            }
          }
        } else if (providerId === 'deepgram') {
          const observed = inspectDeepgramPublicModels({ latest: capture('deepgramLatest'), all: capture('deepgramAll') }, options.now())
          if (observed.pairedCoverage !== 'source-consistent') throw new Error('source-incomplete')
          const groups = new Map<string, typeof observed.observations.all.models>()
          for (const model of observed.observations.all.models) { const key = JSON.stringify([model.kind, model.modelId]); groups.set(key, [...groups.get(key) ?? [], model]) }
          const latest = new Map<string, typeof observed.observations.latest.models>()
          for (const model of observed.observations.latest.models) { const key = JSON.stringify([model.kind, model.modelId]); latest.set(key, [...latest.get(key) ?? [], model]) }
          const checkedAt = sourceKeys.map(key => body(key).checkedAt).sort()[0]
          for (const models of groups.values()) {
            const model = models[0], current = latest.get(JSON.stringify([model.kind, model.modelId]))
            if (model.kind === 'tts' && current?.every(row => row.architecture === 'aura' || row.architecture === 'aura-2')) qualified(model.modelId, 'deepgram.aura-metadata.v1', urls, checkedAt)
            else if (model.kind === 'stt' && current?.every(row => row.batch === true && ['nova','nova-2','nova-3','whisper'].includes(row.architecture ?? ''))) qualified(model.modelId, 'deepgram.recorded-metadata.v1', urls, checkedAt)
            else candidate(model.modelId, model.kind === 'tts' ? 'tts-batch' : 'stt-recorded')
          }
          discovery = 'complete'
        } else if (providerId === 'minimax') {
          const read = body('minimaxSpeech'), observed = inspectMinimaxVoiceDocument(read.body)
          for (const id of observed.models) observed.compatible ? qualified(id, 'minimax.t2a-schema.v1', urls, read.checkedAt) : candidate(id, 'tts-batch')
          if (observed.contract.state === 'changed') for (const old of previous?.providers.minimax.entries ?? bundledVoiceCatalogEntries('minimax')) if (old.lane === 'tts-batch') {
            const index = entries.findIndex(entry => entry.modelId === old.modelId && entry.lane === old.lane)
            const blocked: BuiltinVoiceCatalogEntry = { ...old, admission: 'blocked', blockedReason: 'contract-changed', evidenceUrls: urls }
            if (index < 0) entries.push(blocked); else entries[index] = blocked
          }
          discovery = 'complete'
        } else if (providerId === 'cartesia') {
          const read = reads.get('cartesiaModels'), api = reads.get('cartesiaBytes')
          if (read?.kind === 'body') {
            const supported = new Set(api?.kind === 'body' ? inspectCartesia36Source(read.body, api.body) : [])
            try { for (const model of inspectCartesiaVoiceDocument(read.body)) {
              if (supported.has(model.modelId) && api?.kind === 'body') qualified(model.modelId, 'cartesia.sonic-36-docs.v1', [VOICE_SOURCE_HTTP_CONTRACTS.cartesiaModels.url, VOICE_SOURCE_HTTP_CONTRACTS.cartesiaBytes.url], [read.checkedAt, api.checkedAt].sort()[0], 'stable')
              else candidate(model.modelId, 'tts-batch', [VOICE_SOURCE_HTTP_CONTRACTS.cartesiaModels.url], model.preview ? 'preview' : 'unknown')
            } } catch { incompleteScope = true }
          } else incompleteScope = true
          if (api?.kind === 'body' && cartesia36ContractChanged(api.body)) blockPriorProfile('cartesia.bytes-20260814.v1', 'cartesiaBytes')
          if (api?.kind !== 'body') incompleteScope = true
        } else if (providerId === 'elevenlabs') {
          const docs = reads.get('elevenlabsDocs')
          const medical = docs?.kind === 'body' ? inspectElevenMedicalSource(docs.body).state : 'insufficient'
          const guide = reads.get('elevenlabsSpeechV4'), api = reads.get('elevenlabsSpeechApi')
          const v4 = docs?.kind === 'body' && guide?.kind === 'body' && api?.kind === 'body' && inspectElevenV4Source(docs.body, guide.body, api.body)
          const addTts = (id: string, evidence: string[]) => {
            if (id === 'eleven_v4' && v4 && docs?.kind === 'body' && guide?.kind === 'body' && api?.kind === 'body')
              qualified(id, 'elevenlabs.speech-v4-docs.v1', [VOICE_SOURCE_HTTP_CONTRACTS.elevenlabsDocs.url, VOICE_SOURCE_HTTP_CONTRACTS.elevenlabsSpeechV4.url, VOICE_SOURCE_HTTP_CONTRACTS.elevenlabsSpeechApi.url], [docs.checkedAt, guide.checkedAt, api.checkedAt].sort()[0])
            else candidate(id, 'tts-batch', evidence)
          }
          const metadata = reads.get('elevenlabsModels')
          let metadataComplete = false
          if (metadata?.kind === 'body') {
            try {
              const observed = inspectElevenLabsPublicModels({ body: metadata.body, retrievedAt: metadata.checkedAt }, options.now())
              if (observed.observation.structuralCoverage !== 'complete-public-response') throw new Error('source-incomplete')
              for (const model of observed.observation.models) if (model.canDoTts === true) addTts(model.modelId, [VOICE_SOURCE_HTTP_CONTRACTS.elevenlabsModels.url])
              metadataComplete = true
            } catch { incompleteScope = true }
          }
          if (!metadataComplete && docs?.kind === 'body') try {
            // Official public documentation fallback, never a key/account fallback.
            for (const row of voiceSourceTable(docs.body, ['Model ID','Description','Languages'])) {
              if (/speech synthesis/i.test(row[1])) addTts(voiceSourceCodeId(row[0]), [VOICE_SOURCE_HTTP_CONTRACTS.elevenlabsDocs.url])
              else if (/speech recognition/i.test(row[1]) && !/real.?time/i.test(row[1])) {
                const id = voiceSourceCodeId(row[0])
                if (id === 'scribe_v2_medical' && medical === 'matches' && docs?.kind === 'body') qualified(id, 'elevenlabs.scribe-medical-docs.v1', [VOICE_SOURCE_HTTP_CONTRACTS.elevenlabsDocs.url], docs.checkedAt)
                else candidate(id, 'stt-recorded', [VOICE_SOURCE_HTTP_CONTRACTS.elevenlabsDocs.url])
              }
            }
          } catch { incompleteScope = true }
          else if (!metadataComplete) incompleteScope = true
          if (medical === 'matches' && docs?.kind === 'body' && !entries.some(entry => entry.modelId === 'scribe_v2_medical' && entry.lane === 'stt-recorded'))
            qualified('scribe_v2_medical', 'elevenlabs.scribe-medical-docs.v1', [VOICE_SOURCE_HTTP_CONTRACTS.elevenlabsDocs.url], docs.checkedAt)
          if (medical === 'changed') blockPriorProfile('elevenlabs.scribe-upload.v1', 'elevenlabsDocs', 'scribe_v2_medical')
          if (v4 && !entries.some(entry => entry.modelId === 'eleven_v4' && entry.lane === 'tts-batch')) addTts('eleven_v4', [])
          if (api?.kind === 'body' && elevenV4ContractChanged(api.body)) blockPriorProfile('elevenlabs.rest-speech-v4.v1', 'elevenlabsSpeechApi')
        } else if (providerId === 'inworld') {
          const models = reads.get('inworldModels'), speech = reads.get('inworldSpeech'), steering = reads.get('inworldSteering')
          const flash = models?.kind === 'body' && speech?.kind === 'body' && steering?.kind === 'body' && inspectInworldFlashSource(models.body, speech.body, steering.body)
          if (models?.kind === 'body') try { for (const row of voiceSourceTable(models.body, ['Name','Model ID','Description','Supported languages'])) {
            const id = voiceSourceCodeId(row[1])
            if (id === 'inworld-tts-2-flash' && flash && speech?.kind === 'body' && steering?.kind === 'body')
              qualified(id, 'inworld.flash-docs.v1', [VOICE_SOURCE_HTTP_CONTRACTS.inworldModels.url, VOICE_SOURCE_HTTP_CONTRACTS.inworldSpeech.url, VOICE_SOURCE_HTTP_CONTRACTS.inworldSteering.url], [models.checkedAt, speech.checkedAt, steering.checkedAt].sort()[0])
            else candidate(id, 'tts-batch', [VOICE_SOURCE_HTTP_CONTRACTS.inworldModels.url])
            candidate(id, 'tts-direct-stream', [VOICE_SOURCE_HTTP_CONTRACTS.inworldModels.url])
          } } catch { incompleteScope = true } else incompleteScope = true
          if (speech?.kind === 'body' && inworldFlashContractChanged(speech.body)) blockPriorProfile('inworld.voice-json-flash.v1', 'inworldSpeech')
        } else if (providerId === 'mimo') {
          const doc = voiceSourceHtml(body('mimoSpeech').body, 'main'), tables = doc.tables.filter(table => table[0]?.join('|') === 'Model ID|Function|Voice|Precautions')
          if (tables.length !== 1) throw new Error('source-incomplete')
          for (const row of tables[0].slice(1)) candidate(row[0].trim(), 'tts-batch')
        } else if (providerId === 'alibaba') {
          const qwenApi = reads.get('alibabaAudioHttp')
          if (qwenApi?.kind === 'body') {
            const contradiction = inspectQwenAudioTtsSources({ models: '', api: qwenApi.body, voices: '', ossHttps: '', ossV1: '', ossV4: '' })
            if (contradiction.status === 'changed') blockPriorProfile('alibaba.audio-http.v1', 'alibabaAudioHttp')
          }
          try {
            const keys = ['alibabaAudioModels','alibabaAudioHttp','alibabaAudioVoices','alibabaOssHttps','alibabaOssV1','alibabaOssV4'] as const
            const [models, api, voices, ossHttps, ossV1, ossV4] = keys.map(key => body(key))
            const observed = inspectQwenAudioTtsSources({ models: models.body, api: api.body, voices: voices.body, ossHttps: ossHttps.body, ossV1: ossV1.body, ossV4: ossV4.body })
            if (observed.status === 'matches') for (const id of observed.modelIds) qualified(id, 'alibaba.audio-http-docs.v1', keys.map(key => VOICE_SOURCE_HTTP_CONTRACTS[key].url), [models.checkedAt, api.checkedAt, voices.checkedAt, ossHttps.checkedAt, ossV1.checkedAt, ossV4.checkedAt].sort()[0])
          } catch { incompleteScope = true }
          try {
            for (const model of inspectAlibabaVoiceInventory(body('alibabaSpeech').body)) if (!entries.some(entry => entry.modelId === model.modelId && entry.lane === model.lane)) candidate(model.modelId, model.lane, [VOICE_SOURCE_HTTP_CONTRACTS.alibabaSpeech.url])
          } catch { incompleteScope = true }
        } else if (providerId === 'async') {
          const asyncOperation = reads.get('asyncTranscribe')
          if (asyncOperation?.kind === 'body' && inspectAsyncRecordedOperation(asyncOperation.body) === 'changed') blockPriorProfile('async.recorded-upload.v1', 'asyncTranscribe')
          try {
            const read = body('asyncModels'), endpoint = reads.get('asyncTranscribe')
            for (const model of inspectAsyncVoiceInventory(read.body)) {
              if (model.modelId === 'async_asr_v1.0' && model.lane === 'stt-recorded' && endpoint?.kind === 'body' && inspectAsyncRecordedSource(read.body, endpoint.body).state === 'matches')
                qualified(model.modelId, 'async.asr-docs.v1', [VOICE_SOURCE_HTTP_CONTRACTS.asyncModels.url, VOICE_SOURCE_HTTP_CONTRACTS.asyncTranscribe.url], [read.checkedAt, endpoint.checkedAt].sort()[0])
              else if (!entries.some(entry => entry.modelId === model.modelId && entry.lane === model.lane)) candidate(model.modelId, model.lane, [VOICE_SOURCE_HTTP_CONTRACTS.asyncModels.url], model.release ?? 'unknown', model.shutdownAt)
            }
            if (endpoint?.kind !== 'body') incompleteScope = true
          } catch { incompleteScope = true }
        } else if (providerId === 'stepfun') {
          const api = reads.get('stepfunApi'), cookbook = reads.get('stepfunGlobalCookbook')
          const step3 = api?.kind === 'body' && cookbook?.kind === 'body' && inspectStep3Source(api.body, cookbook.body)
          if (step3 && api?.kind === 'body' && cookbook?.kind === 'body') qualified('stepaudio-3-tts', 'stepfun.speech-3-docs.v1', [VOICE_SOURCE_HTTP_CONTRACTS.stepfunApi.url, VOICE_SOURCE_HTTP_CONTRACTS.stepfunGlobalCookbook.url], [api.checkedAt, cookbook.checkedAt].sort()[0])
          try { for (const model of inspectStepfunVoiceInventory(body('stepfunSpeech').body)) if (!entries.some(entry => entry.modelId === model.modelId && entry.lane === model.lane)) candidate(model.modelId, model.lane, [VOICE_SOURCE_HTTP_CONTRACTS.stepfunSpeech.url]) } catch { incompleteScope = true }
          if (api?.kind === 'body' && step3ContractChanged(api.body)) blockPriorProfile('stepfun.audio-speech-3.v1', 'stepfunApi')
        } else if (providerId === 'azure') {
          const text = body('azureSpeech').body
          if (!text.includes('## Convert text to speech') || !text.includes('application/ssml+xml') || !text.includes('X-Microsoft-OutputFormat') || !text.includes('cognitiveservices/v1')) throw new Error('source-incomplete')
          entries.push(...bundledVoiceCatalogEntries('azure')); discovery = 'complete'
        }
        if (!entries.length) throw new Error('source-incomplete')
        if (entries.length > 1000 || new Set(entries.map(entry => voiceCatalogEntryIdentity(providerId, entry))).size !== entries.length) throw new Error('source-incomplete')
        const usedUrls = unique(entries.flatMap(entry => entry.evidenceUrls).length ? entries.flatMap(entry => entry.evidenceUrls) : urls)
        const successful = sourceKeys.map(key => reads.get(key)).filter((read): read is Extract<VoiceSourceBodyRead,{kind:'body'}> =>
          read?.kind === 'body' && usedUrls.includes(VOICE_SOURCE_HTTP_CONTRACTS[read.sourceKey].url))
        const pending = entries.filter(entry => entry.admission !== 'qualified').length
        providers[providerId] = { sourceStatus: 'verified', discoveryCoverage: discovery, qualificationCoverage: entries.some(entry => entry.admission === 'blocked') ? 'blocked' : pending ? 'pending' : 'complete',
          lastAttemptAt: attempt, lastVerifiedAt: successful.map(read => read.checkedAt).sort()[0], sourceUrls: usedUrls, entries }
        const before = previous?.providers[providerId].entries ?? bundledVoiceCatalogEntries(providerId)
        const changed = reportEntryFacts(providerId, entries) !== reportEntryFacts(providerId, before)
        const blocked = entries.some(entry => entry.admission === 'blocked')
        report.push({ providerId, status: blocked ? 'blocked' : changed ? 'changed' : 'current', discovery, pending,
          followUp: blocked ? 'adapter-contract' : incompleteScope ? 'source-incomplete' : pending ? 'adapter-contract' : discovery === 'partial' ? 'source-incomplete' : 'none' })
        for (const entry of entries) {
          const facts = voiceCatalogEvaluatedEntryFacts(providerId, entry)
          if (entry.admission === 'qualified' && evaluated.has(facts)) ledger.add(facts)
        }
      } catch {
        providers[providerId] = { sourceStatus: 'blocked', discoveryCoverage: 'unknown', qualificationCoverage: 'pending', lastAttemptAt: attempt, sourceUrls: [], entries: [], failure: 'incomplete' }
        report.push({ providerId, status: 'blocked', discovery: 'unknown', pending: 0, followUp: 'source-incomplete' })
      }
    }
    return providers
  }
  return { collect, admitEvaluatedEntry, getReport }
}

/** Nondefault preparation. Capture prior raw BEFORE this wrapper collects fresh fixed-source evidence. */
export async function publishFreshBuiltinVoiceCatalog(options: { store: VoiceCatalogStringStore; http: typeof fetch; now: () => number; requalify?: readonly VoiceCatalogRequalificationTarget[]; initializeAbsent?: boolean; dryRun?: boolean }) {
  const collector = createBuiltinVoiceCatalogCollector(options)
  let predecessor: BuiltinVoiceCatalogSnapshot | null = null
  const result = await runVoiceCatalogCasAttempt({ read: () => options.store.read(), collect: previous => { predecessor = previous; return collector.collect(previous) },
    compareAndSet: (before, next) => options.store.compareAndSet(before, next), admitEvaluatedEntry: collector.admitEvaluatedEntry },
    { nowMs: options.now(), initializeAbsent: options.initializeAbsent, dryRun: options.dryRun, context: BUILTIN_VOICE_CATALOG_CONTEXT })
  const reported = result.status === 'conflict' ? result.winner! : result.snapshot
  return { ...result, report: collector.getReport().map(row => {
    const provider = reported.providers[row.providerId]
    const pending = provider.entries.filter(entry => !voiceCatalogEntryCompatibility(row.providerId, entry).compatible).length
    const before = predecessor?.providers[row.providerId].entries ?? bundledVoiceCatalogEntries(row.providerId)
    const changed = reportEntryFacts(row.providerId, provider.entries) !== reportEntryFacts(row.providerId, before)
    return { ...row, status: provider.sourceStatus === 'runtime-owned' ? 'runtime-owned' as const
      : provider.sourceStatus === 'blocked' || provider.qualificationCoverage === 'blocked' ? 'blocked' as const : changed ? 'changed' as const : 'current' as const,
      discovery: provider.discoveryCoverage, pending,
      followUp: provider.sourceStatus === 'runtime-owned' ? 'none' as const : provider.sourceStatus === 'blocked' ? 'source-incomplete' as const
        : provider.qualificationCoverage === 'blocked' ? 'adapter-contract' as const
        : result.status !== 'conflict' && row.followUp === 'source-incomplete' ? 'source-incomplete' as const
        : pending ? 'adapter-contract' as const : provider.discoveryCoverage === 'partial' ? 'source-incomplete' as const : 'none' as const }
  }) }
}
