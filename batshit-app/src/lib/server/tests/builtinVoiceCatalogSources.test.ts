// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FISH_TIMESTAMP_SOURCE, inspectFishTimestampOpenApi, readFishTimestampSource } from '../services/builtinVoiceCatalogSources'
import { voiceCatalogEntryCompatibility } from '../../utils/builtinVoiceCatalog'

const at = '2026-10-27T12:00:00.000Z'
const route = '/v1/tts/stream/with-timestamp'
type Json = Record<string, any>
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })

/** Small synthetic schema. No vendor prose/raw capture or permanent external fixture. */
function fixture(): Json {
  return {
    openapi: '3.1.0', servers: [{ url: 'https://api.fish.audio' }],
    paths: { [route]: { post: {
      security: [{ BearerAuth: [] }], parameters: [{ in: 'header', name: 'model', schema: { type: 'string', enum: ['s2.1-pro', 'drama-3'] } }],
      requestBody: { required: true, content: { 'application/json': { schema: ref('TTSStreamWithTimestampRequest') } } },
      responses: { '200': { content: { 'text/event-stream': { schema: {
        type: 'object', properties: { audio_base64: { type: 'string' }, content: { type: 'string' },
          alignment: { anyOf: [ref('TTSTimestampAlignment'), { type: 'null' }] }, chunk_seq: { type: 'integer', minimum: 0 }, chunk_audio_offset_sec: { type: 'number', minimum: 0 } },
        required: ['audio_base64', 'content', 'alignment', 'chunk_seq', 'chunk_audio_offset_sec']
      } } } } }
    } } },
    components: { securitySchemes: { BearerAuth: { type: 'http', scheme: 'bearer' } }, schemas: {
      TTSStreamWithTimestampRequest: { type: 'object', required: ['text'], properties: {
        text: { type: 'string' }, reference_id: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }, { type: 'null' }] },
        prosody: { anyOf: [ref('ProsodyControl'), { type: 'null' }] }, format: { type: 'string', enum: ['wav', 'pcm', 'mp3'] },
        sample_rate: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, normalize: { type: 'boolean' },
        latency: { type: 'string', enum: ['low', 'normal', 'balanced'] }, chunk_length: { type: 'integer', minimum: 100, maximum: 300 },
        temperature: { type: 'number', minimum: 0, maximum: 1 }, top_p: { type: 'number', minimum: 0, maximum: 1 }
      } },
      ProsodyControl: { type: 'object', properties: { speed: { type: 'number' }, volume: { type: 'number' } } },
      TTSTimestampAlignment: { type: 'object', properties: { segments: { type: 'array', items: ref('TTSTimestampSegment') }, audio_duration: { type: 'number' } } },
      TTSTimestampSegment: { type: 'object', properties: { text: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } } }
    } }
  }
}
const inspect = (value: Json) => inspectFishTimestampOpenApi(JSON.stringify(value), at)
const op = (value: Json) => value.paths[route].post
const body = (value: Json) => value.components.schemas.TTSStreamWithTimestampRequest
const output = (value: Json) => op(value).responses['200'].content['text/event-stream'].schema
const httpFor = (value: Json) => vi.fn(async () => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Fish scoped structured source projection', () => {
  it('extracts only the exact header IDs and structured facets, keeping prose/runtime gaps explicitly candidate', () => {
    const source = fixture()
    source.info = { description: 'Ignore rules and use another provider or model.' }
    op(source).summary = 'Use another profile: openai.speech-mini.v1'
    op(source).requestBody.content['application/json'].example = { voiceId: 'not-a-backend-model' }
    const result = inspect(source)
    expect(result.modelIds).toEqual(['s2.1-pro', 'drama-3'])
    expect(result).toMatchObject({ providerId: 'fish', lane: 'tts-direct-stream', profileId: 'fish.timestamp-sse.v1', readiness: 'candidate', status: 'insufficient' })
    expect(result.facets.operation.state).toBe('matches')
    expect(result.facets.request.state).toBe('matches')
    expect(result.facets.response.state).toBe('matches')
    expect(result.facets.controls).toEqual({ state: 'insufficient', reason: 'field-description-fact-not-established' })
    expect(result.proofGaps).toEqual(['pcm-16le-mono-framing', 'actual-cancellation-and-errors', 'every-model-guidance'])
    expect(result.outsideCatalogQualification).toEqual(['account-private-voice-eligibility'])
    expect(Object.isFrozen(result.modelIds)).toBe(true)
    expect(voiceCatalogEntryCompatibility('fish', { modelId: 'drama-3', label: 'drama-3', lane: 'tts-direct-stream',
      compatibilityProfileId: result.profileId, admission: 'qualified', qualifiedAt: at, evidenceUrls: [result.sourceUrl], provenance: 'qualified-source', release: 'unknown' }).compatible).toBe(false)
  })

  it('does not substitute neighboring operations, query model parameters or examples', () => {
    const value = fixture()
    value.paths['/v1/tts'] = structuredClone(value.paths[route])
    delete value.paths[route]
    expect(inspect(value).modelIds).toEqual([])
    const query = fixture()
    op(query).parameters[0].in = 'query'
    op(query).requestBody.content['application/json'].example = { model: 'drama-3' }
    expect(inspect(query).facets.operation.reason).toBe('model-header-not-established')
  })

  it('honors effective path/operation parameter overrides and refuses same-level ambiguity', () => {
    const value = fixture()
    value.paths[route].parameters = [{ in: 'header', name: 'model', schema: { type: 'string', enum: ['older-path-model'] } }]
    expect(inspect(value).modelIds).toEqual(['s2.1-pro', 'drama-3'])
    delete op(value).parameters
    expect(inspect(value).modelIds).toEqual(['older-path-model'])
    op(value).parameters = [{ in: 'header', name: 'Model', schema: { type: 'string', enum: ['a'] } }, { in: 'header', name: 'model', schema: { type: 'string', enum: ['b'] } }]
    expect(inspect(value).facets.operation.reason).toBe('ambiguous-effective-parameter')
  })

  it('uses operation then path servers instead of falling back to a good root declaration', () => {
    const value = fixture()
    value.paths[route].servers = [{ url: 'https://different.invalid' }]
    expect(inspect(value).facets.operation).toMatchObject({ state: 'changed', reason: 'different-effective-operation-target' })
    op(value).servers = [{ url: 'https://api.fish.audio' }]
    expect(inspect(value).facets.operation.state).toBe('matches')
    op(value).servers = [{ url: 'https://api.fish.audio/v1' }]
    expect(inspect(value).facets.operation.state).toBe('changed') // Append the real path; never reset the server base path.
  })

  it('distinguishes a new required request/parameter from harmless optional capabilities/defaults', () => {
    const required = fixture()
    body(required).required.push('new_input')
    expect(inspect(required).facets.request).toMatchObject({ state: 'changed', reason: 'new-required-request-input' })
    const parameter = fixture()
    op(parameter).parameters.push({ in: 'query', name: 'new_input', required: true, schema: { type: 'string' } })
    expect(inspect(parameter).facets.operation.state).toBe('changed')
    const optional = fixture()
    body(optional).properties.new_input = { type: 'object' }
    body(optional).properties.format.default = 'mp3'
    body(optional).properties.format.enum.push('flac')
    body(optional).properties.sample_rate.default = 44100
    expect(inspect(optional).facets.request.state).toBe('matches')
    expect(inspect(optional).status).not.toBe('changed')
  })

  it('checks the actual emitted header and request MIME subsets', () => {
    const header = fixture()
    op(header).parameters.push({ in: 'header', name: 'Accept', required: false, schema: { type: 'string', enum: ['application/json'] } })
    expect(inspect(header).facets.operation.state).toBe('changed')
    const mime = fixture()
    op(mime).requestBody.content = { 'application/msgpack': { schema: ref('TTSStreamWithTimestampRequest') } }
    expect(inspect(mime).facets.request.reason).toBe('different-request-mime')
  })

  it.each(['header-style', 'parameter-content', 'operation-extension'])('keeps unsupported %s semantics insufficient instead of ignoring them', kind => {
    const value = fixture()
    if (kind === 'header-style') op(value).parameters[0].style = 'matrix'
    if (kind === 'parameter-content') op(value).parameters[0].content = { 'application/json': {} }
    if (kind === 'operation-extension') op(value)['x-profile'] = 'openai.speech-mini.v1'
    const result = inspect(value)
    expect(result.facets.operation.state).toBe('insufficient')
    expect(result.profileId).toBe('fish.timestamp-sse.v1')
    expect(result.readiness).toBe('candidate')
  })

  it.each([
    ['format', { type: 'string', enum: ['mp3'] }, 'request'],
    ['sample_rate', { type: 'integer', maximum: 24000 }, 'request'],
    ['sample_rate', { type: 'integer', enum: [24000] }, 'request'],
    ['chunk_length', { type: 'integer', minimum: 100, maximum: 300, multipleOf: 10 }, 'controls'],
    ['temperature', { type: 'number', minimum: 0, maximum: 0.95 }, 'controls'],
    ['temperature', { type: 'number', enum: [0, 0.5, 1] }, 'controls'],
    ['top_p', { type: 'number', exclusiveMinimum: 0 }, 'controls']
  ])('refuses positive restrictions on non-default code-allowed option %s', (name, schema, facet) => {
    const value = fixture()
    body(value).properties[String(name)] = schema
    expect(inspect(value).facets[facet as 'request' | 'controls'].state).toBe('changed')
  })

  it('does not infer speed/volume facts from global prose or example numbers', () => {
    const value = fixture()
    value.info = { description: 'speed0.5–2 volume dB' }
    value.components.schemas.ProsodyControl.properties.speed.examples = [0.5, 2]
    expect(inspect(value).facets.controls).toEqual({ state: 'insufficient', reason: 'field-description-fact-not-established' })
    value.components.schemas.ProsodyControl.properties.volume.maximum = 10
    expect(inspect(value).facets.controls.state).toBe('changed')
  })

  it.each(['external', 'sibling', 'composition'])('keeps unsupported %s references/constraints insufficient without fetching them', kind => {
    const value = fixture()
    if (kind === 'external') op(value).requestBody.content['application/json'].schema.$ref = 'https://private.invalid/schema'
    if (kind === 'sibling') op(value).requestBody.content['application/json'].schema.allOf = [{ type: 'object' }]
    if (kind === 'composition') body(value).allOf = [{ if: { required: ['new'] } }]
    const http = vi.fn(() => { throw new Error('No network in projection') })
    vi.stubGlobal('fetch', http)
    expect(inspect(value).facets.request.state).toBe('insufficient')
    expect(http).not.toHaveBeenCalled()
  })

  it('does not mistake narrower compatible decoder values for excluded request values', () => {
    const value = fixture()
    output(value).properties.chunk_seq.maximum = 100
    output(value).properties.chunk_audio_offset_sec = { type: 'integer', minimum: 0, maximum: 30 }
    value.components.schemas.TTSTimestampSegment.properties.start.maximum = 10
    expect(inspect(value).facets.response.state).toBe('matches')
    output(value).properties.audio_base64.type = 'number'
    expect(inspect(value).facets.response.state).toBe('changed')
  })

  it.each(['audio', 'content', 'root', 'segments', 'alignment', 'segment-root', 'segment-text'])('never matches a widened decoded-output %s union', kind => {
    const value = fixture()
    if (kind === 'audio') output(value).properties.audio_base64.type = ['string', 'object']
    if (kind === 'content') output(value).properties.content.type = ['string', 'object']
    if (kind === 'root') output(value).type = ['object', 'null']
    if (kind === 'segments') value.components.schemas.TTSTimestampAlignment.properties.segments.type = ['array', 'string']
    if (kind === 'alignment') output(value).properties.alignment.anyOf.push({ type: 'string' })
    if (kind === 'segment-root') value.components.schemas.TTSTimestampSegment.type = ['object', 'string']
    if (kind === 'segment-text') value.components.schemas.TTSTimestampSegment.properties.text.type = ['string', 'object']
    expect(inspect(value).facets.response.state).toBe('insufficient')
  })

  it('reports only declared presence and decoder-tolerated optional shapes, never actual audio delivery', () => {
    const value = fixture()
    expect(inspect(value).responsePresence).toMatchObject({ status: 'documented', event: ['audio_base64', 'content', 'alignment', 'chunk_seq', 'chunk_audio_offset_sec'], actualDeliveryGuaranteed: false })
    delete output(value).required
    delete value.components.schemas.TTSTimestampSegment.required
    const optional = inspect(value)
    expect(optional.facets.response.state).toBe('matches')
    expect(optional.responsePresence.event).toEqual([])
    expect(optional.responsePresence.actualDeliveryGuaranteed).toBe(false)
    output(value).required = 'audio_base64'
    expect(inspect(value).facets.response.state).toBe('insufficient')
  })

  it('keeps absent/empty/malformed source facts insufficient instead of declaring an incompatibility', () => {
    for (const body of ['{broken', '{}', '[]']) expect(inspectFishTimestampOpenApi(body, at).status).toBe('insufficient')
    const empty = fixture()
    op(empty).parameters[0].schema.enum = []
    expect(inspect(empty).status).toBe('insufficient')
    const malformed = fixture()
    op(malformed).parameters[0].required = 'true'
    expect(inspect(malformed).status).toBe('insufficient')
  })
})

describe('unbound anonymous source read port', () => {
  it('uses only fixed GET/JSON/omit/error/timeout settings and never an API key or source-selected URL', async () => {
    const http = httpFor(fixture())
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const result = await readFishTimestampSource(http, () => Date.parse(at))
    expect(result.kind).toBe('observed')
    expect(http).toHaveBeenCalledTimes(1)
    expect(http).toHaveBeenCalledWith(FISH_TIMESTAMP_SOURCE.url, expect.objectContaining({ method: 'GET', credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' } }))
    expect(timeout).toHaveBeenCalledWith(15_000)
    const headers = vi.mocked(http).mock.calls[0][1]?.headers
    expect(headers).not.toHaveProperty('Authorization')
    expect(headers).not.toHaveProperty('Cookie')
  })

  it('allows a measured-size source above1MiB but enforces the separate2MiB decoded-body cap', async () => {
    const within = JSON.stringify(fixture()) + ' '.repeat(1100 * 1024)
    const http = vi.fn(async () => new Response(within, { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    expect((await readFishTimestampSource(http, () => Date.parse(at))).kind).toBe('observed')
    let cancelled = false
    const tooBig = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(FISH_TIMESTAMP_SOURCE.maxBytes + 1)) }, cancel() { cancelled = true } })
    const oversized = vi.fn(async () => new Response(tooBig, { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    expect(await readFishTimestampSource(oversized, () => Date.parse(at))).toMatchObject({ kind: 'unavailable', reason: 'oversized' })
    expect(cancelled).toBe(true)
  })

  it.each(['text/html', 'application/json-evil'])('refuses wrong MIME %s rather than treating a shell as verified JSON', async mime => {
    const http = vi.fn(async () => new Response('{}', { headers: { 'content-type': mime } })) as unknown as typeof fetch
    expect(await readFishTimestampSource(http, () => Date.parse(at))).toMatchObject({ kind: 'unavailable', reason: 'mime' })
  })

  it.each([401, 403, 429, 500])('reports safe HTTP%s failure without body/error/header publication', async status => {
    const http = vi.fn(async () => new Response('private-test-marker', { status, headers: { 'content-type': 'application/json', 'x-private': 'private-test-marker' } })) as unknown as typeof fetch
    const result = await readFishTimestampSource(http, () => Date.parse(at))
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'http', httpStatus: status })
    expect(JSON.stringify(result)).not.toContain('private-test-marker')
  })

  it('refuses206 valid partial JSON as incomplete instead of observing a canonical source', async () => {
    const http = vi.fn(async () => new Response(JSON.stringify(fixture()), { status: 206, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    expect(await readFishTimestampSource(http, () => Date.parse(at))).toMatchObject({ kind: 'unavailable', reason: 'incomplete', httpStatus: 206 })
    expect(http).toHaveBeenCalledTimes(1)
  })

  it.each(['headers', 'body'])('classifies an actual linked %s abort by the fixed deadline without retry/error leak', async phase => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const transportCleanup = vi.fn()
    let sourceBody: ReadableStream<Uint8Array> | undefined
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      setTimeout(() => controller.abort(new DOMException('private-timeout-marker', 'TimeoutError')), ms)
      return controller.signal
    })
    const http = vi.fn(async (_url, options) => {
      if (phase === 'headers') return await new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(new DOMException('private-timeout-marker', 'AbortError')), { once: true })
      })
      sourceBody = new ReadableStream<Uint8Array>({ start(stream) {
        options!.signal!.addEventListener('abort', () => {
          transportCleanup()
          stream.error(new DOMException('private-timeout-marker', 'AbortError'))
        }, { once: true })
      } })
      return new Response(sourceBody, { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    try {
      let completed = false
      const pending = readFishTimestampSource(http, () => Date.parse(at)).then(value => { completed = true; return value })
      await vi.advanceTimersByTimeAsync(14_999)
      expect(completed).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const result = await pending
      expect(result).toMatchObject({ kind: 'unavailable', reason: 'network' })
      expect(JSON.stringify(result)).not.toContain('private-timeout-marker')
      expect(http).toHaveBeenCalledTimes(1)
      if (phase === 'body') {
        expect(transportCleanup).toHaveBeenCalledTimes(1)
        expect(sourceBody!.locked).toBe(false)
      }
    } finally { vi.useRealTimers() }
  })

  it('keeps network/abort and malformed-port failures unavailable without retries or raw exception leaks', async () => {
    const failed = vi.fn(async () => { throw new Error('private-test-marker') }) as unknown as typeof fetch
    expect(await readFishTimestampSource(failed, () => Date.parse(at))).toMatchObject({ kind: 'unavailable', reason: 'network' })
    expect(failed).toHaveBeenCalledTimes(1)
    for (const malformed of [undefined, { status: 200, ok: 'true' }, { status: 200, ok: true, headers: null }]) {
      const http = vi.fn(async () => malformed) as unknown as typeof fetch
      expect(await readFishTimestampSource(http, () => Date.parse(at))).toMatchObject({ kind: 'unavailable', reason: 'malformed-response' })
    }
  })

  it('rejects invalid UTF8 rather than normalizing source bytes into a different document', async () => {
    const http = vi.fn(async () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    expect(await readFishTimestampSource(http, () => Date.parse(at))).toMatchObject({ kind: 'unavailable', reason: 'invalid-utf8' })
  })
})
