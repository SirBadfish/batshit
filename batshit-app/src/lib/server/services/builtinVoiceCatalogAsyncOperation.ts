/** Decode only the fixed Apidog data graph. Neither script nor source-selected URL executes. */
export function inspectAsyncRecordedOperation(body: string): 'matches' | 'changed' | 'insufficient' {
  try {
    if (Buffer.byteLength(body, 'utf8') > 1024 * 1024 || !body.isWellFormed() || body.includes('\0')) return 'insufficient'
    const matches = [...body.matchAll(/window\.__remixContext\.streamController\.enqueue\(("(?:\\.|[^"\\])*")\)/g)]
    if (matches.length !== 1) return 'insufficient'
    const graph: unknown = JSON.parse(JSON.parse(matches[0][1]))
    if (!Array.isArray(graph) || graph.length > 10000) return 'insufficient'
    const raw = (index: unknown): unknown => typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < graph.length ? graph[index] : undefined
    const obj = (index: unknown): Record<string, unknown> | undefined => {
      const node = raw(index)
      if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined
      const result: Record<string, unknown> = Object.create(null)
      for (const [key, value] of Object.entries(node)) {
        if (!/^_\d+$/.test(key) || typeof raw(Number(key.slice(1))) !== 'string') return undefined
        const name = raw(Number(key.slice(1))) as string
        if (Object.hasOwn(result, name)) return undefined
        result[name] = value
      }
      return result
    }
    const arr = (index: unknown): unknown[] | undefined => { const node = raw(index); return Array.isArray(node) ? node : undefined }
    const field = (o: Record<string, unknown> | undefined, key: string) => raw(o?.[key])
    const operations = graph.map((_, i) => obj(i)).filter(o => field(o, 'id') === 39464639 && field(o, 'type') === 'http' && o?.requestBody !== undefined && o?.parameters !== undefined && o?.responses !== undefined)
    if (operations.length !== 1) return 'insufficient'
    const op = operations[0]!
    const only = (o: Record<string, unknown>, allowed: readonly string[]) => Object.keys(o).every(key => allowed.includes(key))
    if (!only(op, ['id','name','serverId','preProcessors','postProcessors','inheritPreProcessors','inheritPostProcessors','description','operationId','sourceUrl','method','path','tags','status','auth','projectId','moduleId','folderId','ordering','responsibleId','commonResponseStatus','advancedSettings','customApiFields','oasExtensions','mockScript','createdAt','updatedAt','creatorId','editorId','creatorUserId','editorUserId','visibility','securityScheme','callbacks','type','responses','responseExamples','parameters','commonParameters','requestBody','codeSamples','codeSampleLanguages'])) return 'insufficient'
    if (field(op, 'oasExtensions') !== '' || field(op, 'callbacks') !== '') return 'insufficient'
    if (field(op, 'method') !== 'post' || field(op, 'path') !== 'https://api.async.com/speech_to_text') return 'changed'
    const params = obj(op.parameters), req = obj(op.requestBody)
    if (!params || !req) return 'insufficient'
    if (!only(params, ['query','path','cookie','header']) || !only(req, ['type','parameters','jsonSchema','required','mediaType','examples','oasExtensions','data','contentVariants'])) return 'insufficient'
    const auth = obj(op.auth), security = obj(op.securityScheme), pre = arr(op.preProcessors), post = arr(op.postProcessors)
    const common = obj(op.commonParameters)
    if (!auth || !security || !pre || !post || !common) return 'insufficient'
    const inherited = ['query', 'body', 'header', 'cookie'].map(key => arr(common[key]))
    if (inherited.some(value => !value)) return 'insufficient'
    if (Object.keys(auth).length || Object.keys(security).length || pre.length || post.length || inherited.some(value => value!.length)) return 'changed'
    const headers = arr(params.header), query = arr(params.query), path = arr(params.path), cookie = arr(params.cookie)
    const items = arr(req.parameters), responses = arr(op.responses)
    if (!headers || !query || !path || !cookie || !items || !responses) return 'insufficient'
    const otherInputs = [...query, ...path, ...cookie].map(obj)
    if (otherInputs.some(value => !value)) return 'insufficient'
    if (otherInputs.some(value => field(value, 'required') === true)) return 'changed'
    if (otherInputs.length) return 'insufficient'
    if (field(req, 'type') !== 'multipart/form-data') return 'changed'
    if (field(req, 'required') !== true && field(req, 'required') !== false) return 'insufficient'
    const h = headers.map(obj), p = items.map(obj)
    if (h.some(v => !v) || p.some(v => !v)) return 'insufficient'
    const parameterKeys = ['required','description','type','id','example','enable','name','schema','isCommonParameter','value']
    if ([...h, ...p].some(v => !only(v!, parameterKeys))) return 'insufficient'
    const byName = (values: (Record<string, unknown> | undefined)[]) => new Map(values.map(v => [field(v, 'name'), v]))
    const headerMap = byName(h), paramMap = byName(p)
    if (headerMap.size !== h.length || paramMap.size !== p.length) return 'insufficient'
    for (const [name, type] of [['x-api-key','string'], ['version','string']] as const) {
      const value = headerMap.get(name)
      if (!value || field(value, 'enable') !== true) return 'insufficient'
      if (field(value, 'type') !== type) return 'changed'
      if (typeof field(value, 'required') !== 'boolean') return 'insufficient'
    }
    for (const value of h) if (!['x-api-key','version'].includes(String(field(value, 'name')))) return field(value, 'required') === true ? 'changed' : 'insufficient'
    if (field(headerMap.get('version'), 'value') !== 'v1') return 'insufficient'
    for (const [name, type] of [['file','file'], ['model_id','string'], ['language','string']] as const) {
      const value = paramMap.get(name)
      if (!value || field(value, 'enable') !== true) return 'insufficient'
      if (field(value, 'type') !== type) return 'changed'
      if (typeof field(value, 'required') !== 'boolean') return 'insufficient'
    }
    if (field(paramMap.get('language'), 'required') === true) return 'changed'
    for (const value of p) if (!['file','model_id','language'].includes(String(field(value, 'name')))) return field(value, 'required') === true ? 'changed' : 'insufficient'
    const schemas = ['file','model_id','language'].map(name => obj(paramMap.get(name)!.schema))
    if (schemas.some(v => !v)) return 'insufficient'
    const baseSchema = obj(req.jsonSchema), variants = arr(req.contentVariants)
    if (!baseSchema || !variants || variants.length !== 1) return 'insufficient'
    const baseProps = obj(baseSchema.properties), variant = obj(variants[0])
    if (!baseProps || !variant) return 'insufficient'
    if (!only(baseSchema, ['type','properties','x-apidog-orders']) || !only(variant, ['key','type','mediaType','jsonSchema','parameters','examples','description','data','required'])) return 'insufficient'
    if (field(req, 'oasExtensions') !== '' || field(req, 'data') !== '' || field(req, 'mediaType') !== '' || field(variant, 'data') !== '' || variant.jsonSchema !== req.jsonSchema) return 'insufficient'
    if (field(variant, 'mediaType') !== 'multipart/form-data') return 'changed'
    if (field(variant, 'required') !== true && field(variant, 'required') !== false) return 'insufficient'
    if (field(baseSchema, 'type') !== 'object' || Object.keys(baseProps).length || field(variant, 'type') !== 'multipart/form-data' || variant.parameters !== req.parameters) return 'changed'
    const semanticKeys = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).every(key => allowed.includes(key))
    if (!semanticKeys(schemas[0]!, ['type', 'format']) || !semanticKeys(schemas[1]!, ['type', 'default']) || !semanticKeys(schemas[2]!, ['type', 'enum', 'x-apidog-enum'])) return 'insufficient'
    const languages = arr(schemas[2]!.enum)?.map(raw)
    if (field(schemas[0], 'type') !== 'string' || field(schemas[0], 'format') !== 'binary' || field(schemas[1], 'type') !== 'string' || field(schemas[2], 'type') !== 'string' || !languages) return 'changed'
    if (['en','fr','es','de','it','pt','ar','ru','ro','ja','he','hy','tr','hi','zh'].some(code => !languages.includes(code))) return 'changed'
    const ok = responses.map(obj).filter(value => field(value, 'code') === 200)
    if (ok.length !== 1) return 'insufficient'
    if (!only(ok[0]!, ['id','name','code','contentType','jsonSchema','itemSchema','description','mediaType','headers','key','responseExamples'])) return 'insufficient'
    const responseHeaders = arr(ok[0]!.headers), itemSchema = obj(ok[0]!.itemSchema)
    if (!responseHeaders || !itemSchema || responseHeaders.length || Object.keys(itemSchema).length || field(ok[0], 'mediaType') !== '') return 'insufficient'
    const schema = obj(ok[0]!.jsonSchema), properties = schema && obj(schema.properties), textSchema = properties && obj(properties.text), required = schema && arr(schema.required)?.map(raw)
    if (!schema || !properties || !required) return 'insufficient'
    if (!Object.hasOwn(properties, 'text')) return 'changed'
    if (!textSchema) return 'insufficient'
    if (field(ok[0], 'contentType') !== 'json' || field(schema, 'type') !== 'object' || !required.includes('text') || field(textSchema, 'type') !== 'string') return 'changed'
    if (Object.keys(properties).length !== 1 || required.length !== 1) return 'insufficient'
    if (!semanticKeys(schema, ['type', 'properties', 'required', 'x-apidog-orders']) || !semanticKeys(textSchema, ['type', 'description'])) return 'insufficient'
    return 'matches'
  } catch { return 'insufficient' }
}
