// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { inspectMistralAudioDocuments, inspectMistralSmallIdentity, MISTRAL_AUDIO_SOURCE } from '../services/builtinVoiceCatalogMistralSource'
import { voiceCatalogEntryCompatibility } from '../../utils/builtinVoiceCatalog'

const at = '2026-10-28T02:01:42.000Z'
const now = Date.parse('2026-10-28T02:10:00.000Z')
const heading = (id: string, level = 2) => `<SectionTab as="h${level}" sectionId="${id}">${id}</SectionTab>`
const table = (headers: string[], rows: string[][]) => [headers, headers.map(() => '---'), ...rows].map(cells => `| ${cells.join(' | ')} |`).join('\n')
const inventoryRows = [
  ['Voxtral Mini Transcribe 3 (`voxtral-mini-transcribe-3-0`)', 'Transcribe recorded files, with speaker labels, segment timestamps, and custom vocabulary', ''],
  ['Voxtral Small Transcribe 3 (`voxtral-small-transcribe-3-0`)', 'Transcribe recorded files at higher quality', ''],
  ['Voxtral TTS 3 (`voxtral-mini-tts-3-0`)', 'Generate speech from text with preset or cloned voices', ''],
  ['Voxtral TTS Realtime 3 (`voxtral-mini-tts-realtime-3-0`)', 'Stream speech for live conversations', '']
]
const mappingRows = [
  ['`old-mini`', 'Voxtral Mini Transcribe 3', '`voxtral-mini-transcribe-3-0`', '`voxtral-mini-transcribe-3`'],
  ['`old-small`', 'Voxtral Small Transcribe 3', '`voxtral-small-transcribe-latest`', '`voxtral-small-transcribe-3`, `voxtral-small-transcribe-latest`'],
  ['`old-tts`', 'Voxtral TTS 3', '`voxtral-mini-tts-3-0`', '`voxtral-mini-tts-3`, `voxtral-mini-tts-latest` will point to Voxtral 3 within a month of GA.']
]
const modelTable = (rows = inventoryRows) => table(['Model', 'Use it to', 'Key numbers'], rows)
const mappingTable = (rows = mappingRows) => table(['Voxtral 2 model', 'Voxtral 3 model', 'Model ID', 'Aliases'], rows)

/** Compact synthetic scope/semantic fixture, never the downloaded vendor documents. */
function fixture() {
  const inventory = [heading('meet-the-models'), heading('models-speech-to-text', 3), '<ModelCards group="stt" />', heading('models-text-to-speech', 3), modelTable(), heading('concepts')].join('\n\n')
  const tts = [heading('make-a-request'),
    'Send the text and a voice in one `POST` request. The response carries the audio, base64-encoded, in `audio_data`: decode it and save it to a file.',
    heading('request-fields', 3), table(['Field', 'What it does'], [
      ['`voice_id`', 'The voice to use: a preset slug such as `example_voice`, or the ID of a voice saved in your workspace. See [Voices](/studio/audio/text-to-speech/voices).'],
      ['`instruction`', 'Style instructions are not available at launch. See [Style instructions](/studio/audio/text-to-speech/style-instructions).']
    ]), heading('response-formats'),
    'Set `response_format` to `mp3` (the default), `wav`, `pcm`, `flac`, or `opus`. To choose between them, see [Audio formats](/studio/audio/specs-and-limits/audio-formats).',
    heading('end')].join('\n\n')
  const stt = [heading('make-a-request'),
    '- `language` is `null`, even when you pin the language. To get the detected language in the response when you don\'t pin it, set `return_language` to `true`.',
    heading('request-fields', 3),
    'These fields change what you get back. Send them as multipart form fields. For every field, see the [API reference](/api/endpoint/audio/transcriptions#operation-audio_api_v1_transcriptions_post).',
    table(['Field', 'What it does', 'Details'], [['`file`, `file_url`, or `file_id`', 'The audio to transcribe. Send exactly one.', '']]),
    heading('pin-the-language', 3), 'By default, the model detects the language of the recording. When you know it in advance, pass it in `language` as a two-letter ISO 639-1 code:',
    heading('timestamps'), '- `start` and `end`: the time of the segment in the recording, in seconds.',
    'Timestamps are available per segment only. A request for word-level timestamps returns an error.', heading('end')].join('\n\n')
  const migration = [heading('model-mapping'), mappingTable(), heading('speech-to-text-changes'),
    table(['Change', 'Breaks existing code?', 'What to do'], [
      ['Word timestamps are gone. `timestamp_granularities` accepts `segment` only, and `word` returns a `400` error.', 'Yes', ''],
      ['', 'Yes, if your display assumes that segments never overlap.', 'Keep both segments when they overlap. See [Overlapping segments](/studio/audio/speech-to-text/diarize-speakers#overlapping-segments).']
    ]), heading('text-to-speech-changes'),
    table(['Change', 'Breaks existing code?', 'What to do'], [['Emotion moves from the voice to inline tags.', 'No. The Voxtral 2 presets are still accepted.', '']]), heading('end')].join('\n\n')
  return Object.fromEntries(Object.entries({ inventory, tts, stt, migration }).map(([key, body]) => [key, { body, retrievedAt: at }])) as Record<'inventory' | 'tts' | 'stt' | 'migration', { body: string; retrievedAt: string }>
}
const inspect = (input: unknown = fixture()) => inspectMistralAudioDocuments(input, now)

describe('Mistral finite documentation discovery', () => {
  it('requires the exact Small card and dated release, without qualifying observed aliases', () => {
    const card = '# Voxtral Small Transcribe 3\n\n- API names: `voxtral-small-transcribe-3-0`, `voxtral-small-transcribe-3`, `voxtral-small-transcribe-latest`\n- Status: Public Preview\n- Release date: 2026-10-20\n- Input: audio\n- Output: text\n- Features: timestamps, transcriptions\n'
    const changelog = '## 2026-10-20\n\n- We released the **Voxtral 3** audio family. All four models are in Public Preview.\n  - **Voxtral Small Transcribe 3** (`voxtral-small-transcribe-3-0`): offline transcription and diarization with timestamps. See the [model card](/models/voxtral-small-transcribe-3-0).\n\n## 2026-10-06\n'
    expect(inspectMistralSmallIdentity(card, changelog)).toBe(true)
    expect(inspectMistralSmallIdentity('', changelog)).toBe(false)
    expect(inspectMistralSmallIdentity(card.replace('`voxtral-small-transcribe-3-0`,', '`voxtral-small-transcribe-3`,'), changelog)).toBe(false)
    expect(inspectMistralSmallIdentity(card, changelog.replace('2026-10-20', '2026-10-21'))).toBe(false)
    expect(inspectMistralSmallIdentity(card, changelog.repeat(2))).toBe(false)
    expect(inspectMistralSmallIdentity(card.replace('timestamps, transcriptions', 'transcriptions'), changelog)).toBe(false)
    expect(inspectMistralSmallIdentity(card.replace('timestamps, transcriptions', 'timestamps'), changelog)).toBe(false)
    expect(inspectMistralSmallIdentity(card.replace('- API names:', '# Unrelated model\n\n- API names:'), changelog)).toBe(false)
  })
  it('separates inventory structure, task coverage, qualification and exact alias disagreement', () => {
    const result = inspect()
    expect(result.inventory).toMatchObject({ structuralCoverage: 'complete-designated-table', classificationCoverage: 'complete' })
    expect(result.models.map(model => [model.modelId, model.task])).toEqual([
      ['voxtral-mini-transcribe-3-0', 'stt-recorded'], ['voxtral-small-transcribe-3-0', 'stt-recorded'],
      ['voxtral-mini-tts-3-0', 'tts-batch'], ['voxtral-mini-tts-realtime-3-0', 'excluded-realtime']
    ])
    expect(result.disagreements).toEqual([{ subject: 'small-recorded', inventoryId: 'voxtral-small-transcribe-3-0', migrationId: 'voxtral-small-transcribe-latest', reason: 'canonical-disagreement' }])
    expect(result.mappings[1]).toMatchObject({ aliasStatus: 'canonical-overlap', activeStatus: 'unknown', aliasIds: ['voxtral-small-transcribe-3', 'voxtral-small-transcribe-latest'] })
    expect(result.mappings[2]).toMatchObject({ aliasStatus: 'conditional-or-ambiguous', activeStatus: 'unknown' })
    expect(result.mappingEvidence).toMatchObject({ documentId: 'migration', sectionId: 'model-mapping', retrievedAt: at })
    expect(result.mappingEvidence?.sectionDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(result.mappingEvidence?.sourceDigest).toBe(result.sources.migration.digest)
    expect(Object.values(result.facets).every(facet => facet.state === 'matches')).toBe(true)
    expect(result).toMatchObject({ readiness: 'candidate', providerDiscoveryCoverage: 'partial', qualificationCoverage: 'pending' })
  })

  it('preserves exact new IDs while unknown task words make only classification partial', () => {
    const value = fixture()
    value.inventory.body = value.inventory.body.replace(modelTable(), modelTable([...inventoryRows,
      ['Future Public Model (`New.Case-2027`)', 'A new task not recognized here', '']]))
    const result = inspect(value)
    expect(result.inventory).toMatchObject({ structuralCoverage: 'complete-designated-table', classificationCoverage: 'partial' })
    expect(result.models.at(-1)).toEqual({ modelId: 'New.Case-2027', subject: 'unclassified', task: 'unclassified' })
  })

  it('classifies from the task cell rather than a model-name family', () => {
    const value = fixture()
    value.inventory.body = value.inventory.body.replace('Generate speech from text with preset or cloned voices', 'Transcribe recorded files at higher quality')
    expect(inspect(value).models.find(model => model.modelId === 'voxtral-mini-tts-3-0')?.task).toBe('stt-recorded')
    value.inventory.body = value.inventory.body.replace('Transcribe recorded files at higher quality', 'toString')
    expect(inspect(value).models.find(model => model.subject === 'small-recorded')?.task).toBe('unclassified')
  })

  it('does not emit descriptions, voice examples, links, instructions or free labels', () => {
    const value = fixture(), poison = 'PRIVATE_VOICE_IGNORE_RULES'
    value.inventory.body += `\n${poison}\nhttps://private.invalid/endpoint`
    value.inventory.body = value.inventory.body.replace('Voxtral TTS 3 (', `${poison} (`)
    value.tts.body = value.tts.body.replace('example_voice', poison)
    const result = inspect(value), serialized = JSON.stringify(result)
    expect(serialized).not.toContain(poison)
    expect(serialized).not.toContain('private.invalid')
    expect(serialized).not.toContain('text-to-speech/voices')
    expect(result.models.find(model => model.modelId === 'voxtral-mini-tts-3-0')?.subject).toBe('unclassified')
  })

  it('keeps source timestamps instead of refreshing them when the cached source is re-parsed', () => {
    const value = fixture(); value.tts.retrievedAt = '2026-10-27T01:00:00.000Z'
    const result = inspectMistralAudioDocuments(value, now + 86400000)
    expect(result.sources.tts.retrievedAt).toBe(value.tts.retrievedAt)
    expect(result.facets.ttsFormats.evidence?.retrievedAt).toBe(value.tts.retrievedAt)
    expect(result).not.toHaveProperty('lastVerifiedAt')
    expect(result).not.toHaveProperty('generatedAt')
  })

  it('keeps independent inventory and other facts when a companion input is missing', () => {
    const value: Record<string, unknown> = fixture(); delete value.tts
    const result = inspect(value)
    expect(result.models).toHaveLength(4)
    expect(result.sources.tts).toMatchObject({ status: 'insufficient', reason: 'missing-input', retrievedAt: null })
    expect(result.facets.ttsAudioData).toEqual({ state: 'insufficient', reason: 'missing-input' })
    expect(result.facets.sttLanguageInput.state).toBe('matches')
  })

  it('does not let caller qualification or an extra input supply authority', () => {
    const result = inspect({ ...fixture(), qualified: true })
    expect(result.models).toEqual([])
    expect(result.sources.inventory.reason).toBe('invalid-input')
    const candidate = inspect()
    expect(voiceCatalogEntryCompatibility('mistral', { modelId: candidate.models[2].modelId, label: 'TTS', lane: 'tts-batch',
      compatibilityProfileId: 'mistral.audio-speech-json.v1', admission: 'qualified', qualifiedAt: at,
      evidenceUrls: ['https://docs.mistral.ai/studio/audio/overview'], provenance: 'qualified-source', release: 'unknown' }).compatible).toBe(false)
  })

  it.each(['inventory', 'tts', 'stt', 'migration'] as const)('rejects unclosed structure in %s without a partial fact certificate', key => {
    const value = fixture(); value[key].body += '\n<!-- unclosed'
    expect(inspect(value).sources[key]).toMatchObject({ status: 'insufficient', reason: 'unsupported-structure' })
  })

  it.each([
    ['fence', (text: string) => `\`\`\`md\n${text}\n\`\`\``],
    ['tilde fence', (text: string) => `~~~~md\n${text}\n~~~~`],
    ['tilde fence with backtick info', (text: string) => `~~~ \`example\`\n${text}\n~~~`],
    ['HTML comment', (text: string) => `<!--\n${text}\n-->`],
    ['MDX comment', (text: string) => `{/*\n${text}\n*/}`],
    ['blockquote', (text: string) => text.split('\n').map(line => `> ${line}`).join('\n')],
    ['indented code', (text: string) => text.split('\n').map(line => `    ${line}`).join('\n')],
    ['embedded MDX', (text: string) => `<Example>\n${text}\n</Example>`]
  ])('excludes counterfeit inventory in %s', (_name, wrap) => {
    const value = fixture(); value.inventory.body = `${wrap(value.inventory.body)}\n\n${heading('end')}`
    const result = inspect(value)
    expect(result.models).toEqual([])
    expect(result.inventory.structuralCoverage).toBe('insufficient')
  })

  it('ignores examples/comments/embedded sections beside the real root table', () => {
    const value = fixture(), counterfeit = value.inventory.body.replaceAll('voxtral-', 'FAKE-')
    value.inventory.body = `---\nmodel: not-a-model\n---\n<!--\n${counterfeit}\n-->\n<Example>\n${counterfeit}\n</Example>\n${value.inventory.body}`
    expect(inspect(value).models.map(model => model.modelId)).toEqual(inspect().models.map(model => model.modelId))
  })

  it.each([
    (body: string) => `{condition && (\n${body}\n)}`,
    (body: string) => `Notes { /*\n${body}\n*/ null}`,
    (body: string) => `export const example = \`\n${body}\n\``,
    (body: string) => `\ufeff---\n${body}\n---`,
    (body: string) => `\n---\n${body}\n---`
  ])('refuses unsupported expression/frontmatter embedding around counterfeit root sections', wrap => {
    const value = fixture(); value.inventory.body = wrap(value.inventory.body)
    expect(inspect(value).models).toEqual([])
    expect(inspect(value).sources.inventory.reason).toBe('unsupported-structure')
  })

  it('allows braces only as escaped text or inside a closed inline code span', () => {
    const value = fixture(); value.inventory.body = `Notes \`{inline}\` and \\{escaped\\}.\n\n${value.inventory.body}`
    expect(inspect(value).models).toHaveLength(4)
  })

  it.each(['`</Example>`', '\\</Example>', '{condition && "</Example>"}'])('does not close a real container with a counterfeit token: %s', counterfeit => {
    const value = fixture(); value.inventory.body = `<Example>\n${counterfeit}\n${value.inventory.body}`
    expect(inspect(value).sources.inventory.reason).toBe('unsupported-structure')
    expect(inspect(value).models).toEqual([])
  })

  it('reports subject ambiguity once without a Cartesian disagreement expansion', () => {
    const value = fixture()
    value.inventory.body = value.inventory.body.replace(modelTable(), modelTable(Array.from({ length: 4 }, (_, i) => [
      `Voxtral Mini Transcribe 3 (\`inventory-${i}\`)`, 'Transcribe recorded files at higher quality', ''
    ])))
    value.migration.body = value.migration.body.replace(mappingTable(), mappingTable(Array.from({ length: 4 }, (_, i) => [
      '`old`', 'Voxtral Mini Transcribe 3', `\`mapping-${i}\``, ''
    ])))
    const result = inspect(value)
    expect(result.models).toHaveLength(4)
    expect(result.mappings).toHaveLength(4)
    expect(result.disagreements).toEqual([])
    expect(result.subjectComparisons.find(item => item.subject === 'mini-recorded')).toEqual({ subject: 'mini-recorded', state: 'insufficient', reason: 'ambiguous-subject' })
    expect(result.subjectComparisons).toHaveLength(5)
  })

  it('does not substitute another section, duplicate section or duplicate table', () => {
    for (const transform of [
      (body: string) => body.replace('sectionId="meet-the-models"', 'sectionId="other"'),
      (body: string) => `${body}\n${body}`,
      (body: string) => body.replace(modelTable(), `${modelTable()}\n\n${modelTable()}`)
    ]) {
      const value = fixture(); value.inventory.body = transform(value.inventory.body)
      expect(inspect(value).models).toEqual([])
    }
  })

  it('rejects duplicate model identities and malformed/escaped/truncated tables', () => {
    const original = fixture()
    for (const body of [
      original.inventory.body.replace(modelTable(), modelTable([...inventoryRows, inventoryRows[0]])),
      original.inventory.body.replace('| Model |', '| wrong |'),
      original.inventory.body.replace('Key numbers |', 'Key numbers | extra |'),
      original.inventory.body.replace('higher quality |', 'higher \\| quality |'),
      original.inventory.body.slice(0, original.inventory.body.indexOf(heading('concepts')))
    ]) {
      const value = fixture(); value.inventory.body = body
      expect(inspect(value).inventory.structuralCoverage).toBe('insufficient')
    }
  })

  it('rejects oversized IDs and row/alias budgets before emitting them', () => {
    const value = fixture(); value.inventory.body = value.inventory.body.replace('voxtral-mini-transcribe-3-0', 'x'.repeat(257))
    expect(inspect(value).models).toEqual([])
    value.migration.body = value.migration.body.replace('`voxtral-mini-transcribe-3`', Array.from({ length: 17 }, (_, i) => `\`alias-${i}\``).join(', '))
    expect(inspect(value).mappingStatus).toBe('oversized')
    const many = fixture(); many.inventory.body = many.inventory.body.replace(modelTable(), modelTable(Array.from({ length: 1001 }, (_, i) => [`Future (\`model-${i}\`)`, 'Unknown', ''])))
    expect(inspect(many).models).toEqual([])
  })

  it('rejects invalid UTF-16, oversized bodies, bad timestamps and unexpected document fields', () => {
    for (const patch of [
      { body: '\ud800' }, { body: 'x'.repeat(MISTRAL_AUDIO_SOURCE.maxDocumentBytes + 1) },
      { retrievedAt: '2026-10-28' }, { retrievedAt: '2026-10-28T02:15:00.001Z' }, { endpoint: 'https://private.invalid' }
    ]) {
      const value = fixture(); Object.assign(value.tts, patch)
      expect(inspect(value).sources.tts.status).toBe('insufficient')
      expect(inspect(value).facets.ttsVoiceInput.state).toBe('insufficient')
    }
  })

  it('requires field-local language/base64/units statements and never promotes an example', () => {
    const value = fixture()
    const base64 = 'Send the text and a voice in one `POST` request. The response carries the audio, base64-encoded, in `audio_data`: decode it and save it to a file.'
    value.tts.body = value.tts.body.replace(base64, `\`\`\`text\n${base64}\n\`\`\``)
    value.stt.body = value.stt.body.replace('- `start` and `end`: the time of the segment in the recording, in seconds.', '- Unrelated sample: 0.0 seconds')
    value.stt.body = value.stt.body.replace('`language` is `null`', '`language` is always detected')
    const result = inspect(value)
    expect(result.facets.ttsAudioData.state).toBe('insufficient')
    expect(result.facets.sttSegmentTimestamps.state).toBe('insufficient')
    expect(result.facets.sttLanguageOutput.state).toBe('insufficient')
    expect(JSON.stringify(result)).not.toContain('contract-changed')
  })

  it('keeps missing facts insufficient while unrelated optional rows do not invalidate known facts', () => {
    const value = fixture(); value.tts.body = value.tts.body.replace('| `instruction` |', '| `new_optional_field` |')
    const result = inspect(value)
    expect(result.facets.ttsStyleUnavailable.state).toBe('insufficient')
    expect(result.facets.ttsVoiceInput.state).toBe('matches')
    expect(result.facets.ttsFormats.state).toBe('matches')
  })
})
