import { createHash } from 'node:crypto'
import { lexer, type Tokens } from 'marked'
import { voiceSourceSection } from './builtinVoiceCatalogDocuments'

/** Fixed provenance only. This module performs no HTTP or persistence. */
export const MISTRAL_AUDIO_SOURCE = Object.freeze({
  sourceId: 'mistral-public-audio-docs-v1', parserId: 'mistral-audio-markdown-v1',
  maxDocumentBytes: 256 * 1024, maxTotalBytes: 1024 * 1024, maxRows: 1000,
  maxIdBytes: 256, maxAliasesPerRow: 16, maxAliases: 1000,
  urls: Object.freeze({
    inventory: 'https://docs.mistral.ai/studio/audio/overview.md',
    tts: 'https://docs.mistral.ai/studio/audio/text-to-speech/generate-speech.md',
    stt: 'https://docs.mistral.ai/studio/audio/speech-to-text/transcribe-files.md',
    migration: 'https://docs.mistral.ai/studio/audio/migrate-from-voxtral-2.md'
  })
} as const)

type DocumentId = keyof typeof MISTRAL_AUDIO_SOURCE.urls
type Subject = 'mini-recorded' | 'small-recorded' | 'offline-tts' | 'realtime-stt' | 'realtime-tts' | 'unclassified'
type Task = 'stt-recorded' | 'tts-batch' | 'excluded-realtime' | 'unclassified'
type Reason = 'documented' | 'missing-input' | 'invalid-input' | 'invalid-timestamp' | 'oversized'
  | 'unsupported-structure' | 'missing-section' | 'ambiguous-section' | 'incomplete-section'
  | 'missing-table' | 'ambiguous-table' | 'malformed-table' | 'duplicate-identity'
  | 'invalid-identity' | 'fact-not-established'
type FacetId = 'ttsVoiceInput' | 'ttsFormats' | 'ttsAudioData' | 'ttsStyleUnavailable'
  | 'sttMultipartInput' | 'sttLanguageInput' | 'sttLanguageOutput' | 'sttSegmentTimestamps'
  | 'migrationLegacyVoices' | 'migrationSegmentOnly' | 'migrationOverlapWarning'
export interface MistralSourceDocument { body: string; retrievedAt: string }

/** The model card and dated release independently attest one exact recorded identity.
 * Alias names remain observations and do not enter this qualification rule. */
export function inspectMistralSmallIdentity(modelCard: string, changelog: string): boolean {
  try {
    if (![modelCard, changelog].every(body => typeof body === 'string' && body.isWellFormed() && !body.includes('\0') && bytes(body) <= 512 * 1024)) return false
    const headings = lexer(modelCard).filter(token => token.type === 'heading' && token.depth === 1 && token.text === 'Voxtral Small Transcribe 3')
    const tokens = lexer(voiceSourceSection(modelCard, 'Voxtral Small Transcribe 3'))
    const items = tokens.filter((token): token is Tokens.List => token.type === 'list').flatMap(token => token.items.map(item => item.text.trim()))
    const names = items.filter(item => item.startsWith('API names:'))
    const statuses = items.filter(item => item.startsWith('Status:'))
    const inputs = items.filter(item => item.startsWith('Input:'))
    const outputs = items.filter(item => item.startsWith('Output:'))
    const dates = items.filter(item => item.startsWith('Release date:'))
    const features = items.filter(item => item.startsWith('Features:'))
    if (headings.length !== 1 || names.length !== 1 || statuses.length !== 1 || inputs.length !== 1 || outputs.length !== 1 || dates.length !== 1 || features.length !== 1 ||
      statuses[0] !== 'Status: Public Preview' || inputs[0] !== 'Input: audio' || outputs[0] !== 'Output: text' || dates[0] !== 'Release date: 2026-10-20') return false
    const featureNames = features[0].slice('Features:'.length).split(',').map(value => value.trim())
    if (new Set(featureNames).size !== featureNames.length || !featureNames.includes('timestamps') || !featureNames.includes('transcriptions')) return false
    const ids = [...names[0].matchAll(/`([^`]+)`/g)].map(match => match[1])
    if (!ids.length || ids[0] !== 'voxtral-small-transcribe-3-0' || new Set(ids).size !== ids.length ||
      names[0].replace(/^API names:\s*/, '').replace(/`[^`]+`/g, '').replace(/[\s,]/g, '')) return false
    const section = voiceSourceSection(changelog, '2026-10-20'), root = lexer(section).filter((token): token is Tokens.List => token.type === 'list')
    const releases = root.flatMap(token => token.items).filter(item => item.text.startsWith('We released the **Voxtral 3** audio family') && item.text.includes('All four models are in Public Preview.'))
    if (releases.length !== 1) return false
    const nested = releases[0].tokens.filter((token): token is Tokens.List => token.type === 'list').flatMap(token => token.items)
    const small = nested.filter(item => item.text.startsWith('**Voxtral Small Transcribe 3**'))
    return small.length === 1 && small[0].text === '**Voxtral Small Transcribe 3** (`voxtral-small-transcribe-3-0`): offline transcription and diarization with timestamps. See the [model card](/models/voxtral-small-transcribe-3-0).'
  } catch { return false }
}
interface Evidence { documentId: DocumentId; sectionId: string; sourceDigest: string; sectionDigest: string; retrievedAt: string }
interface Facet { state: 'matches' | 'insufficient'; reason: Reason; evidence?: Evidence }
interface Model { modelId: string; subject: Subject; task: Task }
interface Mapping {
  subject: Subject; canonicalId: string; aliasIds: string[]
  aliasStatus: 'observed-only' | 'conditional-or-ambiguous' | 'canonical-overlap'
  activeStatus: 'unknown'
}
interface ParsedDocument { body: string; retrievedAt: string; digest: string; lines: string[]; headings: Heading[] }
interface Heading { id: string; level: number; index: number }
interface Section { text: string; evidence: Evidence }
class SourceFailure extends Error { constructor(readonly reason: Reason) { super(reason) } }
const fail = (reason: Reason): never => { throw new SourceFailure(reason) }
const hash = (body: string) => createHash('sha256').update(body).digest('hex')
const bytes = (body: string) => Buffer.byteLength(body, 'utf8')
const ids = Object.keys(MISTRAL_AUDIO_SOURCE.urls) as DocumentId[]
const subjects: Readonly<Record<string, Subject>> = Object.freeze({
  'Voxtral Mini Transcribe 3': 'mini-recorded', 'Voxtral Small Transcribe 3': 'small-recorded',
  'Voxtral TTS 3': 'offline-tts', 'Voxtral Mini Transcribe Realtime 3': 'realtime-stt',
  'Voxtral TTS Realtime 3': 'realtime-tts'
})
const tasks: Readonly<Record<string, Task>> = Object.freeze({
  'Transcribe recorded files, with speaker labels, segment timestamps, and custom vocabulary': 'stt-recorded',
  'Transcribe recorded files at higher quality': 'stt-recorded',
  'Generate speech from text with preset or cloned voices': 'tts-batch',
  'Transcribe live audio for captions and voice agents, with turn detection': 'excluded-realtime',
  'Stream speech for live conversations': 'excluded-realtime'
})
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('invalid-input')
  return value as Record<string, unknown>
}
function identity(value: string): string {
  if (!value || value.trim() !== value || bytes(value) > MISTRAL_AUDIO_SOURCE.maxIdBytes
    || !value.isWellFormed() || /[\s`<>\u0000-\u001f\u007f]/u.test(value)) return fail('invalid-identity')
  return value
}
function codeIds(value: string): string[] {
  const matches = [...value.matchAll(/`([^`]+)`/g)].map(match => identity(match[1]))
  if (value.replace(/`[^`]+`/g, '').includes('`')) return fail('invalid-identity')
  return matches
}

/** Mask code/escapes for structure only; original text remains the field/identity input. */
function structuralText(line: string): string {
  let masked = ''
  for (let index = 0; index < line.length;) {
    if (line[index] === '\\') { masked += '  '; index += 2; continue }
    if (line[index] === '`') {
      let end = index
      while (line[end] === '`') end++
      const width = end - index
      for (;;) {
        const next = line.indexOf('`', end)
        if (next < 0) return fail('unsupported-structure')
        end = next
        while (line[end] === '`') end++
        if (end - next === width) break
      }
      masked += ' '.repeat(end - index)
      index = end
      continue
    }
    if (line[index] === '{') return fail('unsupported-structure')
    masked += line[index]
    index++
  }
  return masked
}

/** A deliberately finite root-scope scanner, not an MDX evaluator or general Markdown parser. */
function document(body: string, retrievedAt: string): ParsedDocument {
  if (body.charCodeAt(0) === 0xfeff) return fail('unsupported-structure')
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const headings: Heading[] = [], containers: string[] = []
  let fence = '', fenceSize = 0, comment = '', quote = false, frontmatter = lines[0] === '---'
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]
    lines[index] = ''
    if (frontmatter) { if (index > 0 && line === '---') frontmatter = false; continue }
    if (fence) {
      if (new RegExp(`^ {0,3}${fence}{${fenceSize},}\\s*$`).test(line)) fence = ''
      continue
    }
    const opening = line.match(/^ {0,3}(`{3,})([^`]*)$/) ?? line.match(/^ {0,3}(~{3,})(.*)$/)
    if (!comment && opening) { fence = opening[1][0]; fenceSize = opening[1].length; continue }
    if (!comment && /^ {0,3}(?:`{3,}|~{3,})/.test(line)) return fail('unsupported-structure')
    let clean = ''
    while (line.length) {
      if (comment) {
        const end = line.indexOf(comment)
        if (end < 0) { line = ''; break }
        line = line.slice(end + comment.length); comment = ''; continue
      }
      const html = line.indexOf('<!--'), mdx = line.indexOf('{/*')
      const start = html < 0 ? mdx : mdx < 0 ? html : Math.min(html, mdx)
      if (start < 0) { clean += line; break }
      clean += line.slice(0, start)
      comment = start === html ? '-->' : '*/}'
      line = line.slice(start + (start === html ? 4 : 3))
    }
    line = clean
    if (/^\s*>/.test(line)) { quote = true; continue }
    if (quote) { if (!line.trim()) quote = false; else continue }
    if (/^(?: {4}|\t)/.test(line)) continue
    const structural = structuralText(line)
    if (!containers.length && (line === '---' || /^\s*(?:import|export)\b/.test(structural))) return fail('unsupported-structure')
    const heading = structural.match(/^<SectionTab as="h([1-6])"(?: variant="secondary")? sectionId="([a-z0-9-]+)">[^<>]+<\/SectionTab>$/)
    if (heading) {
      if (!containers.length) headings.push({ id: heading[2], level: Number(heading[1]), index })
      continue
    }
    if (structural.startsWith('<SectionTab')) return fail('unsupported-structure')
    const tags = [...structural.matchAll(/<(\/?)([A-Za-z][A-Za-z0-9]*)(?:\s+(?:[^<>"']|"[^"]*"|'[^']*')*)?\s*(\/?)>/g)]
    const embedded = containers.length > 0 || tags.length > 0
    if (structural.trimStart().startsWith('<') && !tags.length) return fail('unsupported-structure')
    for (const tag of tags) {
      if (tag[1]) { if (containers.pop() !== tag[2]) return fail('unsupported-structure') }
      else if (!tag[0].endsWith('/>')) containers.push(tag[2])
    }
    if (embedded) continue
    const markdownHeading = structural.match(/^(#{1,6}) /)
    if (markdownHeading) { headings.push({ id: '', level: markdownHeading[1].length, index }); continue }
    lines[index] = line
  }
  if (frontmatter || fence || comment || containers.length) return fail('unsupported-structure')
  return { body, retrievedAt, digest: hash(body), lines, headings }
}
function section(doc: ParsedDocument, documentId: DocumentId, sectionId: string): Section {
  const matches = doc.headings.filter(heading => heading.id === sectionId)
  if (!matches.length) return fail('missing-section')
  if (matches.length !== 1) return fail('ambiguous-section')
  const heading = matches[0], end = doc.headings.find(next => next.index > heading.index && next.level <= heading.level)
  if (!end) return fail('incomplete-section')
  const text = doc.lines.slice(heading.index + 1, end.index).join('\n')
  return { text, evidence: { documentId, sectionId, sourceDigest: doc.digest, sectionDigest: hash(text), retrievedAt: doc.retrievedAt } }
}
function table(scope: Section, headers: string[]): string[][] {
  const lines = scope.text.split('\n'), candidates: string[][][] = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('|')) continue
    const block: string[][] = []
    while (i < lines.length && lines[i].startsWith('|')) {
      const line = lines[i++]
      if (!line.endsWith('|') || line.includes('\\|')) return fail('malformed-table')
      block.push(line.slice(1, -1).split('|').map(cell => cell.trim()))
    }
    i--
    if (block[0]?.join('\0') !== headers.join('\0')) continue
    if (block.length < 3 || block.length > MISTRAL_AUDIO_SOURCE.maxRows + 2
      || block.some(row => row.length !== headers.length) || !block[1].every(cell => /^:?-{3,}:?$/.test(cell))) return fail('malformed-table')
    candidates.push(block.slice(2))
  }
  if (!candidates.length) return fail('missing-table')
  if (candidates.length !== 1) return fail('ambiguous-table')
  return candidates[0]
}
function fields(scope: Section, columns: string[]): Map<string, string[]> {
  const rows = table(scope, columns), values = new Map<string, string[]>()
  for (const cells of rows) {
    const key = cells[0]
    if (values.has(key)) return fail('duplicate-identity')
    values.set(key, cells.slice(1))
  }
  return values
}
const established = (condition: boolean): void => { if (!condition) fail('fact-not-established') }

export function inspectMistralAudioDocuments(input: unknown, now = Date.now()) {
  const docs: Partial<Record<DocumentId, ParsedDocument>> = {}
  const sources = {} as Record<DocumentId, { status: 'accepted' | 'insufficient'; reason: Reason; sourceUrl: string; retrievedAt: string | null; digest: string | null }>
  let supplied: Record<string, unknown> = {}, total = 0, inputFailure: Reason | undefined
  try { supplied = record(input); if (Object.keys(supplied).some(key => !ids.includes(key as DocumentId))) fail('invalid-input') }
  catch { inputFailure = 'invalid-input' }
  for (const id of ids) {
    sources[id] = { status: 'insufficient', reason: 'missing-input', sourceUrl: MISTRAL_AUDIO_SOURCE.urls[id], retrievedAt: null, digest: null }
    try {
      if (inputFailure) fail(inputFailure)
      if (!Object.hasOwn(supplied, id)) continue
      const value = record(supplied[id])
      const body = value.body, retrievedAt = value.retrievedAt
      if (Object.keys(value).some(key => !['body', 'retrievedAt'].includes(key)) || typeof body !== 'string'
        || !body.isWellFormed() || body.includes('\0')) throw new SourceFailure('invalid-input')
      if (typeof retrievedAt !== 'string' || !Number.isFinite(now) || !Number.isFinite(Date.parse(retrievedAt))
        || new Date(retrievedAt).toISOString() !== retrievedAt || Date.parse(retrievedAt) > now + 300_000) throw new SourceFailure('invalid-timestamp')
      const size = bytes(body)
      total += size
      if (size > MISTRAL_AUDIO_SOURCE.maxDocumentBytes || total > MISTRAL_AUDIO_SOURCE.maxTotalBytes) fail('oversized')
      const parsed = document(body, retrievedAt)
      docs[id] = parsed
      sources[id] = { status: 'accepted', reason: 'documented', sourceUrl: MISTRAL_AUDIO_SOURCE.urls[id], retrievedAt: parsed.retrievedAt, digest: parsed.digest }
    } catch (error) { sources[id].reason = error instanceof SourceFailure ? error.reason : 'invalid-input' }
  }
  const facets = {} as Record<FacetId, Facet>
  function scoped(id: DocumentId, name: string): Section { const doc = docs[id]; if (!doc) return fail(sources[id].reason); return section(doc, id, name) }
  function facet(key: FacetId, id: DocumentId, name: string, inspect: (scope: Section) => void): void {
    try { const scope = scoped(id, name); inspect(scope); facets[key] = { state: 'matches', reason: 'documented', evidence: scope.evidence } }
    catch (error) { facets[key] = { state: 'insufficient', reason: error instanceof SourceFailure ? error.reason : 'invalid-input' } }
  }
  let models: Model[] = [], mappings: Mapping[] = []
  let inventory: { structuralCoverage: 'complete-designated-table' | 'insufficient'; classificationCoverage: 'complete' | 'partial' | 'unknown'; reason: Reason; evidence?: Evidence } = {
    structuralCoverage: 'insufficient', classificationCoverage: 'unknown', reason: 'missing-input'
  }
  try {
    const scope = scoped('inventory', 'meet-the-models'), seen = new Set<string>()
    const parsed = table(scope, ['Model', 'Use it to', 'Key numbers']).map(cells => {
      const match = cells[0].match(/^([^`<>]+) \(`([^`]+)`\)$/)
      if (!match) return fail('invalid-identity')
      const modelId = identity(match[2]); if (seen.has(modelId)) return fail('duplicate-identity'); seen.add(modelId)
      return { modelId, subject: Object.hasOwn(subjects, match[1]) ? subjects[match[1]] : 'unclassified',
        task: Object.hasOwn(tasks, cells[1]) ? tasks[cells[1]] : 'unclassified' } satisfies Model
    })
    models = parsed
    inventory = { structuralCoverage: 'complete-designated-table', classificationCoverage: parsed.some(model => model.task === 'unclassified') ? 'partial' : 'complete', reason: 'documented', evidence: scope.evidence }
  } catch (error) { inventory.reason = error instanceof SourceFailure ? error.reason : 'invalid-input' }
  let mappingStatus: Reason = 'missing-input', mappingEvidence: Evidence | undefined
  try {
    const scope = scoped('migration', 'model-mapping'), seen = new Set<string>(); let aliasCount = 0
    mappings = table(scope, ['Voxtral 2 model', 'Voxtral 3 model', 'Model ID', 'Aliases']).map(cells => {
      const canonical = cells[2].match(/^`([^`]+)`$/); if (!canonical) return fail('invalid-identity')
      const canonicalId = identity(canonical[1]); if (seen.has(canonicalId)) return fail('duplicate-identity'); seen.add(canonicalId)
      const aliases = codeIds(cells[3]); aliasCount += aliases.length
      if (aliases.length > MISTRAL_AUDIO_SOURCE.maxAliasesPerRow || aliasCount > MISTRAL_AUDIO_SOURCE.maxAliases) return fail('oversized')
      const aliasIds = [...new Set(aliases)], overlap = aliasIds.includes(canonicalId)
      const conditional = cells[3].replace(/`[^`]+`/g, '').replace(/[\s,]/g, '').length > 0 || aliasIds.length !== aliases.length
      return { subject: Object.hasOwn(subjects, cells[1]) ? subjects[cells[1]] : 'unclassified', canonicalId, aliasIds,
        aliasStatus: overlap ? 'canonical-overlap' : conditional ? 'conditional-or-ambiguous' : 'observed-only', activeStatus: 'unknown' } satisfies Mapping
    })
    mappingStatus = 'documented'
    mappingEvidence = scope.evidence
  } catch (error) { mappings = []; mappingStatus = error instanceof SourceFailure ? error.reason : 'invalid-input' }
  facet('ttsVoiceInput', 'tts', 'request-fields', scope => established(/^The voice to use: a preset slug such as `[^`]+`, or the ID of a voice saved in your workspace\. See \[Voices\]\(\/studio\/audio\/text-to-speech\/voices\)\.$/.test(fields(scope, ['Field', 'What it does']).get('`voice_id`')?.[0] ?? '')))
  facet('ttsFormats', 'tts', 'response-formats', scope => established(scope.text.split('\n').includes('Set `response_format` to `mp3` (the default), `wav`, `pcm`, `flac`, or `opus`. To choose between them, see [Audio formats](/studio/audio/specs-and-limits/audio-formats).')))
  facet('ttsAudioData', 'tts', 'make-a-request', scope => established(scope.text.split('\n').includes('Send the text and a voice in one `POST` request. The response carries the audio, base64-encoded, in `audio_data`: decode it and save it to a file.')))
  facet('ttsStyleUnavailable', 'tts', 'request-fields', scope => established(fields(scope, ['Field', 'What it does']).get('`instruction`')?.[0] === 'Style instructions are not available at launch. See [Style instructions](/studio/audio/text-to-speech/style-instructions).'))
  facet('sttMultipartInput', 'stt', 'request-fields', scope => {
    established(scope.text.split('\n').includes('These fields change what you get back. Send them as multipart form fields. For every field, see the [API reference](/api/endpoint/audio/transcriptions#operation-audio_api_v1_transcriptions_post).'))
    established(fields(scope, ['Field', 'What it does', 'Details']).get('`file`, `file_url`, or `file_id`')?.[0] === 'The audio to transcribe. Send exactly one.')
  })
  facet('sttLanguageInput', 'stt', 'pin-the-language', scope => established(scope.text.split('\n').includes('By default, the model detects the language of the recording. When you know it in advance, pass it in `language` as a two-letter ISO 639-1 code:')))
  facet('sttLanguageOutput', 'stt', 'make-a-request', scope => established(scope.text.split('\n').includes('- `language` is `null`, even when you pin the language. To get the detected language in the response when you don\'t pin it, set `return_language` to `true`.')))
  facet('sttSegmentTimestamps', 'stt', 'timestamps', scope => {
    established(scope.text.split('\n').includes('- `start` and `end`: the time of the segment in the recording, in seconds.'))
    established(scope.text.split('\n').includes('Timestamps are available per segment only. A request for word-level timestamps returns an error.'))
  })
  facet('migrationLegacyVoices', 'migration', 'text-to-speech-changes', scope => established(table(scope, ['Change', 'Breaks existing code?', 'What to do']).some(cells => cells[0].startsWith('Emotion moves from the voice to inline tags.') && cells[1] === 'No. The Voxtral 2 presets are still accepted.')))
  facet('migrationSegmentOnly', 'migration', 'speech-to-text-changes', scope => established(table(scope, ['Change', 'Breaks existing code?', 'What to do']).some(cells => cells[0] === 'Word timestamps are gone. `timestamp_granularities` accepts `segment` only, and `word` returns a `400` error.')))
  facet('migrationOverlapWarning', 'migration', 'speech-to-text-changes', scope => established(table(scope, ['Change', 'Breaks existing code?', 'What to do']).some(cells => cells[1] === 'Yes, if your display assumes that segments never overlap.' && cells[2] === 'Keep both segments when they overlap. See [Overlapping segments](/studio/audio/speech-to-text/diarize-speakers#overlapping-segments).')))
  const knownSubjects = ['mini-recorded', 'small-recorded', 'offline-tts', 'realtime-stt', 'realtime-tts'] as const
  const subjectComparisons = knownSubjects.map(subject => {
    const found = models.filter(model => model.subject === subject), mapped = mappings.filter(mapping => mapping.subject === subject)
    if (found.length > 1 || mapped.length > 1) return { subject, state: 'insufficient', reason: 'ambiguous-subject' } as const
    if (!found.length || !mapped.length) return { subject, state: 'insufficient', reason: 'not-observed' } as const
    if (found[0].modelId !== mapped[0].canonicalId) return { subject, state: 'insufficient', reason: 'canonical-disagreement' } as const
    if (mapped[0].aliasStatus === 'canonical-overlap') return { subject, state: 'insufficient', reason: 'canonical-alias-overlap' } as const
    return { subject, state: 'documented', reason: 'consistent-docs' } as const
  })
  const disagreements = subjectComparisons.filter(comparison => comparison.reason === 'canonical-disagreement').map(comparison => ({
    subject: comparison.subject, inventoryId: models.find(model => model.subject === comparison.subject)!.modelId,
    migrationId: mappings.find(mapping => mapping.subject === comparison.subject)!.canonicalId, reason: 'canonical-disagreement' as const
  }))
  return {
    sourceId: MISTRAL_AUDIO_SOURCE.sourceId, parserId: MISTRAL_AUDIO_SOURCE.parserId, providerId: 'mistral' as const,
    scopedLanes: ['tts-batch', 'stt-recorded'] as const, sources, inventory, models, mappings, mappingStatus, mappingEvidence,
    subjectComparisons, disagreements, facets,
    providerDiscoveryCoverage: 'partial' as const, qualificationCoverage: 'pending' as const, readiness: 'candidate' as const,
    proofGaps: ['full-effective-api-schema-and-required-inputs', 'multipart-bracket-field-acceptance', 'actual-json-audio-segment-output',
      'actual-errors-and-cancellation', 'model-specific-voice-controls-and-guidance', 'overlapping-segment-consumers', 'language-projection'] as const,
    outsideCatalogQualification: ['account-private-voice-eligibility'] as const
  }
}
