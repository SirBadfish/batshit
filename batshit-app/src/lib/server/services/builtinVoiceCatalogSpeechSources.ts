import { lexer, type Tokens } from 'marked'
import { load } from 'cheerio'
import { createHash } from 'node:crypto'
import { inspectCartesiaVoiceDocument, parseVoiceYaml, voiceSourceSection, voiceSourceTable, voiceSourceCodeId, voiceSourceHtmlProjection } from './builtinVoiceCatalogDocuments'
import { inspectVoiceOperationContract } from './builtinVoiceCatalogContract'

const bounded = (body: string) => typeof body === 'string' && body.isWellFormed() && !body.includes('\0') && Buffer.byteLength(body, 'utf8') <= 2 * 1024 * 1024
const record = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('source-incomplete')
  return value as Record<string, any>
}
const containsAll = (value: string, facts: readonly string[]) => facts.every(fact => value.includes(fact))
const requiredFields = (section: string) => [...section.matchAll(/^[-*] `([^`]+)`[ \t]*(?:\([^\n)]*\brequired\b[^)]*\)|`[^`]+`[ \t]*\*\*\*required\*\*\*)/gmu)].map(match => match[1])
function declaredType(section: string, field: string): string | null {
  const lines = section.split('\n').filter(line => new RegExp(`^[-*] \`${field}\`[ \\t]`).test(line))
  if (lines.length !== 1) return null
  return lines[0].match(/^[-*] `[^`]+`[ \t]*\(([^,;)]+)/)?.[1]?.trim() ?? lines[0].match(/^[-*] `[^`]+`[ \t]*`([^`]+)`/)?.[1] ?? null
}
const incompatibleType = (section: string, field: string, allowed: string[]) => {
  const type = declaredType(section, field)
  return type !== null && !allowed.includes(type)
}
const digest = (value: string) => createHash('sha256').update(value.split(/\r?\n/u).map(line => {
  const indent = line.match(/^[ \t]*/u)?.[0] ?? ''
  return `${JSON.stringify(indent)}:${line.trim().replace(/\s+/gu, ' ')}`
}).join('\n')).digest('hex')
const acceptedScopes = {
  inworldRequest: 'f51343d5076ea5e84cc3e1cdfb78ff06cd9b19a8b6f7109501d316c9cb0ee906',
  inworldApi: '3ee3b05082098f5229a9524ec578b46b263fbd75171010da36d26d24eee79ec8',
  inworldSteering: '3a3ea1f4b248f34dabd2e824b31fd86ce74e20e01c23bb03a44f909e3aad6339',
  stepEndpoint: 'f54557160a9465bd9c55b368d978d0a269617fb4a9846b8e3aae26e0ef3f90ae',
  stepRequest: 'dc5cb715111890422f529641774df53fa591686c79b19606056133f870b3c367',
  stepResponse: '681624cd68158ebbb6d895f20541da95eb24805fd9b0b7ede0fd53c51359456a',
  stepSetup: 'd8715011643e11aa6ea6355a5c78057497b603e167bf41fde59fc65570fca3eb',
  stepExample: 'a1de21587ec7ac7fd129126b88ed7aa8aabef39a3ede628f61e629a2513c9472',
  elevenRequest: '4a1bd08f78c3c00e9ea47d704a945e6434270e82cc07c2ecda3f95056f8f80bb',
  elevenResponse: '00194e2290ba81bdd7b7ba116a49c63a807fab1bea25cfeba299ecf0f53fb1e0',
  elevenSettings: '79a3145197ece9c6252765ab1c2a7ae68df5ec1bdabee0bf6e8328a07a077ad8',
  elevenV4: '4b4611a348390ab646cf9d4da61c9850569a77a84a32bd2296ff5de7f30ad5fb'
} as const
function stepCookbookScopes(body: string) {
  const $ = load(body), root = $('main article')
  if (root.length !== 1) throw new Error('source-incomplete')
  root.find('script,style,nav,header,footer,aside,template').remove()
  const section = (id: string) => {
    const heading = root.find(`h3[id="${id}"]`)
    if (heading.length !== 1) throw new Error('source-incomplete')
    return voiceSourceHtmlProjection(heading.nextUntil('h1,h2,h3').toArray())
  }
  return { setup: section('cookbook-2-5-initialize-the-connection-and-credentials') + section('cookbook-2-6-set-the-http-timeout-and-read-responses'),
    example: section('cookbook-3-1-prepare-the-text-and-request') }
}
function elevenV4Scope(body: string) {
  const faq = voiceSourceSection(body, 'FAQ')
  const $ = load(`<table>${faq}</table>`), candidates = $('td').filter((_, node) => $(node).text().includes('#### What is Eleven v4?'))
  if (candidates.length !== 1) throw new Error('source-incomplete')
  candidates.find('script,style,nav,header,footer,aside,template').remove()
  return voiceSourceHtmlProjection(candidates.toArray())
}
/** Reviewable scoped projections. A changed hash is insufficient, not proof of incompatibility. */
export function speechSourceScopeTexts(input: { inworldSpeech?: string; inworldSteering?: string; stepApi?: string; stepCookbook?: string; elevenApi?: string; elevenGuide?: string }) {
  const result: Record<string, string> = {}
  if (input.inworldSpeech !== undefined) {
    result.inworldRequest = voiceSourceSection(input.inworldSpeech, 'Request and response')
    result.inworldApi = voiceSourceSection(input.inworldSpeech, 'API reference')
  }
  if (input.inworldSteering !== undefined) {
    const index = input.inworldSteering.indexOf('## How instructions work')
    if (index < 0) throw new Error('source-incomplete')
    result.inworldSteering = input.inworldSteering.slice(0, index)
  }
  if (input.stepApi !== undefined) {
    result.stepEndpoint = voiceSourceSection(input.stepApi, 'Endpoint')
    result.stepRequest = voiceSourceSection(input.stepApi, 'Request body')
    result.stepResponse = voiceSourceSection(input.stepApi, 'Response')
  }
  if (input.stepCookbook !== undefined) {
    const scope = stepCookbookScopes(input.stepCookbook)
    result.stepSetup = scope.setup; result.stepExample = scope.example
  }
  if (input.elevenApi !== undefined) {
    result.elevenRequest = voiceSourceSection(input.elevenApi, 'Request')
    result.elevenResponse = voiceSourceSection(input.elevenApi, 'Response')
    result.elevenSettings = voiceSourceSection(input.elevenApi, 'VoiceSettingsResponseModel')
  }
  if (input.elevenGuide !== undefined) result.elevenV4 = elevenV4Scope(input.elevenGuide)
  return result
}
export function speechSourceScopeFingerprints(input: Parameters<typeof speechSourceScopeTexts>[0]) {
  return Object.fromEntries(Object.entries(speechSourceScopeTexts(input)).map(([key, value]) => [key, digest(value)]))
}
const scopesMatch = (actual: Record<string, string>) => Object.entries(actual).every(([key, value]) => acceptedScopes[key as keyof typeof acceptedScopes] === value)

/** Verify the actual consumed YAML operation and supported-format schemas. */
export function inspectCartesia36Source(modelsBody: string, apiBody: string): string[] {
  try {
    if (!bounded(modelsBody) || !bounded(apiBody)) return []
    const blocks = lexer(apiBody).filter((token): token is Tokens.Code => token.type === 'code' && token.lang === 'yaml latest.yml POST /tts/bytes')
    if (blocks.length !== 1) return []
    const spec = parseVoiceYaml(blocks[0].text)
    if (inspectVoiceOperationContract(spec, 'cartesia-36').state !== 'matches') return []
    const op = record(record(record(spec.paths)['/tts/bytes']).post)
    const components = record(spec.components), params = record(components.parameters), schemas = record(components.schemas)
    const header = record(params.CartesiaVersionHeader), headerSchema = record(header.schema)
    const request = record(schemas.TTSRequest), props = record(request.properties)
    const required = request.required as unknown, response = record(record(record(op.responses)['200']).content)
    const formats = record(schemas.OutputFormat), config = record(record(schemas.GenerationConfig).properties)
    const raw = record(schemas.RawOutputFormat), mp3 = record(schemas.MP3OutputFormat), wav = record(schemas.WAVOutputFormat)
    const suppliedOnly = (required: unknown, supplied: string[]) => Array.isArray(required) && required.every(value => typeof value === 'string' && supplied.includes(value))
    const supportedFormat = (title: string, container: string) => {
      if (!Array.isArray(formats.oneOf)) return false
      const choices = formats.oneOf.filter((item: any) => item.title === title)
      if (choices.length !== 1) return false
      const choice = record(choices[0])
      return suppliedOnly(choice.required, ['container']) && Array.isArray(choice.allOf) && choice.allOf.some((part: any) => part?.properties?.container?.enum?.includes(container)) && choice.allOf.some((part: any) => part?.$ref === `#/components/schemas/${title === 'RAWOutputFormat' ? 'RawOutputFormat' : title}`)
    }
    const schemaRef = (value: unknown, name: string) => record(value).$ref === `#/components/schemas/${name}`
    const security = record(components.securitySchemes)
    if (!Array.isArray(spec.servers) || !spec.servers.some((server: any) => server.url === 'https://api.cartesia.ai') ||
      header.name !== 'Cartesia-Version' || header.in !== 'header' || header.required !== true ||
      !Array.isArray(headerSchema.enum) || !headerSchema.enum.includes('2026-08-14') ||
      !Array.isArray(op.parameters) || op.parameters.length !== 1 || !op.parameters.some((p: any) => p.$ref === '#/components/parameters/CartesiaVersionHeader') ||
      !Array.isArray(op.security) || !op.security.some((item: any) => Array.isArray(item.APIKeyAuth) && !item.APIKeyAuth.length) ||
      record(security.APIKeyAuth).type !== 'http' || record(security.APIKeyAuth).scheme !== 'bearer' ||
      record(op.requestBody).required !== true || !schemaRef(record(record(op.requestBody).content)['application/json'].schema, 'TTSRequest') ||
      !Array.isArray(required) || required.length !== 4 || !['model_id', 'transcript', 'voice', 'output_format'].every(key => required.includes(key)) ||
      !schemaRef(props.model_id, 'TTSModelID') || record(props.transcript).type !== 'string' || !schemaRef(props.voice, 'TTSRequestVoiceSpecifier') ||
      !schemaRef(props.output_format, 'OutputFormat') || !schemaRef(props.generation_config, 'GenerationConfig') || record(props.language).type !== 'string' ||
      !record(schemas.TTSModelID).enum?.includes('sonic-3.6') || !record(schemas.TTSRequestVoiceSpecifier).oneOf?.some((item: any) => item.type === 'string') ||
      !supportedFormat('WAVOutputFormat', 'wav') || !supportedFormat('MP3OutputFormat', 'mp3') || !supportedFormat('RAWOutputFormat', 'raw') ||
      !suppliedOnly(mp3.required, ['sample_rate','bit_rate']) || !mp3.required.includes('sample_rate') || !mp3.required.includes('bit_rate') ||
      !suppliedOnly(raw.required, ['sample_rate','encoding']) || !raw.required.includes('sample_rate') || !raw.required.includes('encoding') ||
      wav.required !== undefined && !suppliedOnly(wav.required, ['sample_rate','encoding']) ||
      !record(schemas.RawEncoding).enum?.includes('pcm_s16le') || !record(record(schemas.MP3OutputFormat).properties).sample_rate?.enum?.includes(44100) ||
      !record(record(schemas.MP3OutputFormat).properties).bit_rate?.enum?.includes(128000) || !record(record(schemas.RawOutputFormat).properties).sample_rate?.enum?.includes(44100) ||
      !containsAll(String(config.speed?.description), ['[0.6, 1.5]']) || !containsAll(String(config.volume?.description), ['[0.5, 2.0]']) ||
      record(record(response['audio/*']).schema).format !== 'binary') return []
    const documented = inspectCartesiaVoiceDocument(modelsBody)
    return ['sonic-3.6', 'sonic-3.6-2026-08-27'].filter(id => documented.some(row => row.modelId === id && row.documentedCompatibility && !row.preview))
  } catch { return [] }
}

/** Exact model and batch request facets; missing or changed docs cannot issue a rule. */
export function inspectInworldFlashSource(modelsBody: string, speechBody: string, steeringBody: string): boolean {
  try {
    if (![modelsBody, speechBody, steeringBody].every(bounded)) return false
    if (!scopesMatch(speechSourceScopeFingerprints({ inworldSpeech: speechBody, inworldSteering: steeringBody }))) return false
    if (!voiceSourceTable(modelsBody, ['Name','Model ID','Description','Supported languages']).some(row => voiceSourceCodeId(row[1]) === 'inworld-tts-2-flash')) return false
    const req = voiceSourceSection(speechBody, 'Request and response'), api = voiceSourceSection(speechBody, 'API reference')
    return containsAll(req, ['POST https://api.inworld.ai/tts/v1/voice', 'Authorization: Basic', 'Content-Type: application/json', '2,000 UTF-16 code units', '`audioContent`', 'Base64-encoded audio']) &&
      requiredFields(api).every(field => ['Authorization','text','modelId'].includes(field)) &&
      containsAll(api, ['`voiceId`', '`modelId`', '`audioEncoding`', '`sampleRateHertz`', '`LINEAR16`', '`MP3`', '`OGG_OPUS`', '`language`', '`timestampType`', '`applyTextNormalization`', 'Only supported by `inworld-tts-2`. The field is ignored on other models.']) &&
      containsAll(steeringBody.slice(0, steeringBody.indexOf('## How instructions work')), ['`inworld-tts-2-flash`', 'steering is not supported', 'instruction tags are ignored', 'non-verbal'])
  } catch { return false }
}

/** The explicitly documented preset is the only newly advertised system voice. */
export function inspectStep3Source(apiBody: string, cookbookBody: string): boolean {
  try {
    if (![apiBody, cookbookBody].every(bounded)) return false
    if (!scopesMatch(speechSourceScopeFingerprints({ stepApi: apiBody, stepCookbook: cookbookBody }))) return false
    const endpoint = voiceSourceSection(apiBody, 'Endpoint'), request = voiceSourceSection(apiBody, 'Request body'), response = voiceSourceSection(apiBody, 'Response')
    const $ = load(cookbookBody), root = $('main article')
    if (root.length !== 1) return false
    root.find('script,style,nav,header,footer,aside,template').remove()
    const text = root.text().replace(/\s+/g, ' ')
    return containsAll(endpoint, ['POST https://api.stepfun.ai/v1/audio/speech']) &&
      requiredFields(request).every(field => ['model','input','voice'].includes(field)) &&
      containsAll(request, ['`stepaudio-3-tts`', '`input`', '1,000 characters', '`voice`', '`response_format`', '`wav`, `mp3`, `flac`, `opus`, `pcm`', '`speed`', '0.5 to 2.0', '`volume`', '0.1 to 2.0', '`instruction`', '500 characters', '`sample_rate`', '`8000`, `16000`, `22050`, `24000`, `48000`']) &&
      response.includes('audio file (a binary stream)') && containsAll(text, ['stepaudio-3-tts', 'zixinnansheng', '/audio/speech', 'Authorization', 'Bearer', 'application/json'])
  } catch { return false }
}

export function inspectElevenV4Source(modelsBody: string, guideBody: string, apiBody: string): boolean {
  try {
    if (![modelsBody, guideBody, apiBody].every(bounded)) return false
    if (!scopesMatch(speechSourceScopeFingerprints({ elevenApi: apiBody, elevenGuide: guideBody }))) return false
    const rows = voiceSourceTable(modelsBody, ['Model ID','Description','Languages'])
    const hasModel = rows.some(row => voiceSourceCodeId(row[0]) === 'eleven_v4' && /speech synthesis/i.test(row[1]))
    const request = voiceSourceSection(apiBody, 'Request'), response = voiceSourceSection(apiBody, 'Response'), examples = voiceSourceSection(apiBody, 'Examples')
    return hasModel && containsAll(guideBody, ['Both variants use two voice settings: Stability and Similarity.', 'Style and Speed sliders are not available in Eleven v4', 'using model ID `eleven_v4`']) &&
      containsAll(apiBody.slice(0, apiBody.indexOf('## Servers')), ['POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}', 'Content-Type: application/json']) &&
      requiredFields(request).every(field => ['voice_id','text'].includes(field)) &&
      containsAll(request, ['`voice_id`', '`text`', '`model_id`', '`language_code`', '`voice_settings`']) && response.includes('generated audio file') && examples.includes('xi-api-key')
  } catch { return false }
}

/** Only positively parsed contradictions can revoke a previously qualified profile. */
export function cartesia36ContractChanged(apiBody: string): boolean {
  try {
    const blocks = lexer(apiBody).filter((token): token is Tokens.Code => token.type === 'code' && token.lang === 'yaml latest.yml POST /tts/bytes')
    if (blocks.length !== 1) return false
    const spec = parseVoiceYaml(blocks[0].text), components = record(spec.components), params = record(components.parameters), schemas = record(components.schemas)
    if (inspectVoiceOperationContract(spec, 'cartesia-36').state === 'changed') return true
    const versions = record(record(params.CartesiaVersionHeader).schema).enum
    if (Array.isArray(versions) && versions.length && !versions.includes('2026-08-14')) return true
    const servers = spec.servers
    if (Array.isArray(servers) && servers.length && servers.every(item => typeof record(item).url === 'string') && !servers.some(item => record(item).url === 'https://api.cartesia.ai')) return true
    const request = record(schemas.TTSRequest), required = request.required
    if (Array.isArray(required) && required.some(value => typeof value === 'string' && !['model_id','transcript','voice','output_format'].includes(value))) return true
    if (Array.isArray(request.allOf) && request.allOf.some(item => Array.isArray(record(item).required) && record(item).required.some((field: unknown) => typeof field === 'string' && !['model_id','transcript','voice','output_format'].includes(field)))) return true
    const properties = record(request.properties)
    if (typeof properties.transcript?.type === 'string' && properties.transcript.type !== 'string') return true
    if (typeof properties.transcript?.minLength === 'number' && properties.transcript.minLength > 1 ||
      typeof properties.transcript?.maxLength === 'number' && properties.transcript.maxLength < 5000 ||
      Array.isArray(properties.transcript?.enum)) return true
    if (typeof properties.language?.type === 'string' && properties.language.type !== 'string') return true
    const op = record(record(record(spec.paths)['/tts/bytes']).post), responses = record(op.responses)
    const missingRequiredParameter = (param: Record<string, any>) => param.required === true && typeof param.in === 'string' && typeof param.name === 'string' &&
      !(param.in === 'header' && ['authorization','content-type','cartesia-version'].includes(param.name.toLowerCase()))
    if (Array.isArray(op.parameters)) for (const item of op.parameters) {
      const param = record(item)
      if (param.$ref === '#/components/parameters/CartesiaVersionHeader') continue
      if (missingRequiredParameter(param)) return true
      if (typeof param.$ref === 'string' && /^#\/components\/parameters\/[A-Za-z0-9_]+$/.test(param.$ref)) {
        const name = param.$ref.slice('#/components/parameters/'.length)
        if (missingRequiredParameter(record(params[name]))) return true
      }
    }
    const output = record(record(record(responses['200']).content)['audio/*']).schema
    if (output && typeof output.format === 'string' && output.format !== 'binary') return true
    const config = record(record(schemas.GenerationConfig).properties)
    for (const [field, min, max] of [['speed', 0.6, 1.5], ['volume', 0.5, 2]] as const) {
      const description = config[field]?.description
      const range = typeof description === 'string' ? description.match(/\[([\d.]+),\s*([\d.]+)\]/) : null
      if (range && (Number(range[1]) > min || Number(range[2]) < max)) return true
      if (typeof config[field]?.type === 'string' && config[field].type !== 'number') return true
    }
    const auth = record(record(components.securitySchemes).APIKeyAuth)
    if (typeof auth.type === 'string' && typeof auth.scheme === 'string' && (auth.type !== 'http' || auth.scheme !== 'bearer')) return true
    const voice = record(schemas.TTSRequestVoiceSpecifier).oneOf
    if (Array.isArray(voice) && voice.length && voice.every(item => record(item).type !== 'string')) return true
    if (Array.isArray(voice)) {
      const strings = voice.filter(item => record(item).type === 'string')
      if (strings.length && strings.every(item => {
        const schema = record(item)
        return Array.isArray(schema.enum) || typeof schema.minLength === 'number' && schema.minLength > 1 || typeof schema.maxLength === 'number'
      })) return true
    }
    for (const [name, supplied] of [['MP3OutputFormat', ['sample_rate','bit_rate']], ['RawOutputFormat', ['sample_rate','encoding']]] as const) {
      const format = record(schemas[name])
      if (Array.isArray(format.required) && format.required.some((field: unknown) => typeof field === 'string' && !(supplied as readonly string[]).includes(field))) return true
    }
    return false
  } catch { return false }
}

export function step3ContractChanged(apiBody: string): boolean {
  try {
    const endpoint = voiceSourceSection(apiBody, 'Endpoint')
    const match = endpoint.match(/`POST (https:\/\/[^`\s]+)`/g)
    if (match?.length === 1 && !match[0].includes('https://api.stepfun.ai/v1/audio/speech')) return true
    const request = voiceSourceSection(apiBody, 'Request body')
    if (requiredFields(request).some(field => !['model','input','voice'].includes(field))) return true
    for (const [field, types] of Object.entries({ model: ['string'], input: ['string'], voice: ['string'], response_format: ['string'], speed: ['float','number'], volume: ['float','number'], instruction: ['string'], sample_rate: ['integer'] })) {
      if (incompatibleType(request, field, types)) return true
    }
    const format = request.match(/Supported formats:\s*((?:`[^`]+`(?:,\s*|\.))+)/)
    if (format) {
      const values = [...format[1].matchAll(/`([^`]+)`/g)].map(item => item[1])
      if (values.length && ['wav','mp3','flac','opus','pcm'].some(item => !values.includes(item))) return true
    }
    for (const [field, low, high] of [['speed', 0.5, 2], ['volume', 0.1, 2]] as const) {
      const segment = request.match(new RegExp(`\\* \`${field}\`[^\\n]*\\n([\\s\\S]*?)(?=\\n\\* \`|$)`))?.[1]
      const range = segment?.match(/Range:\s*([\d.]+) to ([\d.]+)/)
      if (range && (Number(range[1]) > low || Number(range[2]) < high)) return true
    }
    const instruction = request.match(/(\d+) characters for `stepaudio-3-tts`/)
    if (instruction && Number(instruction[1]) < 500) return true
    const rates = request.match(/sampling rate\. Supports ((?:`\d+`(?:,\s*|\.))+)/i)
    if (rates) {
      const values = [...rates[1].matchAll(/`(\d+)`/g)].map(item => Number(item[1]))
      if (values.length && [8000,16000,22050,24000,48000].some(item => !values.includes(item))) return true
    }
    const response = voiceSourceSection(apiBody, 'Response')
    if (/By default the response body is (?:a |an )?JSON/i.test(response)) return true
    const model = request.match(/Currently supports ([^\n]+)\./)
    if (model && model[1].includes('`stepaudio-') && !model[1].includes('`stepaudio-3-tts`')) return true
    return false
  } catch { return false }
}

export function inworldFlashContractChanged(speechBody: string): boolean {
  try {
    const request = voiceSourceSection(speechBody, 'Request and response')
    const match = request.match(/`POST (https:\/\/[^`\s]+)`/g)
    if (match?.length === 1 && !match[0].includes('https://api.inworld.ai/tts/v1/voice')) return true
    const api = voiceSourceSection(speechBody, 'API reference')
    if (requiredFields(api).some(field => !['Authorization','text','modelId'].includes(field))) return true
    for (const [field, types] of Object.entries({ text: ['string'], voiceId: ['string'], modelId: ['string'], language: ['string'], audioConfig: ['object'], audioContent: ['string'] })) {
      if (incompatibleType(api, field, types)) return true
    }
    const encoding = api.match(/- `audioEncoding` \(enum<string>;[^\n]*options: ([^)]*)\)/)
    if (encoding) {
      const values = [...encoding[1].matchAll(/"([^"]+)"/g)].map(item => item[1])
      if (values.length && ['LINEAR16','MP3','OGG_OPUS'].some(item => !values.includes(item))) return true
    }
    const rate = api.match(/`sampleRateHertz` \(integer\)[^\n]*range \[(\d+),\s*(\d+)\]/)
    if (rate && (Number(rate[1]) > 8000 || Number(rate[2]) < 48000)) return true
    const authorization = api.split('\n').find(line => /^- `Authorization` \(/.test(line))
    if (authorization && /Bearer/i.test(authorization) && !/Basic/i.test(authorization)) return true
    return false
  } catch { return false }
}

export function elevenV4ContractChanged(apiBody: string): boolean {
  try {
    const head = apiBody.slice(0, apiBody.indexOf('## Servers'))
    const match = head.match(/^POST (https:\/\/\S+)$/m)
    if (match && match[1] !== 'https://api.elevenlabs.io/v1/text-to-speech/{voice_id}') return true
    const request = voiceSourceSection(apiBody, 'Request')
    if (requiredFields(request).some(field => !['voice_id','text'].includes(field))) return true
    for (const [field, types] of Object.entries({ voice_id: ['string'], text: ['string'], model_id: ['string'], language_code: ['string'], voice_settings: ['VoiceSettingsResponseModel'] })) {
      if (incompatibleType(request, field, types)) return true
    }
    const settings = voiceSourceSection(apiBody, 'VoiceSettingsResponseModel')
    return incompatibleType(settings, 'stability', ['double','number']) || incompatibleType(settings, 'similarity_boost', ['double','number'])
  } catch { return false }
}
