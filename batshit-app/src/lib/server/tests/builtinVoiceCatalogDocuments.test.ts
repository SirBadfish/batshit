// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { load } from 'cheerio'
import { inspectVoiceOperationContract } from '../services/builtinVoiceCatalogContract'
import { inspectCartesiaVoiceDocument, inspectMistralVoiceApi, parseVoiceYaml, voiceSourceTable, voiceSourceHtmlProjection } from '../services/builtinVoiceCatalogDocuments'
import { speechSourceScopeFingerprints } from '../services/builtinVoiceCatalogSpeechSources'

function api() {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
  const operation = (request: string, mime: string, response: string) => ({ post: { requestBody: { content: { [mime]: { schema: ref(request) } } }, responses: { '200': { content: { 'application/json': { schema: ref(response) } } } } } })
  return { openapi: '3.1.0', servers: [{ url: 'https://api.mistral.ai' }], security: [{ ApiKey: [] }], paths: { '/v1/audio/speech': operation('SpeechRequest','application/json','SpeechResponse'), '/v1/audio/transcriptions': operation('AudioTranscriptionRequest','multipart/form-data','TranscriptionResponse') }, components: { securitySchemes: { ApiKey: { type: 'http', scheme: 'bearer' } }, schemas: {
    SpeechRequest: { type: 'object', required: ['input'], properties: { model: { type: 'string' }, input: { type: 'string' }, voice_id: { type: 'string' }, response_format: { enum: ['mp3','wav','pcm','flac','opus'] } } },
    SpeechResponse: { type: 'object', properties: { audio_data: { type: 'string' } } },
    AudioTranscriptionRequest: { type: 'object', required: ['model'], properties: { model: { type: 'string' }, file: { type: 'string', format: 'binary' }, language: { anyOf: [{ type: 'string' }, { type: 'null' }] }, timestamp_granularities: { type: 'array', items: { enum: ['segment'] } } } },
    TranscriptionResponse: { type: 'object', properties: { text: { type: 'string' }, language: { anyOf: [{ type: 'string' }, { type: 'null' }] }, segments: { type: 'array' } } }
  } } }
}
describe('finite official voice documents', () => {
  it('keeps nested HTML and Markdown structure in selected-scope projections', () => {
    const html = load('<main><section><p>input</p><div><p>text</p></div></section></main>')
    const before = voiceSourceHtmlProjection(html('section').toArray())
    html('div p').unwrap()
    expect(voiceSourceHtmlProjection(html('section').toArray())).not.toBe(before)
    const doc = '## Request and response\n\nRequest\n\n## API reference\n\n- `audioConfig`\n  - `audioEncoding`\n'
    expect(speechSourceScopeFingerprints({ inworldSpeech: doc }).inworldApi).not.toBe(speechSourceScopeFingerprints({ inworldSpeech: doc.replace('  - `audioEncoding`', '- `audioEncoding`') }).inworldApi)
    expect(speechSourceScopeFingerprints({ inworldSpeech: doc }).inworldApi).not.toBe(speechSourceScopeFingerprints({ inworldSpeech: doc.replace('  - `audioEncoding`', '\t - `audioEncoding`') }).inworldApi)
  })
  it('checks the supported Mistral request/output subset without a model-name registry', () => {
    expect(inspectMistralVoiceApi(JSON.stringify(api()))).toMatchObject({ tts: false, recorded: false, timestampField: 'timestamp_granularities', contracts: { tts: { state: 'insufficient', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } } })
    const changed = api(); changed.components.schemas.SpeechRequest.required.push('unsupported_input')
    expect(inspectMistralVoiceApi(JSON.stringify(changed)).contracts.tts.state).toBe('changed')
  })
  it('does not follow an external schema reference', () => {
    const changed = api(); changed.paths['/v1/audio/speech'].post.requestBody.content['application/json'].schema.$ref = 'https://private.invalid/secret'
    expect(inspectMistralVoiceApi(JSON.stringify(changed)).contracts.tts).toMatchObject({ state: 'insufficient', fingerprint: null })
  })
  it.each(['a: 1\na: 2', '200: first\n"200": second', 'value: !!js/function function(){}', 'value: &x 1\ncopy: *x', '%YAML 1.1\n---\na: yes', '? [a,b]\n: bad'])('refuses duplicate/coercing keys, custom tags, aliases and schema drift', input => {
    expect(() => parseVoiceYaml(input)).toThrow()
  })
  it('bounds YAML depth before conversion and accepts inert JSON-compatible core scalars', () => {
    expect(parseVoiceYaml('a: 1\nb: true\nc: null')).toEqual({ a: 1, b: true, c: null })
    expect(() => parseVoiceYaml('a: '+ '['.repeat(70)+'0'+']'.repeat(70))).toThrow('bounds')
  })
  it('selects only one exact root table, ignoring code and navigation examples', () => {
    const table = '| Model ID | Task |\n| - | - |\n| `Exact.New-ID` | speech |\n'
    expect(voiceSourceTable('```md\n'+table+'```\n'+table, ['Model ID','Task'])).toEqual([['`Exact.New-ID`','speech']])
    expect(() => voiceSourceTable(table+'\n'+table, ['Model ID','Task'])).toThrow('structure')
  })
  it('uses explicit backwards compatibility and stable rows, preserving preview and excluding templates', () => {
    const source = '# Sonic\n\n| `model_id` | Model update behavior | Recommended for |\n| - | - | - |\n| `Exact.New` | Will be updated to point to the most recent stable snapshot | stable |\n| `sonic-preview` | Beta model | preview |\n| `sonic-3.6-YYYY-MM-DD` | template | example |\n\n| Snapshot | Release Date | Languages | Status |\n| - | - | - | - |\n| `Exact.Snapshot` | date | en | Stable |\n\n## Switching from Sonic 3.5?\n\nNew Sonic is fully backwards compatible with Sonic 3.5.\n'
    expect(inspectCartesiaVoiceDocument(source)).toEqual([{ modelId: 'Exact.New', documentedCompatibility: true, preview: false, compatible: false }, { modelId: 'sonic-preview', documentedCompatibility: false, preview: true, compatible: false }, { modelId: 'Exact.Snapshot', documentedCompatibility: true, preview: false, compatible: false }])
    expect(inspectCartesiaVoiceDocument(source.replace('fully backwards compatible', 'not backwards compatible')).every(model => !model.documentedCompatibility)).toBe(true)
  })
})


describe('scoped semantic contract locking', () => {
  const inspect = (value: ReturnType<typeof api>) => inspectVoiceOperationContract(value, 'mistral-speech')
  it('allows only the exact discovery enum and inert schema annotations to vary', () => {
    const baseline = api(), after = structuredClone(baseline)
    Object.assign(after.components.schemas.SpeechRequest.properties.model, { enum: ['Exact.New-ID'], title: 'model annotation', examples: ['untrusted annotation'] })
    expect(inspect(after).fingerprint).toBe(inspect(baseline).fingerprint)
    Object.assign(after.components.schemas.SpeechRequest.properties.model, { maxLength: 3 })
    expect(inspect(after).fingerprint).not.toBe(inspect(baseline).fingerprint)
  })
  it('retains multipart/media encoding and non-inert path semantics, refusing even an empty ref', () => {
    const before = api(), media = structuredClone(before)
    Object.assign(media.paths['/v1/audio/speech'].post.requestBody.content['application/json'], { encoding: { input: { style: 'different' } } })
    expect(inspect(media).fingerprint).not.toBe(inspect(before).fingerprint)
    const path = structuredClone(before); Object.assign(path.paths['/v1/audio/speech'], { 'x-required-contract': { tags: true } })
    expect(inspect(path).fingerprint).not.toBe(inspect(before).fingerprint)
    Object.assign(path.paths['/v1/audio/speech'], { $ref: '' })
    expect(inspect(path)).toMatchObject({ state: 'insufficient', fingerprint: null })
  })
  it('preserves semantic field names and object-valued const/default data', () => {
    const before = api(); Object.assign(before.components.schemas.SpeechRequest.properties.input, { const: { tags: { example: 'old' }, title: 'old' } })
    const after = structuredClone(before); Object.assign(after.components.schemas.SpeechRequest.properties.input, { const: { tags: { example: 'new' }, title: 'old' } })
    expect(inspect(after).fingerprint).not.toBe(inspect(before).fingerprint)
    Object.assign(before.components.schemas.SpeechResponse.properties.audio_data, { properties: { title: { type: 'string' } } })
    Object.assign(after.components.schemas.SpeechResponse.properties.audio_data, { properties: { title: { type: 'number' } } })
    expect(inspect(after).fingerprint).not.toBe(inspect(before).fingerprint)
  })
  it('uses operation parameter overrides and does not call removal of auth a contradiction', () => {
    const value = api(), parameter = { name: 'extra', in: 'query', required: true }
    Object.assign(value.paths['/v1/audio/speech'], { parameters: [parameter] })
    Object.assign(value.paths['/v1/audio/speech'].post, { parameters: [{ ...parameter, required: false }] })
    expect(inspect(value).state).toBe('insufficient')
    Object.assign(value.paths['/v1/audio/speech'].post, { parameters: [] })
    expect(inspect(value).state).toBe('changed')
    const loose = api(); Object.assign(loose.paths['/v1/audio/speech'].post, { security: [] })
    expect(inspect(loose).state).toBe('insufficient')
  })
})


describe('semantic projection envelopes and hostile property keys', () => {
  it('retains both body/response and schema envelopes independently', () => {
    const before = api(), after = structuredClone(before)
    Object.assign(after.paths['/v1/audio/speech'].post.requestBody, { required: true })
    const inspect = (value: typeof before) => inspectVoiceOperationContract(value, 'mistral-speech')
    expect(inspect(after).fingerprint).not.toBe(inspect(before).fingerprint)
    const response = structuredClone(before)
    Object.assign(response.paths['/v1/audio/speech'].post.responses['200'], { headers: { 'x-required-output': { schema: { const: 'new' } } } })
    expect(inspect(response).fingerprint).not.toBe(inspect(before).fingerprint)
  })
  it('retains own __proto__ schema semantics rather than mutating a temporary prototype', () => {
    const before = api(), after = JSON.parse(JSON.stringify(before)) as typeof before
    Object.defineProperty(after.components.schemas.SpeechRequest.properties.input, '__proto__', { enumerable: true, value: { const: 'unknown-constraint' } })
    expect(inspectVoiceOperationContract(after, 'mistral-speech').fingerprint).not.toBe(inspectVoiceOperationContract(before, 'mistral-speech').fingerprint)
  })
})
