import { createHash } from 'node:crypto'
import { load, type CheerioAPI } from 'cheerio'
import { QWEN_AUDIO_TTS_MODELS } from '$lib/data/qwenAudioTts'
import { GEMINI_38_TTS_MODELS } from './gemini38Tts'
import { inspectGoogleVoiceInventory } from './builtinVoiceCatalogInventory'
import { voiceSourceHtmlProjection } from './builtinVoiceCatalogDocuments'

type Scope = ReturnType<CheerioAPI>
const normalized = (value: string) => value.replace(/\s+/gu, ' ').trim()
const digest = (value: string) => createHash('sha256').update(normalized(value)).digest('hex')
const refuse = (): never => { throw new Error('source-incomplete') }
function document(body: string, rootSelector: string) {
  if (Buffer.byteLength(body, 'utf8') > 2 * 1024 * 1024 || !body.isWellFormed() || body.includes('\0')) refuse()
  const $ = load(body), root = $(rootSelector).filter((_, node) => $(node).parents(rootSelector).length === 0)
  if (root.length !== 1) refuse()
  root.find('script,style,nav,header,footer,aside,template').remove()
  return { $, root }
}
function section(root: Scope, id: string, level: 2 | 3): Scope {
  const h = root.find(`h${level}[id="${id}"]`)
  if (h.length !== 1) return refuse()
  return h.nextUntil(level === 2 ? 'h1,h2' : 'h1,h2,h3')
}
function match(value: Scope, expected: string): void { if (digest(voiceSourceHtmlProjection(value.toArray())) !== expected) refuse() }
const insufficient = { status: 'insufficient' as const, modelIds: [] as readonly string[] }

/** Exact reviewed HTML scopes, preserving tag and child structure while ignoring styling. */
export function googleQwenScopeProjections(input: { google: string; models: string; api: string; voices: string; ossHttps: string; ossV1: string; ossV4: string }) {
  const output: Record<string, string> = {}
  const project = (key: string, scope: Scope) => { output[key] = voiceSourceHtmlProjection(scope.toArray()) }
  const google = document(input.google, '.devsite-article-body')
  for (const [key, id] of [['GOOGLE_SINGLE','single-speaker'],['GOOGLE_FORMAT','audio-output-formats'],['GOOGLE_VOICES','voices']]) project(key, section(google.root, id, 2))
  const api = document(input.api, '.icms-help-docs-content')
  project('QWEN_ENDPOINT', section(api.root, 'endpoint', 2)); project('QWEN_HEADERS', section(api.root, 'request-headers', 2))
  for (const [key, heading] of [['QWEN_REQUEST','Request body'], ['QWEN_RESPONSE','Response body']]) {
    const h = api.root.find('h2').filter((_, node) => normalized(api.$(node).text()) === heading)
    if (h.length !== 1 || h.parent('td').length !== 1) refuse()
    project(key, h.parent('td'))
  }
  const models = document(input.models, '.icms-help-docs-content')
  project('QWEN_MODELS', section(models.root, 'supported-models', 2))
  const voices = document(input.voices, '.icms-help-docs-content')
  for (const [key, id] of [['QWEN_31_PLUS','qwen-audio-3-1-tts-plus'], ['QWEN_31_FLASH','qwen-audio-3-1-tts-flash'], ['QWEN_30_PLUS','qwen-audio-3-0-tts-plus'], ['QWEN_30_FLASH','qwen-audio-3-0-tts-flash']]) project(key, section(voices.root, id, 3))
  for (const [key, source, level, heading, scope] of [
    ['OSS_HTTPS', input.ossHttps, 'h2', 'How it works', 'parent'], ['OSS_V1', input.ossV1, 'h2', 'Examples', 'siblings'],
    ['OSS_V4', input.ossV4, 'h3', 'Step 1: Create a canonical request', 'parent']
  ]) {
    const doc = document(source, '.icms-help-docs-content'), h = doc.root.find(level).filter((_, node) => normalized(doc.$(node).text()) === heading)
    if (h.length !== 1) refuse()
    project(key, scope === 'parent' ? h.parent() : h.nextUntil('h1,h2'))
  }
  return output
}

function googleContradiction($: CheerioAPI, root: Scope): boolean {
  const formats = section(root, 'audio-output-formats', 2)
  const tables = formats.filter('table').add(formats.find('table')).filter((_, table) => {
    const header = $(table).find('tr').first().find('th,td').toArray().map(cell => normalized($(cell).text()))
    return header.join('|') === 'Format|mime_type value|Description'
  })
  if (tables.length === 1) {
    const rows = tables.find('tr').toArray().slice(1).map(row => $(row).find('td').toArray().map(cell => normalized($(cell).text()).replaceAll('"', '')))
    const wav = rows.filter(row => row.length === 3 && /^WAV\b/u.test(row[0]))
    if (wav.length === 1 && wav[0][1] && wav[0][1] !== 'audio/wav') return true
  }
  const single = section(root, 'single-speaker', 2)
  const rest = single.find('section').filter((_, node) => $(node).children('h3#rest').length === 1).find('pre')
  if (rest.length !== 1) return false
  const code = rest.text(), operation = code.match(/curl\s+-X\s+([A-Z]+)\s+"([^"]+)"/u)
  if (!operation) return false
  if (operation[1] !== 'POST' || operation[2] !== 'https://generativelanguage.googleapis.com/v1beta/interactions') return true
  const body = code.match(/-d\s+'(\{[\s\S]*?\})'\s*\|/u)
  if (!body) return false
  let payload: any
  try { payload = JSON.parse(body[1]) } catch { return false }
  if (payload?.response_format?.type !== undefined && payload.response_format.type !== 'audio') return true
  if (Array.isArray(payload?.input) && payload.input.length === 1 && payload.input[0]?.type !== undefined && payload.input[0].type !== 'user_input') return true
  const content = payload?.input?.[0]?.content
  if (Array.isArray(content) && content.length === 1 && content[0]?.type !== undefined && content[0].type !== 'text') return true
  return false
}

function qwenContradiction($: CheerioAPI, root: Scope): boolean {
  const endpoints = section(root, 'endpoint', 2)
  for (const [region, expected] of [
    ['china-beijing', 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'],
    ['singapore', 'https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer']
  ]) {
    const codes = endpoints.find(`section[id="${region}"] code`)
    if (codes.length !== 1) return false
    const operation = normalized(codes.text()).match(/^([A-Z]+)\s+(https?:\/\/\S+)$/u)
    if (!operation) return false
    if (operation[1] !== 'POST' || operation[2] !== expected) return true
  }
  const headers = section(root, 'request-headers', 2)
  const auth = headers.filter('table').add(headers.find('table')).find('tr').toArray().map(row => $(row).children('td').toArray().map(cell => normalized($(cell).text())))
    .filter(cells => cells.length === 4 && cells[0] === 'Authorization')
  if (auth.length === 1 && (auth[0][1] !== 'string' || /\bBasic\b/u.test(auth[0][3]) && !/\bBearer\b/u.test(auth[0][3]))) return true
  const h = root.find('h2').filter((_, node) => normalized($(node).text()) === 'Request body')
  if (h.length !== 1 || h.parent('td').length !== 1) return false
  const cell = h.parent('td'), inputProperties = cell.children('section[id="accordion-properties"]')
  if (inputProperties.length !== 1 || inputProperties.children('div').length !== 1) return false
  const directFields = cell.children('p').add(inputProperties.children('div').children('p')).toArray()
  const requestFields = directFields.flatMap(node => {
    const name = normalized($(node).children('strong').first().text()), type = normalized($(node).children('code').first().text())
    const required = $(node).children('strong').toArray().some(value => normalized($(value).text()) === '(required)')
    return name && type ? [[name, type, required] as const] : []
  })
  const consumed = [['model', 'string'], ['input', 'object'], ['text', 'string'], ['voice', 'string'],
    ['format', 'string'], ['sample_rate', 'integer'], ['language_hints', 'array[string]'], ['instruction', 'string']]
  if (new Set(requestFields.map(field => field[0])).size !== requestFields.length) return false
  if (consumed.every(([name]) => requestFields.filter(field => field[0] === name).length === 1)
    && (consumed.some(([name, type]) => requestFields.find(field => field[0] === name)?.[1] !== type)
      || requestFields.some(([name, , required]) => required && !['model', 'input', 'text', 'voice', 'format', 'sample_rate'].includes(name)))) return true
  const output = root.find('h2').filter((_, node) => normalized($(node).text()) === 'Response body')
  if (output.length !== 1 || output.parent('td').length !== 1) return false
  const fields = output.parent('td').find('p').toArray().flatMap(node => {
    const name = normalized($(node).children('strong').first().text()), type = normalized($(node).children('code').first().text())
    return name && type ? [[name, type]] : []
  })
  for (const [name, type] of [['output', 'object'], ['audio', 'object'], ['url', 'string'], ['finish_reason', 'string']]) {
    const found = fields.filter(field => field[0] === name)
    if (found.length === 1 && found[0][1] !== type) return true
  }
  return false
}

/** Locks the code-consumed single-speaker, WAV and prebuilt-voice scopes, not the whole document. */
export function inspectGemini38TtsSources(speech: string) {
  try {
    const { $, root } = document(speech, '.devsite-article-body')
    if (googleContradiction($, root)) return { status: 'changed' as const, modelIds: [...GEMINI_38_TTS_MODELS] }
    match(section(root, 'single-speaker', 2), '33d364317027ca8b61ff1a25de36ff7fa39fb2871445d47c8df38a0f3daf825b')
    match(section(root, 'audio-output-formats', 2), 'c80771251029e296c954371e131f7bb87bc2a77ae7ee79aaae9d94013810e002')
    match(section(root, 'voices', 2), 'c6963a5680885ec7d2ced936c11c32f0e87eec77f9aa7f822d594335efcce428')
    const inventory = inspectGoogleVoiceInventory(speech, 'speech')
    const ids = GEMINI_38_TTS_MODELS.filter(id => inventory.some(row => row.modelId === id && row.lane === 'tts-batch'))
    if (ids.length !== GEMINI_38_TTS_MODELS.length) refuse()
    return { status: 'matches' as const, modelIds: ids }
  } catch { return insufficient }
}

/** Exact regional HTTP, body, result and public system-voice scopes; changes refuse new grants. */
export function inspectQwenAudioTtsSources(input: { models: string; api: string; voices: string; ossHttps: string; ossV1: string; ossV4: string }) {
  try {
    const api = document(input.api, '.icms-help-docs-content')
    if (qwenContradiction(api.$, api.root)) return { status: 'changed' as const, modelIds: [...QWEN_AUDIO_TTS_MODELS] }
    match(section(api.root, 'endpoint', 2), '0020bb879e536a506ae7ec1669d0aa88ffc6075d6c3638f767e98f40b117169d')
    match(section(api.root, 'request-headers', 2), '5e52f1a5a363fe8f53d85e97f425e14833c4a1aeb9ff7bbc278e9aeeae46bbc0')
    for (const [heading, hash] of [
      ['Request body', '62768b46ff666142fb9079029a98d95950d6463849c3059d501ed269820c159b'],
      ['Response body', '02a07db44308f443bc54a15b1bd378f89c3a8c131e100af9673f4bae351fe19a']
    ]) {
      const h = api.root.find('h2').filter((_, node) => normalized(api.$(node).text()) === heading), cell = h.parent('td')
      if (h.length !== 1 || cell.length !== 1) refuse()
      match(cell, hash)
    }
    const models = document(input.models, '.icms-help-docs-content')
    const modelScope = section(models.root, 'supported-models', 2)
    match(modelScope, 'c18c360c47233b10108f785b79e74c10119edf8b9fb60ccc1cb8fb616a62f8a9')
    for (const region of ['singapore', 'china-beijing']) {
      const regionScope = modelScope.find(`section[id="${region}"]`)
      if (regionScope.length !== 1) refuse()
      const lists = regionScope.find('li').filter((_, node) => normalized(models.$(node).children('strong').text()) === 'Qwen-Audio-TTS')
      if (lists.length !== 1) refuse()
      const ids = lists.find('code').toArray().map(node => normalized(models.$(node).text()))
      if (ids.length !== QWEN_AUDIO_TTS_MODELS.length || QWEN_AUDIO_TTS_MODELS.some(id => !ids.includes(id))) refuse()
    }
    const voices = document(input.voices, '.icms-help-docs-content')
    for (const [id, hash] of [
      ['qwen-audio-3-1-tts-plus', 'cc5e725d4ee32e036acb8ae3d8c7fcb1d5783fccfdb0fa3951e25c4250b0bde6'],
      ['qwen-audio-3-1-tts-flash', '3f5afe65aa05209bd8f7214cd89adc6bb6a97dc2606fabb77ed41b23d96bac04'],
      ['qwen-audio-3-0-tts-plus', '2cfd54229021d2061447a3332a88aabf1e38c23bd9df87c6ed91f3055129275a'],
      ['qwen-audio-3-0-tts-flash', '06850adbe322a7c9b36c1d960e4ce0c5378cf99daded646e1b99cbb864a707d8']
    ]) match(section(voices.root, id, 3), hash)
    for (const [source, level, heading, scope, hash] of [
      [input.ossHttps, 'h2', 'How it works', 'parent', '65eca4c4a9abb2b03ce13b156d3168c26ad0cc67ed1379ac6332f28bacad9a61'],
      [input.ossV1, 'h2', 'Examples', 'siblings', 'a89df521f8ce1833b9e5160281618fb23eb9bce9b7b494d16bc2e72c0f6a3a7c'],
      [input.ossV4, 'h3', 'Step 1: Create a canonical request', 'parent', '2eaac1f146afec2514afeed877824d3629c45dc54648f1f660894ee850edf83c']
    ]) {
      const doc = document(source, '.icms-help-docs-content')
      const h = doc.root.find(level).filter((_, node) => normalized(doc.$(node).text()) === heading)
      if (h.length !== 1) refuse()
      match(scope === 'parent' ? h.parent() : h.nextUntil('h1,h2'), hash)
    }
    return { status: 'matches' as const, modelIds: [...QWEN_AUDIO_TTS_MODELS] }
  } catch { return insufficient }
}
