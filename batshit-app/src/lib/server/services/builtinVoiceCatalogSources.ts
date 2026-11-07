import { createHash } from 'node:crypto'
import { readVoiceSourceBody, VOICE_SOURCE_HTTP_CONTRACTS } from './builtinVoiceCatalogSourceHttp'

export const FISH_TIMESTAMP_SOURCE = Object.freeze({
  id: 'fish-public-voice-api-v1', parserId: 'fish-timestamp-openapi-json-v1',
  providerId: 'fish', lane: 'tts-direct-stream', profileId: 'fish.timestamp-sse.v1',
  ...VOICE_SOURCE_HTTP_CONTRACTS.fishTimestamp, maxModels: 1000
} as const)

type State = 'matches' | 'changed' | 'insufficient'
type FacetId = 'operation' | 'request' | 'response' | 'controls' | 'voiceInput' | 'timingSemantics' | 'modelNotes'
export interface VoiceSourceFacet { state: State; reason: string }
export interface FishTimestampSourceObservation {
  sourceId: typeof FISH_TIMESTAMP_SOURCE.id
  parserId: typeof FISH_TIMESTAMP_SOURCE.parserId
  providerId: 'fish'; lane: 'tts-direct-stream'; profileId: 'fish.timestamp-sse.v1'
  sourceUrl: typeof FISH_TIMESTAMP_SOURCE.url
  checkedAt: string; sourceDigest: string
  status: 'scoped-match' | 'changed' | 'insufficient'
  modelIds: readonly string[]
  facets: Readonly<Record<FacetId, VoiceSourceFacet>>
  /** Documentation is never a new model/runtime/account qualification. */
  readiness: 'candidate'
  proofGaps: readonly string[]
  /** This belongs to the existing user/runtime owner and never blocks global qualification. */
  outsideCatalogQualification: readonly string[]
  responsePresence: Readonly<{
    status: 'documented' | 'insufficient'
    event: readonly string[]; alignment: readonly string[]; segment: readonly string[]
    actualDeliveryGuaranteed: false
  }>
}

type Row = Record<string, unknown>
class FactFailure extends Error {
  constructor(readonly state: State, readonly reason: string) { super(reason) }
}
const missing = (reason: string): never => { throw new FactFailure('insufficient', reason) }
const changed = (reason: string): never => { throw new FactFailure('changed', reason) }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const encoder = new TextEncoder()
const path = '/v1/tts/stream/with-timestamp'
const endpoint = `https://api.fish.audio${path}`
const annotations = ['title', 'description', 'default', 'examples', 'deprecated', '$comment']

function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return missing('missing-or-unsupported-object')
  return value as Row
}
function child(value: Row, key: string): Row {
  if (!Object.hasOwn(value, key)) return missing('missing-required-declaration')
  return row(value[key])
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 1000) return missing('missing-or-oversized-array')
  return value
}
function strings(value: unknown): string[] {
  const values = list(value)
  if (values.some(value => typeof value !== 'string' || value.length > 256) || new Set(values).size !== values.length) return missing('ambiguous-string-list')
  return values as string[]
}
function keys(value: Row, semantic: readonly string[]): void {
  if (Object.keys(value).some(key => !semantic.includes(key) && !annotations.includes(key))) missing('unsupported-schema-constraint')
}
function localRef(spec: Row, value: unknown, name: string): Row {
  const reference = row(value)
  if (Object.keys(reference).some(key => key !== '$ref')) return missing('unsupported-reference-sibling')
  if (reference.$ref !== `#/components/schemas/${name}`) return missing('unknown-or-external-reference')
  return child(child(child(spec, 'components'), 'schemas'), name)
}
function primitive(value: unknown, type: string): Row {
  const schema = row(value)
  const actual = schema.type
  if (actual === undefined) return missing('missing-or-composed-type')
  const types = Array.isArray(actual) ? actual : [actual]
  if (!types.length || new Set(types).size !== types.length || types.some(value => !['string', 'number', 'integer', 'object', 'array', 'boolean', 'null'].includes(String(value)))) return missing('malformed-schema-type')
  if (actual !== type && !(type === 'integer' && actual === 'number') && !(Array.isArray(actual) && (actual.includes(type) || type === 'integer' && actual.includes('number')))) changed('incompatible-field-type')
  return schema
}

function decodedPrimitive(value: unknown, type: 'string' | 'object' | 'array'): Row {
  const schema = row(value)
  if (schema.type === undefined) return missing('missing-or-composed-decoded-type')
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  if (!types.length || types.some(value => typeof value !== 'string')) return missing('malformed-decoded-type')
  if (types.length !== 1) return missing('unsupported-decoded-type-union')
  if (types[0] !== type) {
    if (['string', 'number', 'integer', 'object', 'array', 'boolean', 'null'].includes(types[0])) changed('incompatible-decoded-type')
    return missing('unsupported-decoded-type')
  }
  return schema
}
function decodedObject(value: unknown): { schema: Row; properties: Row } {
  const schema = decodedPrimitive(value, 'object')
  keys(schema, ['type', 'properties', 'required', 'additionalProperties'])
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') missing('unsupported-additional-properties')
  required(schema)
  return { schema, properties: child(schema, 'properties') }
}
function decodedString(value: unknown): void {
  const schema = decodedPrimitive(value, 'string')
  keys(schema, ['type'])
}

function decodedNumber(value: unknown, kind: 'number' | 'integer'): void {
  const schema = row(value)
  if (schema.type === undefined) return missing('missing-or-composed-type')
  if (Array.isArray(schema.type)) return missing('unsupported-decoded-type-union')
  if (schema.type !== kind && !(kind === 'number' && schema.type === 'integer')) {
    if (typeof schema.type === 'string' && ['string', 'boolean', 'object', 'array', 'null'].includes(schema.type)) changed('incompatible-decoded-type')
    return missing('unsupported-decoded-type')
  }
  keys(schema, ['type', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'enum', 'const'])
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
    if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) missing('malformed-numeric-constraint')
  }
  // Output restrictions narrow the provider's values; they do not exclude our emitted inputs.
  if (typeof schema.multipleOf === 'number' && schema.multipleOf <= 0) missing('malformed-numeric-constraint')
  if (schema.enum !== undefined && !list(schema.enum).some(value => typeof value === 'number')) missing('unsupported-decoded-enum')
  if (schema.const !== undefined && typeof schema.const !== 'number') missing('unsupported-decoded-constant')
}
function objectSchema(value: unknown): { schema: Row; properties: Row } {
  const schema = primitive(value, 'object')
  keys(schema, ['type', 'properties', 'required', 'additionalProperties'])
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') missing('unsupported-additional-properties')
  required(schema)
  return { schema, properties: child(schema, 'properties') }
}
function required(schema: Row): string[] { return schema.required === undefined ? [] : strings(schema.required) }

function numeric(value: unknown, type: 'number' | 'integer', low: number, high: number, finiteValues?: readonly number[]): void {
  const schema = primitive(value, type)
  keys(schema, ['type', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'enum', 'const'])
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
    if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) missing('malformed-numeric-constraint')
  }
  if (typeof schema.minimum === 'number' && schema.minimum > low || typeof schema.maximum === 'number' && schema.maximum < high
    || typeof schema.exclusiveMinimum === 'number' && schema.exclusiveMinimum >= low
    || typeof schema.exclusiveMaximum === 'number' && schema.exclusiveMaximum <= high) changed('excludes-code-allowed-number')
  if (schema.enum !== undefined) {
    const allowed = list(schema.enum)
    if (!finiteValues) return changed('restricts-continuous-code-range')
    if (finiteValues.some(value => !allowed.includes(value))) changed('excludes-code-allowed-number')
  }
  if (schema.const !== undefined) {
    if (!finiteValues || finiteValues.some(value => value !== schema.const)) changed('excludes-code-allowed-number')
  }
  if (typeof schema.multipleOf === 'number') {
    const multiple = schema.multipleOf
    if (multiple <= 0) missing('malformed-numeric-constraint')
    const values = finiteValues ?? (type === 'integer' ? [low, 1] : null)
    if (!values || values.some(value => Math.abs(value / multiple - Math.round(value / multiple)) > 1e-8)) changed('excludes-code-allowed-number')
  }
}
function stringChoices(value: unknown, needed: readonly string[]): void {
  const schema = primitive(value, 'string')
  keys(schema, ['type', 'enum', 'const'])
  if (schema.enum !== undefined && needed.some(value => !strings(schema.enum).includes(value))) changed('excludes-code-emitted-choice')
  if (schema.const !== undefined && needed.some(value => value !== schema.const)) changed('excludes-code-emitted-choice')
}
function unconstrainedString(value: unknown): void {
  const schema = primitive(value, 'string')
  keys(schema, ['type']) // A private voice's value eligibility is not inferred from a pattern/list.
}
function unionBranch(value: unknown, kind: string): Row {
  const schema = row(value)
  if (!schema.anyOf) return schema
  keys(schema, ['anyOf'])
  const branches = list(schema.anyOf).map(row).filter(branch => branch.type === kind)
  if (branches.length !== 1) return missing('ambiguous-or-unsupported-union')
  return branches[0]
}
function refBranch(spec: Row, value: unknown, name: string): Row {
  const schema = row(value)
  if (!schema.anyOf) return localRef(spec, schema, name)
  keys(schema, ['anyOf'])
  const references = list(schema.anyOf).map(row).filter(branch => branch.$ref !== undefined)
  if (references.length !== 1) return missing('ambiguous-or-unsupported-union')
  return localRef(spec, references[0], name)
}
function decodedRefBranch(spec: Row, value: unknown, name: string): Row {
  const schema = row(value)
  if (!schema.anyOf) return localRef(spec, schema, name)
  keys(schema, ['anyOf'])
  const branches = list(schema.anyOf).map(row)
  let reference: Row | undefined, nullable = false
  for (const branch of branches) {
    if (branch.$ref !== undefined) {
      if (reference) return missing('ambiguous-decoded-reference')
      localRef(spec, branch, name)
      reference = branch
    } else {
      keys(branch, ['type'])
      if (nullable || branch.type !== 'null') return missing('unsupported-decoded-reference-union')
      nullable = true
    }
  }
  if (!reference) return missing('decoded-reference-not-established')
  return localRef(spec, reference, name)
}
function textFact(value: unknown, expected: string): void {
  if (typeof value !== 'string' || encoder.encode(value).length > 8192 || hash(value.replace(/\s+/g, ' ').trim()) !== expected) missing('field-description-fact-not-established')
}

function operation(spec: Row): { op: Row; models: string[]; modelParameter: Row } {
  if (spec.openapi !== '3.1.0') return missing('unsupported-openapi-version')
  const item = child(child(spec, 'paths'), path)
  if (item.$ref !== undefined) return missing('unsupported-path-reference')
  const op = child(item, 'post')
  if (op.$ref !== undefined) return missing('unsupported-operation-reference')
  const operationKeys = ['summary', 'description', 'tags', 'operationId', 'deprecated', 'externalDocs', 'servers', 'security', 'parameters', 'requestBody', 'responses', 'x-codeSamples']
  if (Object.keys(op).some(key => !operationKeys.includes(key))) return missing('unsupported-operation-extension')
  const servers = list(op.servers ?? item.servers ?? spec.servers).map(row)
  if (!servers.length) return missing('effective-server-unknown')
  const targets = servers.map(server => {
    if (server.variables !== undefined || typeof server.url !== 'string') return missing('unsupported-server-declaration')
    let url: URL
    try { url = new URL(server.url) } catch { return missing('unsupported-server-declaration') }
    if (url.username || url.password || url.search || url.hash) return missing('unsupported-server-declaration')
    return `${url.href.replace(/\/+$/, '')}${path}`
  })
  if (!targets.includes(endpoint)) changed('different-effective-operation-target')
  const security = list(op.security ?? spec.security)
  const schemes = child(child(spec, 'components'), 'securitySchemes')
  const bearer = security.some(value => {
    const requirement = row(value)
    if (Object.keys(requirement).length !== 1) return false
    const [name] = Object.keys(requirement)
    const scheme = child(schemes, name)
    return scheme.type === 'http' && scheme.scheme === 'bearer' && strings(requirement[name]).length === 0
  })
  if (!bearer) return missing('existing-bearer-contract-not-established')
  const parameters = new Map<string, Row>()
  for (const group of [item.parameters, op.parameters]) {
    const level = new Set<string>()
    for (const value of group === undefined ? [] : list(group)) {
      const parameter = row(value)
      if (parameter.$ref !== undefined || typeof parameter.name !== 'string' || typeof parameter.in !== 'string') return missing('unsupported-parameter-reference-or-shape')
      if (!parameter.name.length || parameter.name.length > 256 || !['query', 'header', 'path', 'cookie'].includes(parameter.in)
        || parameter.required !== undefined && typeof parameter.required !== 'boolean') return missing('unsupported-parameter-reference-or-shape')
      if (parameter.in === 'header') {
        try { new Headers([[parameter.name, '']]) } catch { return missing('malformed-header-name') }
        if (['model', 'authorization', 'content-type', 'accept'].includes(parameter.name.toLowerCase())) {
          keys(parameter, ['name', 'in', 'required', 'schema', 'example', 'style', 'explode'])
          if (parameter.style !== undefined && parameter.style !== 'simple'
            || parameter.explode !== undefined && typeof parameter.explode !== 'boolean') return missing('unsupported-header-serialization')
        }
      }
      const key = JSON.stringify([parameter.in, parameter.in === 'header' ? parameter.name.toLowerCase() : parameter.name])
      if (level.has(key)) return missing('ambiguous-effective-parameter')
      level.add(key)
      parameters.set(key, parameter)
    }
  }
  for (const parameter of parameters.values()) {
    if (parameter.required === true && !(parameter.in === 'header' && ['model', 'authorization', 'content-type', 'accept'].includes(String(parameter.name).toLowerCase()))) changed('new-required-operation-input')
    if (parameter.in === 'header') {
      const name = String(parameter.name).toLowerCase()
      if (name === 'content-type') stringChoices(parameter.schema, ['application/json'])
      if (name === 'accept') stringChoices(parameter.schema, ['text/event-stream'])
      if (name === 'authorization') unconstrainedString(parameter.schema)
    }
  }
  const model = parameters.get(JSON.stringify(['header', 'model']))
  if (!model) return missing('model-header-not-established')
  const schema = primitive(model.schema, 'string')
  keys(schema, ['type', 'enum'])
  const models = strings(schema.enum)
  if (!models.length || models.length > FISH_TIMESTAMP_SOURCE.maxModels || models.some(value => !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(value))) return missing('invalid-or-empty-model-header-enum')
  return { op, models, modelParameter: model }
}

const factIds: FacetId[] = ['operation', 'request', 'response', 'controls', 'voiceInput', 'timingSemantics', 'modelNotes']
const gaps = Object.freeze(['pcm-16le-mono-framing', 'actual-cancellation-and-errors', 'every-model-guidance'] as const)
const outsideCatalogQualification = Object.freeze(['account-private-voice-eligibility'] as const)
// Exact reviewed property-description facts, never a search for model-like prose/examples.
// Different wording is insufficient, not positive incompatibility or fresh qualification.
const requestNotes = {
  text: '19f47b002874882c97c7c0b2ca84da3b8f84d1dfb1ea7da1df310af5dc231c96',
  format: 'f4943bea8fa64e0e0ee8ab63ca558b64b1782739530da8b88249c4c72b64576f',
  sample_rate: '1c840f3338f086fa073dbf28f1c6b18125e9a5f76a687d0ec61c00eb112f466a',
  normalize: '95f578285ed556e80a75d794141f57f04e0bcce3a50543179d457d0de174824f',
  latency: '67fe9724e0b5bd8246933ad7133fe001cd24ba2ce6ff826c08b81e307602d710',
  chunk_length: '8c7ddd8e1e63ab4148459308414802bee59cd87e6e937c98456be417d3abeb6f',
  temperature: '4e543377f8320a0279cad7d5ad987cc60a6b5656f556e0110c2ff44055cbb45c',
  top_p: '38d7c0175a4e45b380fdaa73a71d18179851fca38b72831c90eedebe5dab76b1'
} as const
const responseNotes = {
  audio_base64: '59287d7dabc45ee2a848ca0a647265161792a59ff09b794b4e6945fdb8a0f8a2',
  content: '1a4a4424e68a74a172050ab1859869ffeb4aa8bb3e3b7be07e4221be6ddbf358',
  chunk_seq: '7af1b5b9c33a4ff43d734798ad5d945cbbdd9c389701582db7df9073a860a46e',
  chunk_audio_offset_sec: '96edcbe830d71f4dc39eb505653b7438849273ef346028731b2a7e5f8b8c471b'
} as const

/** Fixed source + exact operation only. No caller-supplied provider/profile/URL/strategy. */
export function inspectFishTimestampOpenApi(body: string, checkedAt: string): FishTimestampSourceObservation {
  if (!Number.isFinite(Date.parse(checkedAt)) || new Date(checkedAt).toISOString() !== checkedAt) throw new Error('Invalid source check time')
  const facets = Object.fromEntries(factIds.map(id => [id, { state: 'insufficient', reason: 'operation-not-established' }])) as Record<FacetId, VoiceSourceFacet>
  let modelIds: string[] = []
  let responsePresence: FishTimestampSourceObservation['responsePresence'] = {
    status: 'insufficient', event: [], alignment: [], segment: [], actualDeliveryGuaranteed: false
  }
  const inspect = (id: FacetId, check: () => void): void => {
    try { check(); facets[id] = { state: 'matches', reason: 'scoped-documentation-facts' } }
    catch (error) { facets[id] = error instanceof FactFailure ? { state: error.state, reason: error.reason } : { state: 'insufficient', reason: 'unreadable-source-facts' } }
  }
  let spec: Row | undefined, op: Row | undefined, modelParameter: Row | undefined
  inspect('operation', () => {
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > FISH_TIMESTAMP_SOURCE.maxBytes) return missing('source-byte-limit')
    spec = row(JSON.parse(body))
    const selected = operation(spec)
    op = selected.op; modelIds = selected.models; modelParameter = selected.modelParameter
  })
  if (spec && op && facets.operation.state === 'matches') {
    const request = (): Row => {
      const body = child(op!, 'requestBody')
      if (body.$ref !== undefined || body.required !== undefined && typeof body.required !== 'boolean') return missing('unsupported-request-body')
      const content = child(body, 'content')
      if (!Object.hasOwn(content, 'application/json')) {
        if (Object.keys(content).length) changed('different-request-mime')
        return missing('request-mime-unknown')
      }
      return localRef(spec!, child(content, 'application/json').schema, 'TTSStreamWithTimestampRequest')
    }
    const props = (): Row => objectSchema(request()).properties
    const response = (): Row => {
      const success = child(child(op!, 'responses'), '200')
      if (success.$ref !== undefined) return missing('unsupported-response-reference')
      const content = child(success, 'content')
      if (!Object.hasOwn(content, 'text/event-stream')) {
        if (Object.keys(content).length) changed('different-success-response-mime')
        return missing('success-response-mime-unknown')
      }
      return child(content, 'text/event-stream')
    }
    inspect('request', () => {
      const { schema, properties } = objectSchema(request())
      const always = ['text', 'reference_id', 'format', 'sample_rate', 'latency', 'chunk_length', 'normalize']
      if (required(schema).some(key => !always.includes(key))) changed('new-required-request-input')
      unconstrainedString(properties.text)
      stringChoices(properties.format, ['pcm'])
      numeric(unionBranch(properties.sample_rate, 'integer'), 'integer', 8000, 44100, [8000, 16000, 24000, 32000, 44100])
      const normalize = primitive(properties.normalize, 'boolean'); keys(normalize, ['type', 'enum', 'const'])
      if (normalize.const !== undefined && normalize.const !== true || normalize.enum !== undefined && !list(normalize.enum).includes(true)) changed('excludes-code-emitted-choice')
    })
    inspect('voiceInput', () => {
      const reference = row(props().reference_id)
      unconstrainedString(unionBranch(reference, 'string'))
      textFact(reference.description, '3d7b1976134875a917de8b44f79214f45bd90e50b649e39bb12926e08774330f')
    })
    inspect('controls', () => {
      const properties = props()
      numeric(properties.temperature, 'number', 0, 1)
      numeric(properties.top_p, 'number', 0, 1)
      numeric(properties.chunk_length, 'integer', 100, 300)
      stringChoices(properties.latency, ['low', 'normal', 'balanced'])
      const prosody = objectSchema(refBranch(spec!, properties.prosody, 'ProsodyControl'))
      if (required(prosody.schema).length) changed('new-required-prosody-input')
      numeric(prosody.properties.speed, 'number', 0.5, 2)
      numeric(prosody.properties.volume, 'number', -20, 20)
      textFact(row(prosody.properties.speed).description, 'f71a374f54b3f16cc3bb80928724cc23e10e2c079f32c1126ecea3b170720193')
      textFact(row(prosody.properties.volume).description, 'e88f4a1f06ec64f807a1e5e93d86347a6df453dade7552f3123ca82d5b09f71b')
    })
    inspect('response', () => {
      const output = decodedObject(response().schema)
      for (const key of ['audio_base64', 'content']) decodedString(output.properties[key])
      decodedNumber(output.properties.chunk_seq, 'integer')
      decodedNumber(output.properties.chunk_audio_offset_sec, 'number')
      const alignment = decodedObject(decodedRefBranch(spec!, output.properties.alignment, 'TTSTimestampAlignment'))
      decodedNumber(alignment.properties.audio_duration, 'number')
      const segments = decodedPrimitive(alignment.properties.segments, 'array'); keys(segments, ['type', 'items'])
      const segment = decodedObject(localRef(spec!, segments.items, 'TTSTimestampSegment'))
      decodedString(segment.properties.text)
      decodedNumber(segment.properties.start, 'number')
      decodedNumber(segment.properties.end, 'number')
      responsePresence = {
        status: 'documented', event: required(output.schema).filter(key => ['audio_base64', 'content', 'alignment', 'chunk_seq', 'chunk_audio_offset_sec'].includes(key)),
        alignment: required(alignment.schema).filter(key => ['segments', 'audio_duration'].includes(key)),
        segment: required(segment.schema).filter(key => ['text', 'start', 'end'].includes(key)), actualDeliveryGuaranteed: false
      }
    })
    inspect('timingSemantics', () => {
      textFact(row(decodedObject(response().schema).properties.alignment).description,
        'b55aa3ee419a35b20b91e4e1dd5851ce2c34465233dbf900bfd2d9e0551f893c')
      textFact(child(child(op!, 'responses'), '200').description, '1e84d01899f01a1b0b55dd0f336fc467a27b86c40d3b634242934c8efdac1905')
    })
    inspect('modelNotes', () => {
      textFact(modelParameter!.description, '195461e49f719c425ab8d7a73ff94d324196ea778fd68f2231f3b14fb52bc51c')
      textFact(request().description, '3304f071e70f33edceccb89b1d7af4149dd1173f3a3d8dd921675c0ca3fcb0b0')
      for (const [key, expected] of Object.entries(requestNotes)) textFact(row(props()[key]).description, expected)
      const output = decodedObject(response().schema)
      textFact(output.schema.description, 'db2d689f25c3525784ccdad80b0ec89f789e29a81ac5cd0d689cfc31d2f3ab82')
      for (const [key, expected] of Object.entries(responseNotes)) textFact(row(output.properties[key]).description, expected)
      const alignment = decodedObject(decodedRefBranch(spec!, output.properties.alignment, 'TTSTimestampAlignment'))
      textFact(row(alignment.properties.audio_duration).description, 'b07fcb6015242145ac532c2c7b2927a2ff2cd5d960f5b34914e099e56d3bb495')
      const segment = decodedObject(localRef(spec!, row(alignment.properties.segments).items, 'TTSTimestampSegment'))
      textFact(row(segment.properties.start).description, '5d79264638cdea04a1fd29f35042b07f12982877074e6a3dcb21c105e30e6743')
      textFact(row(segment.properties.end).description, '6b815c8f93d7b9f0c1321d17aa4eaed5295eecb02d2e01564a156ee91fe8857f')
    })
  }
  const states = Object.values(facets).map(value => value.state)
  if (facets.response.state === 'matches') facets.response.reason = 'declared-shapes-and-presence-not-runtime-delivery'
  for (const fact of Object.values(facets)) Object.freeze(fact)
  for (const fields of [responsePresence.event, responsePresence.alignment, responsePresence.segment]) Object.freeze(fields)
  return Object.freeze({ sourceId: FISH_TIMESTAMP_SOURCE.id, parserId: FISH_TIMESTAMP_SOURCE.parserId,
    providerId: 'fish', lane: 'tts-direct-stream', profileId: 'fish.timestamp-sse.v1', sourceUrl: FISH_TIMESTAMP_SOURCE.url,
    checkedAt, sourceDigest: typeof body === 'string' && Buffer.byteLength(body, 'utf8') <= FISH_TIMESTAMP_SOURCE.maxBytes ? hash(body) : '',
    status: states.includes('changed') ? 'changed' : states.includes('insufficient') ? 'insufficient' : 'scoped-match',
    modelIds: Object.freeze(modelIds), facets: Object.freeze(facets), readiness: 'candidate', proofGaps: gaps,
    outsideCatalogQualification, responsePresence: Object.freeze(responsePresence) })
}

export type FishSourceReadResult = { kind: 'observed'; observation: FishTimestampSourceObservation } | {
  kind: 'unavailable'; sourceId: typeof FISH_TIMESTAMP_SOURCE.id; checkedAt: string
  reason: 'network' | 'http' | 'incomplete' | 'mime' | 'oversized' | 'malformed-response' | 'invalid-utf8'
  httpStatus?: number
}

/** Required injected port; no global fetch/default caller, secrets, publication or persistence. */
export async function readFishTimestampSource(http: typeof fetch, now: () => number = Date.now): Promise<FishSourceReadResult> {
  const result = await readVoiceSourceBody('fishTimestamp', http, now)
  if (result.kind === 'body') return { kind: 'observed', observation: inspectFishTimestampOpenApi(result.body, result.checkedAt) }
  return { kind: 'unavailable', sourceId: FISH_TIMESTAMP_SOURCE.id, checkedAt: result.checkedAt,
    reason: result.reason === 'unknown-source' ? 'malformed-response' : result.reason,
    ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}) }
}
