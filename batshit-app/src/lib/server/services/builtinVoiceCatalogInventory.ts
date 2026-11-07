import { load, type CheerioAPI } from 'cheerio'
import { lexer, type Token, type Tokens } from 'marked'
import type { BuiltinVoiceLane } from '$lib/types/builtinVoiceCatalog'
import { VoiceDocumentError, voiceSourceCodeId, voiceSourceIdentity, voiceSourceSection, voiceSourceTable } from './builtinVoiceCatalogDocuments'

export type VoiceInventoryModel = Readonly<{ modelId: string; lane: BuiltinVoiceLane; release?: 'deprecated'; shutdownAt?: string }>
type Scope = ReturnType<CheerioAPI>
const refuse = (): never => { throw new VoiceDocumentError('structure') }
const plain = (value: string) => value.trim().replace(/\s+/gu, ' ')
const within = (scope: Scope, selector: string) => scope.filter(selector).add(scope.find(selector))

/** These inspectors collect candidates only. A model name never establishes its API contract. */
function bounded(body: string): void {
  if (Buffer.byteLength(body, 'utf8') > 2 * 1024 * 1024 || !body.isWellFormed() || body.includes('\0')) refuse()
}
function html(body: string, selector: string): { $: CheerioAPI; root: Scope } {
  bounded(body)
  const $ = load(body), root = $(selector)
  if (root.length !== 1) return refuse()
  root.find('script,style,nav,header,footer,aside,template').remove()
  return { $, root }
}
function section(root: Scope, id: string, level: 2 | 3): Scope {
  const heading = root.find(`h${level}[id="${id}"]`)
  if (heading.length !== 1) return refuse()
  return heading.nextUntil(level === 2 ? 'h1,h2' : 'h1,h2,h3')
}
function matchingTables($: CheerioAPI, scope: Scope, headers: readonly string[]) {
  return within(scope, 'table').toArray().filter(node => {
    const cells = $(node).find('tr').first().find('th,td').toArray().map(cell => plain($(cell).text()))
    return cells.join('\0') === headers.join('\0')
  })
}
function table($: CheerioAPI, scope: Scope, headers: readonly string[]): Scope[] {
  const tables = matchingTables($, scope, headers)
  if (tables.length !== 1) return refuse()
  const rows = $(tables[0]).find('tr').toArray().slice(1)
  if (!rows.length || rows.length > 1000 || rows.some(row => $(row).children('th,td').length !== headers.length)) return refuse()
  return rows.map(row => $(row).children('th,td'))
}
function code($: CheerioAPI, scope: Scope): string {
  const codes = within(scope, 'code')
  if (codes.length !== 1) return refuse()
  return voiceSourceIdentity($(codes[0]).text())
}
function models(values: VoiceInventoryModel[]): VoiceInventoryModel[] {
  if (!values.length || values.length > 1000 || new Set(values.map(value => JSON.stringify([value.lane, value.modelId]))).size !== values.length) return refuse()
  return values
}
const isHtml = (body: string) => /^\s*</u.test(body)
const markdownLinkText = (cell: string) => cell.trim().replace(/^\[([^\]]+)\]\([^\s)]+\)$/u, '$1')

/** A named notice's calendar date is warning metadata, never an automatic removal deadline. */
export function inspectOpenaiVoiceDeprecations(body: string, task: 'speech' | 'transcribe'): VoiceInventoryModel[] {
  bounded(body)
  let paragraphs: string[]
  if (isHtml(body)) {
    const { $, root } = html(body, 'article')
    let scope: Scope
    if (task === 'transcribe') {
      if (root.find('h2[id="existing-integrations-with-deprecated-models"]').length === 0) return []
      scope = section(root, 'existing-integrations-with-deprecated-models', 2)
    } else {
      const children = root.children(), end = children.toArray().findIndex(node => 'name' in node && /^h[2-6]$/u.test(node.name))
      scope = children.slice(0, end < 0 ? undefined : end)
    }
    paragraphs = within(scope, 'p').toArray().map(node => {
      const paragraph = $(node).clone()
      paragraph.find('code').each((_, code) => { $(code).replaceWith($('<span>').text('`'+$(code).text()+'`')) })
      return plain(paragraph.text())
    })
  } else {
    let tokens: Token[] = lexer(body)
    if (task === 'transcribe') {
      if (!tokens.some(token => token.type === 'heading' && token.text === 'Existing integrations with deprecated models')) return []
      tokens = lexer(voiceSourceSection(body, 'Existing integrations with deprecated models'))
    } else {
      const end = tokens.findIndex(token => token.type === 'heading' && token.depth > 1)
      if (end >= 0) tokens = tokens.slice(0, end)
    }
    paragraphs = tokens.flatMap(token => token.type === 'paragraph' ? [plain(token.text)] : [])
  }
  const notices = paragraphs.filter(value => /^(?:The )?`/u.test(value) && value.includes('are deprecated') && value.includes('shut down'))
  if (!notices.length) return []
  if (notices.length !== 1) return refuse()
  const match = notices[0].match(/^(?:The )?(`[^`]+`(?:(?:,\s*(?:and\s+)?|\s+and\s+)`[^`]+`)*)(?: models)? are deprecated and will shut down on (?:\*\*)?([A-Z][a-z]+) (\d{1,2}), (\d{4})(?:\*\*)?\./u)
  if (!match) return refuse()
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const month = months.indexOf(match[2]), day = Number(match[3]), year = Number(match[4])
  const date = new Date(Date.UTC(year, month, day))
  if (month < 0 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return refuse()
  const ids = [...match[1].matchAll(/`([^`]+)`/gu)].map(value => voiceSourceIdentity(value[1]))
    .filter(id => !(task === 'transcribe' && id === '/v1/audio/translations'))
  if (ids.some(id => id.startsWith('/'))) return refuse()
  return models(ids.map(modelId => ({ modelId, lane: task === 'speech' ? 'tts-batch' : 'stt-recorded', release: 'deprecated', shutdownAt: date.toISOString() })))
}

function openaiWarnings(body: string, task: 'speech' | 'transcribe', values: VoiceInventoryModel[]): VoiceInventoryModel[] {
  const observed = new Map(values.map(value => [JSON.stringify([value.lane, value.modelId]), value]))
  for (const warning of inspectOpenaiVoiceDeprecations(body, task)) {
    const key = JSON.stringify([warning.lane, warning.modelId])
    observed.set(key, { ...observed.get(key), ...warning })
  }
  return models([...observed.values()])
}

export function inspectGoogleVoiceInventory(body: string, task: 'speech' | 'transcribe'): VoiceInventoryModel[] {
  const { $, root } = html(body, '.devsite-article-body')
  if (task === 'speech') {
    const rows = table($, section(root, 'supported-models', 2), ['Model','Single speaker','Multi-speaker','Voice design','Voice replication'])
    // A human-readable model link alone supplies no exact backend ID. Do not derive one from its URL.
    return models(rows.filter(row => row.eq(0).find('code').length > 0).map(row => ({ modelId: code($, row.eq(0)), lane: 'tts-batch' })))
  }
  const introduction = root.children('p').filter((_, node) => plain($(node).text()).length > 0).slice(0, 2)
  if (introduction.length !== 2) return refuse()
  const ids = introduction.toArray().map(node => code($, $(node)))
  if (ids[0] !== ids[1]) return refuse()
  return models([{ modelId: ids[0], lane: 'stt-recorded' }])
}

export function inspectOpenaiVoiceInventory(body: string, task: 'speech' | 'transcribe'): VoiceInventoryModel[] {
  bounded(body)
  if (task === 'speech') {
    let ids: string[]
    if (isHtml(body)) {
      const { $, root } = html(body, 'article')
      ids = within(section(root, 'text-to-speech-models', 3), 'code').toArray().map(node => voiceSourceIdentity($(node).text()))
    } else {
      // Only inline code in this exact section's root paragraphs; fenced examples cannot add models.
      ids = lexer(voiceSourceSection(body, 'Text-to-speech models')).filter((token): token is Tokens.Paragraph => token.type === 'paragraph')
        .flatMap(token => token.tokens.filter((token): token is Tokens.Codespan => token.type === 'codespan').map(token => voiceSourceIdentity(token.text)))
    }
    return openaiWarnings(body, task, models([...new Set(ids)].map(modelId => ({ modelId, lane: 'tts-batch' }))))
  }
  const lanes = new Map<string, BuiltinVoiceLane>([['File transcription','stt-recorded'], ['Realtime transcription','stt-direct-realtime']])
  let rows: { workflow: string; modelId: string }[]
  if (isHtml(body)) {
    const { $, root } = html(body, 'article')
    rows = table($, section(root, 'choose-a-transcription-workflow', 2), ['Workflow','Use when','Recommended model'])
      .map(row => ({ workflow: plain(row.eq(0).text()), modelId: code($, row.eq(2)) }))
  } else {
    const scope = voiceSourceSection(body, 'Choose a transcription workflow'), tokens = lexer(scope)
    const headers = ['Workflow','Use when','Recommended model']
    const markdownTables = tokens.filter(token => token.type === 'table' && token.header.map((cell: Tokens.TableCell) => plain(cell.text)).join('\0') === headers.join('\0'))
    // The official Markdown response also uses one inert HTML table with Markdown link/code cells.
    const htmlTables = tokens.flatMap(token => token.type === 'html' && /^\s*<table(?:\s|>)/u.test(token.text) ? [token.text] : [])
    const { $, root } = html('<article>'+htmlTables.join('\n')+'</article>', 'article')
    if (matchingTables($, root, headers).length) {
      if (markdownTables.length) return refuse()
      rows = table($, root, headers).map(row => ({ workflow: markdownLinkText(plain(row.eq(0).text())), modelId: row.eq(2).find('code').length
        ? code($, row.eq(2)) : voiceSourceCodeId(markdownLinkText(plain(row.eq(2).text()))) }))
    } else {
      rows = voiceSourceTable(scope, headers).map(row => ({ workflow: markdownLinkText(row[0]), modelId: voiceSourceCodeId(markdownLinkText(row[2])) }))
    }
  }
  if (rows.length !== lanes.size || new Set(rows.map(row => row.workflow)).size !== lanes.size) return refuse()
  return openaiWarnings(body, task, models(rows.map(row => ({ modelId: row.modelId, lane: lanes.get(row.workflow) ?? refuse() }))))
}

export function inspectAlibabaVoiceInventory(body: string): VoiceInventoryModel[] {
  const { $, root } = html(body, 'article'), scope = section(root, 'supported-models', 2)
  const values = new Map<string, VoiceInventoryModel>()
  for (const region of ['singapore','beijing']) {
    const regionScope = within(scope, `section[id="${region}"]`)
    if (regionScope.length !== 1) return refuse()
    for (const family of ['Qwen-Audio-TTS','Qwen3-TTS']) {
      const lists = regionScope.find('li').filter((_, node) => plain($(node).children('strong').text()) === family)
      if (lists.length !== 1) return refuse()
      const ids = lists.find('code').toArray().map(node => voiceSourceIdentity($(node).text()))
      if (!ids.length || ids.length > 1000 || new Set(ids).size !== ids.length) return refuse()
      for (const modelId of ids) values.set(modelId, { modelId,
        // Exact known transport split, never a family/prefix compatibility rule.
        lane: modelId === 'qwen3-tts-flash-realtime' ? 'tts-direct-stream' : 'tts-batch' })
    }
  }
  // CosyVoice and other source families need a separate integration; this is partial discovery.
  return models([...values.values()])
}

export function inspectAsyncVoiceInventory(body: string): VoiceInventoryModel[] {
  bounded(body)
  if (!isHtml(body)) {
    const headings = ['Text-to-Speech Models', 'Speech-to-Text Models'] as const
    const tokens: Token[] = lexer(body)
    if (headings.some(title => tokens.filter(token => token.type === 'heading' && token.depth === 2 && token.text === title).length !== 1)) return refuse()
    const rows = (heading: string, headers: string[]) => {
      const scope = voiceSourceSection(body, heading)
      // Do not ignore a competing HTML table in the same designated section.
      if (lexer(scope).some(token => token.type === 'html' && /<table(?:\s|>)/iu.test(token.text))) return refuse()
      return voiceSourceTable(scope, headers).map(row => voiceSourceCodeId(row[0]))
    }
    return models([
      ...rows(headings[0], ['Model','Tier','Languages','Best For']).map(modelId => ({ modelId, lane: 'tts-batch' as const })),
      ...rows(headings[1], ['Model','Languages','Best For']).map(modelId => ({ modelId, lane: 'stt-recorded' as const }))
    ])
  }
  const { $, root } = html(body, '.markdown-body')
  const tts = table($, section(root, 'text-to-speech-models', 2), ['Model','Tier','Languages','Best For'])
    .map(row => ({ modelId: code($, row.eq(0)), lane: 'tts-batch' as const }))
  const stt = table($, section(root, 'speech-to-text-models', 2), ['Model','Languages','Best For'])
    .map(row => ({ modelId: code($, row.eq(0)), lane: 'stt-recorded' as const }))
  return models([...tts, ...stt])
}

export function inspectStepfunVoiceInventory(body: string): VoiceInventoryModel[] {
  const { $, root } = html(body, 'main article')
  const scope = section(root, 'cookbook-3-1-准备文本与请求', 3)
  // The cookbook renders code as static line divs. Read one literal assignment; never evaluate Python.
  const values = within(scope, 'div.whitespace-pre').toArray().flatMap(node => {
    const match = $(node).text().match(/^[\t ]*MODEL[\t ]*=[\t ]*(["'])([^"'\\\r\n]+)\1[\t ]*$/u)
    return match ? [voiceSourceIdentity(match[2])] : []
  })
  if (values.length !== 1) return refuse()
  return models([{ modelId: values[0], lane: 'tts-batch' }])
}
