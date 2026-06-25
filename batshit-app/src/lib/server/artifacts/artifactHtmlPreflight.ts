import { Script } from 'node:vm'

export type ArtifactHtmlPreflightIssue = {
  code: 'INLINE_SCRIPT_SYNTAX_ERROR' | 'UNSUPPORTED_RUNTIME_API'
  message: string
  scriptIndex: number
  line?: number
}

export type ArtifactHtmlPreflightAdvisory = {
  code: 'ESCAPED_TEMPLATE_LITERAL_INTERPOLATION'
  message: string
  scriptIndex: number
  line?: number
}

export type ArtifactHtmlPreflightResult = {
  ok: boolean
  checkedScripts: number
  skippedScripts: number
  issues: ArtifactHtmlPreflightIssue[]
  advisories: ArtifactHtmlPreflightAdvisory[]
}

type InlineScriptBlock = {
  attrs: string
  content: string
  index: number
  startLine: number
}

const SCRIPT_TAG_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
const CLASSIC_SCRIPT_TYPES = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript'
])

function countLinesBefore(value: string, index: number): number {
  return value.slice(0, index).split('\n').length
}

function hasAttribute(attrs: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*=`, 'i').test(attrs)
}

function getAttribute(attrs: string, name: string): string | null {
  const match = attrs.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  )
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? null)?.trim() || null
}

function isClassicInlineScript(attrs: string): boolean {
  if (hasAttribute(attrs, 'src')) return false

  const type = getAttribute(attrs, 'type')
  if (!type) return true

  const normalized = type.toLowerCase().split(';', 1)[0]?.trim() ?? ''
  return CLASSIC_SCRIPT_TYPES.has(normalized)
}

function extractInlineScripts(content: string): InlineScriptBlock[] {
  const scripts: InlineScriptBlock[] = []
  let match: RegExpExecArray | null
  let scriptIndex = 0

  SCRIPT_TAG_PATTERN.lastIndex = 0
  while ((match = SCRIPT_TAG_PATTERN.exec(content)) !== null) {
    scriptIndex += 1
    const openingTag = match[0].slice(0, match[0].indexOf('>') + 1)
    scripts.push({
      attrs: match[1] ?? '',
      content: match[2] ?? '',
      index: scriptIndex,
      startLine: countLinesBefore(content, match.index + openingTag.length)
    })
  }

  return scripts
}

function extractScriptLine(error: unknown, filename: string): number | null {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return null
  const escapedFilename = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = error.stack.match(new RegExp(`${escapedFilename}:(\\d+)`))
  if (!match?.[1]) return null
  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) ? parsed : null
}

function buildSyntaxMessage(scriptIndex: number, error: unknown, line?: number): string {
  const reason = error instanceof Error ? error.message : 'Unknown JavaScript syntax error'
  const lineSuffix = typeof line === 'number' ? ` at artifact line ${line}` : ''
  return `Inline script #${scriptIndex} has invalid JavaScript${lineSuffix}: ${reason}.`
}

function findEscapedInterpolationLine(script: InlineScriptBlock): number | undefined {
  const match = /\\\$\{/.exec(script.content)
  if (!match) return undefined
  return script.startLine + countLinesBefore(script.content, match.index) - 1
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getBatshitAliases(scriptContent: string): string[] {
  const aliases = new Set<string>(['window.batshit'])
  const aliasPattern =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*window\.batshit\b/g
  let match: RegExpExecArray | null

  while ((match = aliasPattern.exec(scriptContent)) !== null) {
    const alias = match[1]?.trim()
    if (alias) aliases.add(alias)
  }

  return Array.from(aliases)
}

function findUnsupportedRuntimeApiIssue(
  script: InlineScriptBlock
): ArtifactHtmlPreflightIssue | null {
  const aliases = getBatshitAliases(script.content)
  for (const alias of aliases) {
    const pattern =
      alias === 'window.batshit'
        ? /\bwindow\.batshit\.ai\.([A-Za-z_$][\w$]*)\b/
        : new RegExp(`\\b${escapeRegExp(alias)}\\.ai\\.([A-Za-z_$][\\w$]*)\\b`)
    const match = pattern.exec(script.content)
    if (!match) continue

    const method = match[1] ?? '*'
    const usedApi = `${alias}.ai.${method}`
    const line = script.startLine + countLinesBefore(script.content, match.index) - 1
    const replacement =
      method === 'generateImage'
        ? 'window.batshit.generateImage(prompt, options)'
        : 'the documented top-level window.batshit runtime methods'

    return {
      code: 'UNSUPPORTED_RUNTIME_API',
      message:
        `Inline script #${script.index} uses unsupported artifact runtime API "${usedApi}" at artifact line ${line}. ` +
        `There is no window.batshit.ai namespace; use ${replacement} instead.`,
      scriptIndex: script.index,
      line
    }
  }

  return null
}

export function validateArtifactHtmlPreflight(content: string | null | undefined): ArtifactHtmlPreflightResult {
  const normalizedContent = typeof content === 'string' ? content : ''
  const scripts = extractInlineScripts(normalizedContent)
  const issues: ArtifactHtmlPreflightIssue[] = []
  const advisories: ArtifactHtmlPreflightAdvisory[] = []
  let checkedScripts = 0
  let skippedScripts = 0

  for (const script of scripts) {
    if (!isClassicInlineScript(script.attrs)) {
      skippedScripts += 1
      continue
    }

    const trimmed = script.content.trim()
    if (!trimmed) continue

    checkedScripts += 1
    const filename = `artifact-inline-script-${script.index}.js`

    try {
      new Script(script.content, { filename })
    } catch (error) {
      const scriptLine = extractScriptLine(error, filename)
      const line = typeof scriptLine === 'number' ? script.startLine + scriptLine - 1 : undefined
      issues.push({
        code: 'INLINE_SCRIPT_SYNTAX_ERROR',
        message: buildSyntaxMessage(script.index, error, line),
        scriptIndex: script.index,
        line
      })
    }

    const escapedInterpolationLine = findEscapedInterpolationLine(script)
    if (escapedInterpolationLine !== undefined) {
      advisories.push({
        code: 'ESCAPED_TEMPLATE_LITERAL_INTERPOLATION',
        message:
          'Escaped template interpolation (`\\${...}`) was found inside an inline script. If this is meant to build a JavaScript template string, use `${...}` so the value actually interpolates.',
        scriptIndex: script.index,
        line: escapedInterpolationLine
      })
    }

    const unsupportedRuntimeApiIssue = findUnsupportedRuntimeApiIssue(script)
    if (unsupportedRuntimeApiIssue) {
      issues.push(unsupportedRuntimeApiIssue)
    }
  }

  return {
    ok: issues.length === 0,
    checkedScripts,
    skippedScripts,
    issues,
    advisories
  }
}

export function buildArtifactHtmlPreflightMessage(result: ArtifactHtmlPreflightResult): string {
  const lines = [
    'Artifact save blocked: artifact HTML preflight failed.',
    ...result.issues.map((issue) => `- ${issue.message}`),
    'Fix the artifact HTML, then run `sys.artifact.validate_structure` again before saving.'
  ]
  return lines.join('\n')
}
