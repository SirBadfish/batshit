/**
 * BL-89: every artifact field needs a name a screen reader can read.
 *
 * A static scan, like the rest of the save-time checks: nothing runs. It looks at two places.
 *
 * 1. Form controls written as markup (`<input>`, `<select>`, `<textarea>`, range inputs included).
 *    A control has a name when a `<label for>` with text points at its id, a `<label>` with text
 *    wraps it, `aria-label` has text, `aria-labelledby` points at an element that exists, or, last,
 *    `title` has text. A placeholder is not a name, and neither is a title that merely sits beside
 *    the field (the BL-89 tip calculator). Hidden inputs, buttons, and controls that are not shown
 *    at all (`hidden`, `aria-hidden="true"`, inline `display:none`) are exempt.
 * 2. Builder Kit field calls in inline scripts (`builder.form.text|textarea|select|multiselect|
 *    slider|number({...})`). The Builder Kit links a field's `label` to its control, so a call with
 *    a `label` or an `ariaLabel` is named; one without is not. A call whose options are not an
 *    object literal, or spread in other options, is not judged. Checkbox, toggle, radio, and
 *    promptPair always render their own text.
 *
 * Markup a script writes as a string is not checked: that is what the Builder Kit is for.
 *
 * `checkArtifactFieldNames` compares a save with the artifact's saved versions, so only a field the
 * save ADDS is refused. Fields an artifact already had (saved before this check existed) stay a
 * warning: every update re-validates the whole current content, and refusing them would block a
 * zone change, an agent-use toggle, or a rollback on an artifact the user never touched.
 *
 * A field is matched with the saved versions by a stable identity where it has one: a markup `id`
 * or `name`, a Builder Kit `fabricId` or `id`. Its text is the key only when it has none. So an old
 * unnamed field the save restyles, reorders, or re-tunes (a class, attribute order, a `min`, its
 * `onChange`, a reformatted options object) is the same field and stays a warning (BL-89 review).
 */

export type UnnamedArtifactField = {
  source: 'markup' | 'builder'
  /** How the field reads in a message: `<input type="number" id="bill">`, `builder.form.slider()`. */
  element: string
  /** 1-based line in the artifact HTML. */
  line: number
  /**
   * How a save is compared with saved versions: `id:…` / `name:…` / `fabric:…` for a field with a
   * stable identity, or its normalized source text (`text:…`) for one without.
   */
  key: string
}

export type ArtifactFieldNameCheck = {
  unnamed: UnnamedArtifactField[]
  /** Unnamed fields this save adds. Refused while structure enforcement is on. */
  added: UnnamedArtifactField[]
  /** Unnamed fields the artifact already had in a saved version. Reported, never refused. */
  kept: UnnamedArtifactField[]
}

const CONTROL_TAG = /<(input|select|textarea)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi
const LABEL_ELEMENT = /<label\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/label\s*>/gi
const ATTRIBUTE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
const ID_ATTRIBUTE = /\sid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi
const INLINE_SCRIPT = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi
const HIDDEN_BLOCKS = [/<!--[\s\S]*?-->/g, /<script\b[\s\S]*?<\/script\s*>/gi, /<style\b[\s\S]*?<\/style\s*>/gi]
const EXEMPT_INPUT_TYPES = new Set(['hidden', 'button', 'submit', 'reset', 'image'])
const BUILDER_FIELD_CALL = /\bform\s*\.\s*(text|textarea|select|multiselect|slider|number)\s*\(/g
const MAX_LISTED_FIELDS = 6

function lineAt(content: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset && index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) line += 1
  }
  return line
}

// Blank a region out while keeping every newline, so offsets and line numbers stay true.
function blankOut(content: string, pattern: RegExp): string {
  return content.replace(pattern, (match) => match.replace(/[^\n]/g, ' '))
}

function parseAttributes(source: string): Map<string, string | null> {
  const attributes = new Map<string, string | null>()
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase()
    if (attributes.has(name)) continue
    const value = match[2] ?? match[3] ?? match[4]
    attributes.set(name, value === undefined ? null : value)
  }
  return attributes
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function describeControl(tag: string, attributes: Map<string, string | null>): string {
  const parts = [`<${tag}`]
  const type = attributes.get('type')
  if (tag === 'input' && hasText(type)) parts.push(` type="${type!.trim().toLowerCase()}"`)
  const id = attributes.get('id')
  const name = attributes.get('name')
  if (hasText(id)) parts.push(` id="${id!.trim()}"`)
  else if (hasText(name)) parts.push(` name="${name!.trim()}"`)
  return `${parts.join('')}>`
}

function isNotShown(attributes: Map<string, string | null>): boolean {
  if (attributes.has('hidden')) return true
  if ((attributes.get('aria-hidden') ?? '').trim().toLowerCase() === 'true') return true
  const style = (attributes.get('style') ?? '').replace(/\s+/g, '').toLowerCase()
  return style.includes('display:none') || style.includes('visibility:hidden')
}

function findUnnamedMarkupFields(content: string): UnnamedArtifactField[] {
  const markup = HIDDEN_BLOCKS.reduce(blankOut, content)
  const ids = new Set<string>()
  for (const match of markup.matchAll(ID_ATTRIBUTE)) {
    const id = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (id) ids.add(id)
  }
  const labelledIds = new Set<string>()
  const wrappingLabels: Array<{ start: number; end: number; text: string }> = []
  for (const match of markup.matchAll(LABEL_ELEMENT)) {
    const attributes = parseAttributes(match[1] ?? '')
    const text = textOf(match[2] ?? '')
    const target = (attributes.get('for') ?? '').trim()
    if (target && text) labelledIds.add(target)
    const start = match.index ?? 0
    wrappingLabels.push({ start, end: start + match[0].length, text })
  }

  const unnamed: UnnamedArtifactField[] = []
  for (const match of markup.matchAll(CONTROL_TAG)) {
    const tag = match[1].toLowerCase()
    const attributes = parseAttributes(match[2] ?? '')
    const type = (attributes.get('type') ?? 'text').trim().toLowerCase()
    if (tag === 'input' && EXEMPT_INPUT_TYPES.has(type)) continue
    if (isNotShown(attributes)) continue

    const offset = match.index ?? 0
    const id = (attributes.get('id') ?? '').trim()
    const labelledBy = (attributes.get('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
    const wrapped = wrappingLabels.some((label) => label.start < offset && offset < label.end && label.text.length > 0)
    const named =
      (id.length > 0 && labelledIds.has(id)) ||
      wrapped ||
      hasText(attributes.get('aria-label')) ||
      labelledBy.some((reference) => ids.has(reference)) ||
      hasText(attributes.get('title'))
    if (named) continue

    const name = (attributes.get('name') ?? '').trim()
    unnamed.push({
      source: 'markup',
      element: describeControl(tag, attributes),
      line: lineAt(content, offset),
      key: id ? `id:${id}` : name ? `name:${name}` : `text:markup:${match[0].replace(/\s+/g, ' ').trim().toLowerCase()}`
    })
  }
  return unnamed
}

// Index just past the value that starts at `start`: skips strings and nested brackets.
function skipStringLiteral(source: string, start: number): number {
  const quote = source[start]
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === quote) return index + 1
    index += 1
  }
  return index
}

/** The text of the object literal whose `{` sits at `open`, without the braces; null if unclosed. */
function objectLiteralBody(source: string, open: number): string | null {
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '"' || char === "'" || char === '`') {
      index = skipStringLiteral(source, index) - 1
      continue
    }
    if (char === '{' || char === '[' || char === '(') depth += 1
    if (char === '}' || char === ']' || char === ')') {
      depth -= 1
      if (depth === 0) return char === '}' ? source.slice(open + 1, index) : null
    }
  }
  return null
}

/** Top-level `key: value` entries of an object literal body; `spread` when it spreads others in. */
function topLevelEntries(body: string): { entries: Map<string, string>; spread: boolean } {
  const segments: string[] = []
  let depth = 0
  let segmentStart = 0
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '"' || char === "'" || char === '`') {
      index = skipStringLiteral(body, index) - 1
      continue
    }
    if (char === '{' || char === '[' || char === '(') depth += 1
    else if (char === '}' || char === ']' || char === ')') depth -= 1
    else if (char === ',' && depth === 0) {
      segments.push(body.slice(segmentStart, index))
      segmentStart = index + 1
    }
  }
  segments.push(body.slice(segmentStart))

  const entries = new Map<string, string>()
  let spread = false
  for (const raw of segments) {
    const segment = raw.trim()
    if (!segment) continue
    if (segment.startsWith('...')) {
      spread = true
      continue
    }
    const keyed = /^(?:([A-Za-z_$][\w$]*)|"([^"]*)"|'([^']*)')\s*:([\s\S]*)$/.exec(segment)
    if (keyed) {
      entries.set(keyed[1] ?? keyed[2] ?? keyed[3], keyed[4].trim())
      continue
    }
    // Shorthand property: `{ label }` passes the variable of that name.
    if (/^[A-Za-z_$][\w$]*$/.test(segment)) entries.set(segment, segment)
  }
  return { entries, spread }
}

/** The value of a plain string literal (`'x'`, `"x"`, or a template with no `${}`), else undefined. */
function stringLiteral(value: string | undefined): string | undefined {
  const match = /^(['"`])([^'"`]*)\1$/.exec((value ?? '').trim())
  if (!match || (match[1] === '`' && match[2].includes('${'))) return undefined
  return match[2].trim() || undefined
}

function givesAName(value: string | undefined): boolean {
  if (value === undefined) return false
  const trimmed = value.trim()
  return !['', "''", '""', '``', 'null', 'undefined'].includes(trimmed)
}

function findUnnamedBuilderFields(content: string): UnnamedArtifactField[] {
  const unnamed: UnnamedArtifactField[] = []
  for (const script of content.matchAll(INLINE_SCRIPT)) {
    if (/\ssrc\s*=/i.test(` ${script[1] ?? ''}`)) continue
    const body = script[2] ?? ''
    const bodyOffset = (script.index ?? 0) + script[0].indexOf('>') + 1
    for (const call of body.matchAll(BUILDER_FIELD_CALL)) {
      const kind = call[1]
      let open = (call.index ?? 0) + call[0].length
      while (open < body.length && /\s/.test(body[open])) open += 1
      if (body[open] !== '{') continue
      const options = objectLiteralBody(body, open)
      if (options === null) continue
      const { entries, spread } = topLevelEntries(options)
      if (givesAName(entries.get('label')) || givesAName(entries.get('ariaLabel'))) continue
      if (spread) continue
      const fabricId = stringLiteral(entries.get('fabricId'))
      const id = stringLiteral(entries.get('id'))
      unnamed.push({
        source: 'builder',
        element: `builder.form.${kind}(${fabricId ? `{ fabricId: '${fabricId}' }` : ''})`,
        line: lineAt(content, bodyOffset + (call.index ?? 0)),
        key: fabricId ? `fabric:${fabricId}` : id ? `id:${id}` : `text:builder:${kind}:${options.replace(/\s+/g, ' ').trim()}`
      })
    }
  }
  return unnamed
}

export function findUnnamedArtifactFields(content: string | null | undefined): UnnamedArtifactField[] {
  const source = typeof content === 'string' ? content : ''
  if (!source) return []
  return [...findUnnamedMarkupFields(source), ...findUnnamedBuilderFields(source)].sort((a, b) => a.line - b.line)
}

export function checkArtifactFieldNames(
  content: string | null | undefined,
  previousContents: Array<string | null | undefined> = []
): ArtifactFieldNameCheck {
  const unnamed = findUnnamedArtifactFields(content)
  // For each key, the most copies any single saved version held.
  const allowed = new Map<string, number>()
  for (const previous of previousContents) {
    const counts = new Map<string, number>()
    for (const field of findUnnamedArtifactFields(previous)) counts.set(field.key, (counts.get(field.key) ?? 0) + 1)
    for (const [key, count] of counts) allowed.set(key, Math.max(allowed.get(key) ?? 0, count))
  }
  const seen = new Map<string, number>()
  const added: UnnamedArtifactField[] = []
  const kept: UnnamedArtifactField[] = []
  for (const field of unnamed) {
    const count = (seen.get(field.key) ?? 0) + 1
    seen.set(field.key, count)
    if (count <= (allowed.get(field.key) ?? 0)) kept.push(field)
    else added.push(field)
  }
  return { unnamed, added, kept }
}

function listFields(fields: UnnamedArtifactField[]): string {
  const listed = fields.slice(0, MAX_LISTED_FIELDS).map((field) => `line ${field.line} \`${field.element}\``)
  const rest = fields.length - MAX_LISTED_FIELDS
  return rest > 0 ? `${listed.join(', ')}, and ${rest} more` : listed.join(', ')
}

const HOW_TO_NAME =
  'Link a visible label (`<label for="the-field-id">` or a `<label>` wrapped around the field) or set `aria-label`; ' +
  'a Builder Kit field needs `label` (or `ariaLabel` when it shows no label). A placeholder is not a name.'

export function buildFieldNameRequiredMessage(fields: UnnamedArtifactField[]): string {
  return `Give every field a name a screen reader can read. These fields have none: ${listFields(fields)}. ${HOW_TO_NAME}`
}

/**
 * The save refusal when field names are the only problem (BL-89 review). It names the fields and
 * how to name them, and nothing else: switching enforcement off is not the fix for a missing name.
 */
export function buildFieldNameRefusalMessage(fields: UnnamedArtifactField[]): string {
  return `Artifact save blocked: ${buildFieldNameRequiredMessage(fields)}`
}

export function buildFieldNameAdvisory(fields: UnnamedArtifactField[]): string {
  return (
    `Fields this artifact already had have no name a screen reader can read: ${listFields(fields)}. ` +
    `Saving still works; name them when you next edit them. ${HOW_TO_NAME}`
  )
}
