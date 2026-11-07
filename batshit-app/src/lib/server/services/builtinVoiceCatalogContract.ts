import { createHash } from 'node:crypto'

type Row = Record<string, unknown>
type Subject = 'mistral-speech' | 'mistral-recorded' | 'minimax-speech' | 'cartesia-36'
class ContractError extends Error { constructor(readonly state: 'insufficient' | 'changed') { super(state) } }
function refuse(state: 'insufficient' | 'changed' = 'insufficient'): never { throw new ContractError(state) }
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : refuse()
const at = (value: unknown, ...keys: string[]) => { for (const key of keys) value = row(value)[key]; return value }
const inertSchemaAnnotations = new Set(['title','example','examples'])
const contracts = {
  'mistral-speech': { path: '/v1/audio/speech', server: 'https://api.mistral.ai', mime: 'application/json',
    request: ['input','model','voice_id','response_format','stream'], guaranteed: ['input','model','voice_id','response_format','stream'], output: ['audio_data'] },
  'mistral-recorded': { path: '/v1/audio/transcriptions', server: 'https://api.mistral.ai', mime: 'multipart/form-data',
    request: ['model','file','language','timestamp_granularities'], guaranteed: ['model','file'], output: ['text','transcript','language','language_code','segments','words'] },
  'minimax-speech': { path: '/v1/t2a_v2', server: 'https://api.minimax.io', mime: 'application/json',
    request: ['model','text','stream','voice_setting','audio_setting','output_format','language_boost'], guaranteed: ['model','text','stream','voice_setting','audio_setting','output_format'], output: ['data','extra_info','base_resp'] },
  'cartesia-36': { path: '/tts/bytes', server: 'https://api.cartesia.ai', mime: 'application/json',
    request: ['model_id','transcript','voice','output_format','generation_config','language'], guaranteed: ['model_id','transcript','voice','output_format'], output: [] }
} as const

/** Reviewed code-consumed semantic projections, not whole-page content hashes or caller claims. */
const accepted: Record<Subject, string> = {
  'mistral-speech': '44f948a808ea28b78dce4b0f8336608ede4e41e8a1296ad11d02e618eb7051f5',
  'mistral-recorded': 'd37691c342c04f83fcd181b25a331d4ab98f8d934b3f8db247fc95bbf659db4d',
  'minimax-speech': '16188bfe0f2f56df72ecb6466ef3e2d9030de282f3c71224f628bc92784c8bb0',
  'cartesia-36': 'a07cc491aded589a852ce9796a4d307440e58b70264584e0a21b23ba52e74f3d'
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,item]) => JSON.stringify(key)+':'+canonical(item)).join(',') + '}'
  return JSON.stringify(value) ?? refuse()
}

/** Exact scoped operation/schema lock; unrecognized semantics never grant a profile. */
export function inspectVoiceOperationContract(spec: Row, subject: Subject) {
  let projection: unknown = null
  try {
    const contract = contracts[subject]
    if (!['3.0.0','3.0.1','3.0.2','3.0.3','3.1.0'].includes(String(spec.openapi))) refuse()
    const item = row(at(spec, 'paths', contract.path)), op = row(item.post)
    if (Object.hasOwn(item, '$ref') || Object.hasOwn(op, '$ref')) refuse()
    const servers = op.servers ?? item.servers ?? spec.servers
    if (!Array.isArray(servers) || !servers.length) refuse()
    const targets = servers.map(value => {
      const server = row(value)
      if (server.variables !== undefined || typeof server.url !== 'string') return refuse()
      const url = new URL(server.url)
      if (url.username || url.password || url.search || url.hash) return refuse()
      return url.href.replace(/\/+$/, '') + contract.path
    })
    if (!targets.includes(contract.server + contract.path)) refuse('changed')
    const security = op.security ?? spec.security
    if (!Array.isArray(security)) refuse()
    const schemes = row(at(spec, 'components', 'securitySchemes'))
    const usedSchemes: Row = Object.create(null)
    const bearer = security.some(value => {
      const requirement = row(value)
      for (const key of Object.keys(requirement)) usedSchemes[key] = schemes[key] ?? refuse()
      return Object.keys(requirement).length === 1 && Object.entries(requirement).some(([key, scopes]) => {
        const scheme = row(schemes[key]); return scheme.type === 'http' && scheme.scheme === 'bearer' && Array.isArray(scopes) && scopes.length === 0
      })
    })
    if (!bearer) refuse()
    const parameters = [item.parameters ?? [], op.parameters ?? []]
    const effective = new Map<string, Row>()
    for (const group of parameters) {
      if (!Array.isArray(group) || group.length > 1000) refuse()
      const seen = new Set<string>()
      for (const value of group) {
        let parameter = row(value)
        if (subject === 'cartesia-36' && typeof parameter.$ref === 'string' && /^#\/components\/parameters\/[A-Za-z0-9_]+$/.test(parameter.$ref)) {
          const { $ref, ...siblings } = parameter
          parameter = { ...row(at(spec, 'components', 'parameters', $ref.slice('#/components/parameters/'.length))), ...(Object.keys(siblings).length ? { referenceSiblings: siblings } : {}) }
        }
        if (Object.hasOwn(parameter, '$ref') || typeof parameter.name !== 'string' || !parameter.name || typeof parameter.in !== 'string' ||
          !['header','query','path','cookie'].includes(parameter.in) || parameter.required !== undefined && typeof parameter.required !== 'boolean') refuse()
        const key = JSON.stringify([parameter.in, parameter.in === 'header' ? parameter.name.toLowerCase() : parameter.name])
        if (seen.has(key)) refuse()
        seen.add(key); effective.set(key, parameter) // Operation overrides its exact path-level parameter.
      }
    }
    const guaranteedHeaders = subject === 'mistral-recorded' ? ['authorization','content-type'] : subject === 'cartesia-36' ? ['authorization','content-type','cartesia-version'] : ['authorization','content-type','accept']
    for (const parameter of effective.values()) if (parameter.required === true && !(parameter.in === 'header' && guaranteedHeaders.includes(String(parameter.name).toLowerCase()))) refuse('changed')
    let nodes = 0
    const bound = (depth: number) => { if (++nodes > 25_000 || depth > 48) refuse() }
    const data = (value: unknown, depth = 0): unknown => {
      bound(depth)
      if (Array.isArray(value)) return value.map(item => data(item, depth + 1))
      if (!value || typeof value !== 'object') return value
      return Object.fromEntries(Object.entries(row(value)).map(([key,item]) => [key, data(item, depth + 1)]))
    }
    const schemaMaps = new Set(['properties','patternProperties','dependentSchemas','$defs','definitions'])
    const schemaLists = new Set(['allOf','anyOf','oneOf','prefixItems'])
    const schemaChildren = new Set(['items','additionalProperties','unevaluatedProperties','contains','not','propertyNames','if','then','else','unevaluatedItems','additionalItems'])
    const resolve = (value: unknown, stack: readonly string[] = [], depth = 0): unknown => {
      bound(depth)
      if (Array.isArray(value)) return value.map(item => resolve(item, stack, depth + 1))
      if (!value || typeof value !== 'object') return value
      const schema = row(value), result: Row = Object.create(null)
      if (Object.hasOwn(schema, 'resolvedLocalRef') || Object.hasOwn(schema, 'referenceSiblings')) return refuse()
      if (schema.$ref !== undefined) {
        if (typeof schema.$ref !== 'string' || !/^#\/components\/schemas\/[A-Za-z0-9_]+$/.test(schema.$ref) || stack.includes(schema.$ref)) return refuse()
        let target = at(spec, 'components', 'schemas', schema.$ref.slice('#/components/schemas/'.length))
        if (subject === 'cartesia-36' && schema.$ref === '#/components/schemas/TTSModelID') {
          const { enum: _discovery, ...modelContract } = row(target)
          target = modelContract
        }
        result.resolvedLocalRef = resolve(target, [...stack, schema.$ref], depth + 1)
      }
      for (const [key,item] of Object.entries(schema)) {
        if (key === '$ref' || inertSchemaAnnotations.has(key)) continue
        if (schemaMaps.has(key)) result[key] = Object.fromEntries(Object.entries(row(item)).map(([name, child]) => [name, resolve(child, stack, depth + 1)]))
        else if (schemaLists.has(key) || schemaChildren.has(key)) result[key] = resolve(item, stack, depth + 1)
        else result[key] = data(item, depth + 1) // const/default/enum and unknown constraints are literal data, preserving all keys.
      }
      return result
    }
    const dereference = (value: unknown): Row => {
      const schema = row(value)
      if (schema.$ref === undefined) return schema
      if (typeof schema.$ref !== 'string' || !/^#\/components\/schemas\/[A-Za-z0-9_]+$/.test(schema.$ref)) return refuse()
      const { $ref: _ref, ...siblings } = schema
      // Ref siblings remain in the lock, never silently ignored.
      return { ...row(at(spec, 'components','schemas', schema.$ref.slice('#/components/schemas/'.length))), ...(Object.keys(siblings).length ? { referenceSiblings: siblings } : {}) }
    }
    const select = (value: unknown, fields: readonly string[], input: boolean) => {
      const schema = dereference(value), props = row(schema.properties)
      if (schema.type !== 'object') refuse()
      if (input && schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string' || !(contract.guaranteed as readonly string[]).includes(key)))) refuse('changed')
      const { properties: _properties, ...envelope } = schema
      const selected: Row = {}
      for (const key of fields) if (Object.hasOwn(props, key)) {
        if (input && key === 'model') { const { enum: _modelDiscovery, ...model } = row(props[key]); selected[key] = resolve(model) }
        else selected[key] = resolve(props[key])
      }
      return { schemaEnvelope: resolve(envelope), properties: selected }
    }
    const requestBody = row(op.requestBody), requestContent = row(requestBody.content)
    if (!Object.hasOwn(requestContent, contract.mime)) refuse('changed')
    const requestMedia = row(requestContent[contract.mime]), { schema: _requestSchema, example: _requestExample, examples: _requestExamples, ...requestMediaEnvelope } = requestMedia
    const request = select(requestMedia.schema, contract.request, true)
    const response = row(at(op, 'responses','200')), responseContent = row(response.content)
    const responseMime = subject === 'cartesia-36' ? 'audio/*' : 'application/json'
    if (!Object.hasOwn(responseContent, responseMime)) refuse('changed')
    const responseMedia = row(responseContent[responseMime]), { schema: _responseSchema, example: _responseExample, examples: _responseExamples, ...responseMediaEnvelope } = responseMedia
    const output = subject === 'cartesia-36' ? { schema: resolve(responseMedia.schema) } : select(responseMedia.schema, contract.output, false)
    const { requestBody: _request, responses: _responses, operationId: _operationId, summary: _summary, tags: _opTags, externalDocs: _opDocs, ...operation } = op
    const { content: _requestContent, ...requestEnvelope } = requestBody
    const { content: _responseContent, ...responseEnvelope } = response
    const { paths: _paths, components: _components, info: _info, tags: _tags, externalDocs: _external, ...rootEnvelope } = spec
    const pathEnvelope = Object.fromEntries(Object.entries(item).filter(([key]) => !['get','put','post','delete','options','head','patch','trace'].includes(key)))
    projection = { root: data(rootEnvelope), pathEnvelope: data(pathEnvelope), openapi: spec.openapi, subject, path: contract.path, servers: data(servers), security: data(security), schemes: data(usedSchemes), parameters: data(parameters),
      ...(subject === 'cartesia-36' ? { effectiveParameters: data([...effective.values()]) } : {}),
      operation: data(operation), request: { bodyEnvelope: data(requestEnvelope), media: data(requestMediaEnvelope), mime: contract.mime, ...request }, response: { responseEnvelope: data(responseEnvelope), media: data(responseMediaEnvelope), mime: responseMime, ...output } }
    const fingerprint = createHash('sha256').update(canonical(projection)).digest('hex')
    return { state: fingerprint === accepted[subject] ? 'matches' as const : 'insufficient' as const, fingerprint, projection }
  } catch (error) {
    return { state: error instanceof ContractError ? error.state : 'insufficient' as const, fingerprint: null, projection }
  }
}
