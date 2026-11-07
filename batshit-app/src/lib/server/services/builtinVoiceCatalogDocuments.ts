import { isAlias, isCollection, isPair, isScalar, parseDocument } from 'yaml'
import { lexer, type Tokens } from 'marked'
import { load } from 'cheerio'
import { inspectVoiceOperationContract } from './builtinVoiceCatalogContract'

/** Finite document selectors only. No scripts, MDX, links, tags or remote refs execute. */
export class VoiceDocumentError extends Error {
  constructor(readonly reason: 'structure' | 'contract' | 'bounds') { super(`Voice source ${reason}`) }
}
const refuse = (reason: 'structure' | 'contract' | 'bounds' = 'structure'): never => { throw new VoiceDocumentError(reason) }
type Row = Record<string, unknown>
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : refuse()
function at(value: unknown, ...keys: string[]): unknown { for (const key of keys) value = record(value)[key]; return value }
const includes = (value: unknown, expected: string) => Array.isArray(value) && value.includes(expected)
export function parseVoiceYaml(body: string): Row {
  if (Buffer.byteLength(body, 'utf8') > 2 * 1024 * 1024) refuse('bounds')
  const doc = parseDocument(body, { schema: 'core', version: '1.2', customTags: [], stringKeys: true, uniqueKeys: true, strict: true })
  if (doc.errors.length || doc.warnings.length || doc.directives?.yaml.version !== '1.2') refuse()
  let count = 0
  const inspect = (node: unknown, depth: number): void => {
    if (++count > 250_000 || depth > 64) refuse('bounds')
    if (isAlias(node)) refuse()
    if (isPair(node)) { if (!isScalar(node.key) || typeof node.key.value !== 'string') refuse(); inspect(node.key, depth + 1); inspect(node.value, depth + 1) }
    else if (isCollection(node)) for (const item of node.items) inspect(item, depth + 1)
    else if (isScalar(node) && node.value !== null && !['string', 'boolean', 'number'].includes(typeof node.value)) refuse()
    else if (isScalar(node) && typeof node.value === 'number' && !Number.isFinite(node.value)) refuse()
  }
  inspect(doc.contents, 0)
  return record(doc.toJS({ maxAliasCount: 0 }))
}
export function voiceSourceIdentity(value: string): string {
  if (!value || !value.isWellFormed() || value !== value.trim() || Buffer.byteLength(value, 'utf8') > 256 || /[\s<>`\u0000-\u001f\u007f]/u.test(value)) refuse()
  return value
}
const plain = (value: string) => value.replace(/\*\*|`|&nbsp;|<[^>]*>/g, '').trim().replace(/\s+/g, ' ')
/** Exactly one named root table. Code fences, navigation and unrelated prose cannot supply IDs. */
export function voiceSourceTable(body: string, headers: readonly string[]): string[][] {
  const tables = lexer(body).filter((token): token is Tokens.Table => token.type === 'table' &&
    token.header.map((cell: Tokens.TableCell) => plain(cell.text)).join('\0') === headers.join('\0'))
  if (tables.length !== 1 || !tables[0].rows.length || tables[0].rows.length > 1000) return refuse()
  return tables[0].rows.map(row => row.map(cell => cell.text))
}
export function voiceSourceSection(body: string, heading: string): string {
  const tokens = lexer(body), starts = tokens.flatMap((token, index) => token.type === 'heading' && plain(token.text) === heading ? [index] : [])
  if (starts.length !== 1) return refuse()
  const start = starts[0], level = (tokens[start] as Tokens.Heading).depth
  const next = tokens.findIndex((token, index) => index > start && token.type === 'heading' && token.depth <= level)
  return tokens.slice(start + 1, next < 0 ? undefined : next).map(token => token.raw).join('')
}
export function voiceSourceCodeId(cell: string): string {
  const ids = [...cell.matchAll(/`([^`]+)`/g)]
  if (ids.length !== 1 || plain(cell.replace(ids[0][0], '')).length) return refuse()
  return voiceSourceIdentity(ids[0][1])
}
/** HTML is read as a document, never run. Only the designated article's tables/code survive. */
export function voiceSourceHtml(body: string, selector: string): { text: string; tables: string[][][]; code: string[] } {
  const $ = load(body), root = $(selector)
  if (root.length !== 1) return refuse()
  root.find('script,style,nav,header,footer,aside,template').remove()
  const tables = root.find('table').toArray().map(table => $(table).find('tr').toArray().map(tr => $(tr).find('th,td').toArray().map(cell => $(cell).text().trim())))
  return { text: root.text(), tables, code: root.find('code').toArray().map(code => $(code).text()) }
}

/** Fixed-section DOM shape and text; attributes and presentation are inert. */
export function voiceSourceHtmlProjection(nodes: readonly unknown[]): string {
  let count = 0
  const visit = (input: unknown, depth: number): unknown => {
    if (++count > 100_000 || depth > 64) return refuse('bounds')
    const node = record(input)
    if (node.type === 'text') return ['text', typeof node.data === 'string' ? node.data.replace(/\s+/gu, ' ').trim() : refuse()]
    if (node.type === 'comment') return null
    if (node.type !== 'tag' && node.type !== 'script' && node.type !== 'style') return refuse()
    if (typeof node.name !== 'string' || !Array.isArray(node.children)) return refuse()
    if (['script','style','nav','header','footer','aside','template'].includes(node.name)) return null
    return [node.name, node.children.map((child: unknown) => visit(child, depth + 1)).filter((child: unknown) => child !== null && JSON.stringify(child) !== '["text",""]')]
  }
  return JSON.stringify(nodes.map(node => visit(node, 0)).filter(node => node !== null))
}
function localSchema(spec: Row, value: unknown): Row {
  const schema = record(value)
  if (schema.$ref === undefined) return schema
  if (typeof schema.$ref !== 'string' || !/^#\/components\/schemas\/[A-Za-z0-9_]+$/.test(schema.$ref)) return refuse()
  return record(record(record(spec.components).schemas)[schema.$ref.slice('#/components/schemas/'.length)])
}
export function inspectMistralVoiceApi(body: string) {
  const spec = parseVoiceYaml(body)
  const tts = inspectVoiceOperationContract(spec, 'mistral-speech')
  const recorded = inspectVoiceOperationContract(spec, 'mistral-recorded')
  return { tts: tts.state === 'matches', recorded: recorded.state === 'matches', contracts: { tts, recorded }, timestampField: 'timestamp_granularities' as const }
}
export function inspectMinimaxVoiceDocument(body: string) {
  const blocks = lexer(body).filter((token): token is Tokens.Code => token.type === 'code' && token.lang === 'yaml api-reference/speech/t2a/api/openapi.json POST /v1/t2a_v2')
  if (blocks.length !== 1) return refuse()
  const spec = parseVoiceYaml(blocks[0].text)
  const schema = localSchema(spec, at(spec, 'paths', '/v1/t2a_v2', 'post', 'requestBody', 'content', 'application/json', 'schema'))
  const props = record(schema.properties), models = localSchema(spec, props.model).enum
  if (!Array.isArray(models) || !models.length || models.length > 1000 || new Set(models).size !== models.length) return refuse()
  const contract = inspectVoiceOperationContract(spec, 'minimax-speech')
  return { models: models.map(value => voiceSourceIdentity(typeof value === 'string' ? value : refuse())), compatible: contract.state === 'matches', contract }
}
export function inspectCartesiaVoiceDocument(body: string) {
  const rows = voiceSourceTable(body, ['model_id','Model update behavior','Recommended for'])
  const dated = voiceSourceTable(body, ['Snapshot','Release Date','Languages','Status'])
  const sameContract = voiceSourceSection(body, 'Switching from Sonic 3.5?').includes('fully backwards compatible with Sonic 3.5.')
  const models = rows.filter(row => !row[0].includes('YYYY-MM-DD')).map(row => ({ modelId: voiceSourceCodeId(row[0]), documentedCompatibility: sameContract && plain(row[1]) === 'Will be updated to point to the most recent stable snapshot', preview: plain(row[1]).includes('Beta') }))
  for (const row of dated) models.push({ modelId: voiceSourceCodeId(row[0]), documentedCompatibility: sameContract && plain(row[3]) === 'Stable', preview: false })
  if (new Set(models.map(model => model.modelId)).size !== models.length) return refuse()
  return models.map(model => ({ ...model, compatible: false }))
}
