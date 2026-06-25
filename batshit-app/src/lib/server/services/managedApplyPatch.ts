export const APPLY_PATCH_BEGIN_MARKER = '*** Begin Patch'
export const APPLY_PATCH_END_MARKER = '*** End Patch'
export const APPLY_PATCH_UPDATE_PREFIX = '*** Update File: '
export const APPLY_PATCH_ADD_PREFIX = '*** Add File: '
export const APPLY_PATCH_DELETE_PREFIX = '*** Delete File: '
export const APPLY_PATCH_MOVE_PREFIX = '*** Move to: '

export type ManagedApplyPatchLineType = 'context' | 'add' | 'remove'

export interface ManagedApplyPatchHunkLine {
  type: ManagedApplyPatchLineType
  text: string
  sourceText?: string
}

export interface ManagedApplyPatchHunk {
  header: string
  lines: ManagedApplyPatchHunkLine[]
}

export interface ManagedApplyPatchUpdateOperation {
  type: 'update'
  filePath: string
  moveToPath: string | null
  hunks: ManagedApplyPatchHunk[]
}

export interface ManagedApplyPatchAddOperation {
  type: 'add'
  filePath: string
  contentLines: string[]
}

export interface ManagedApplyPatchDeleteOperation {
  type: 'delete'
  filePath: string
}

export type ManagedApplyPatchOperation =
  | ManagedApplyPatchUpdateOperation
  | ManagedApplyPatchAddOperation
  | ManagedApplyPatchDeleteOperation

export type ManagedApplyPatchParseResult =
  | {
      success: true
      operations: ManagedApplyPatchOperation[]
      touchedPaths: string[]
    }
  | {
      success: false
      operations: []
      touchedPaths: []
      message: string
    }

function normalizeManagedPatchInput(value: string): string {
  return value.replace(/\r\n/g, '\n')
}

export function isManagedApplyPatchCommand(command: string): boolean {
  const normalized = normalizeManagedPatchInput(command)
  return normalized.split('\n').some((line) =>
    /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*apply_patch\b/i.test(line)
  )
}

export function extractManagedApplyPatchPayload(source: string): string | null {
  const normalized = normalizeManagedPatchInput(source)
  const beginIndex = normalized.indexOf(APPLY_PATCH_BEGIN_MARKER)
  const endIndex = normalized.lastIndexOf(APPLY_PATCH_END_MARKER)
  if (beginIndex < 0 || endIndex < beginIndex) return null
  return normalized.slice(beginIndex, endIndex + APPLY_PATCH_END_MARKER.length)
}

export function extractManagedApplyPatchDocument(command: string): string | null {
  const normalized = normalizeManagedPatchInput(command)
  if (!isManagedApplyPatchCommand(normalized)) return null
  return extractManagedApplyPatchPayload(normalized)
}

function parseManagedApplyPatchPath(line: string, prefix: string): string | null {
  if (!line.startsWith(prefix)) return null
  const rawPath = line.slice(prefix.length).trim()
  if (!rawPath) return null
  return rawPath.replace(/^['"]|['"]$/g, '')
}

function isManagedApplyPatchOpStart(line: string): boolean {
  return (
    line.startsWith(APPLY_PATCH_UPDATE_PREFIX) ||
    line.startsWith(APPLY_PATCH_ADD_PREFIX) ||
    line.startsWith(APPLY_PATCH_DELETE_PREFIX)
  )
}

export function parseManagedApplyPatchDocument(document: string): ManagedApplyPatchParseResult {
  const normalized = normalizeManagedPatchInput(document)
  const lines = normalized.split('\n')
  if (lines.length < 2) {
    return {
      success: false,
      operations: [],
      touchedPaths: [],
      message: 'apply_patch payload is incomplete.'
    }
  }

  if (lines[0].trim() !== APPLY_PATCH_BEGIN_MARKER) {
    return {
      success: false,
      operations: [],
      touchedPaths: [],
      message: 'apply_patch payload must start with "*** Begin Patch".'
    }
  }

  if (lines[lines.length - 1].trim() !== APPLY_PATCH_END_MARKER) {
    return {
      success: false,
      operations: [],
      touchedPaths: [],
      message: 'apply_patch payload must end with "*** End Patch".'
    }
  }

  const operations: ManagedApplyPatchOperation[] = []
  let index = 1
  const lastContentIndex = lines.length - 1

  while (index < lastContentIndex) {
    const current = lines[index]
    if (!current || current.trim().length === 0) {
      index += 1
      continue
    }

    if (current.startsWith(APPLY_PATCH_UPDATE_PREFIX)) {
      const filePath = parseManagedApplyPatchPath(current, APPLY_PATCH_UPDATE_PREFIX)
      if (!filePath) {
        return {
          success: false,
          operations: [],
          touchedPaths: [],
          message: 'Invalid "*** Update File" path in apply_patch payload.'
        }
      }

      index += 1
      let moveToPath: string | null = null
      if (index < lastContentIndex && lines[index].startsWith(APPLY_PATCH_MOVE_PREFIX)) {
        moveToPath = parseManagedApplyPatchPath(lines[index], APPLY_PATCH_MOVE_PREFIX)
        if (!moveToPath) {
          return {
            success: false,
            operations: [],
            touchedPaths: [],
            message: 'Invalid "*** Move to" path in apply_patch payload.'
          }
        }
        index += 1
      }

      const hunks: ManagedApplyPatchHunk[] = []
      while (index < lastContentIndex) {
        const line = lines[index]
        if (isManagedApplyPatchOpStart(line)) break
        if (line.startsWith('@@')) {
          const header = line
          index += 1
          const hunkLines: ManagedApplyPatchHunkLine[] = []

          while (index < lastContentIndex) {
            const bodyLine = lines[index]
            if (bodyLine.startsWith('@@') || isManagedApplyPatchOpStart(bodyLine)) break
            if (bodyLine === '*** End of File' || bodyLine === '\\ No newline at end of file') {
              index += 1
              continue
            }

            const prefix = bodyLine.charAt(0)
            const text = bodyLine.slice(1)
            if (prefix === ' ') {
              hunkLines.push({ type: 'context', text, sourceText: bodyLine })
            } else if (prefix === '+') {
              hunkLines.push({ type: 'add', text })
            } else if (prefix === '-') {
              hunkLines.push({ type: 'remove', text })
            } else {
              hunkLines.push({ type: 'context', text: bodyLine, sourceText: bodyLine })
            }
            index += 1
          }

          hunks.push({ header, lines: hunkLines })
          continue
        }

        if (line === '*** End of File') {
          index += 1
          continue
        }

        return {
          success: false,
          operations: [],
          touchedPaths: [],
          message: `Unexpected line in "*** Update File" section: "${line}".`
        }
      }

      if (hunks.length === 0 && !moveToPath) {
        return {
          success: false,
          operations: [],
          touchedPaths: [],
          message:
            'apply_patch update operation requires at least one hunk or a "*** Move to" path.'
        }
      }

      operations.push({
        type: 'update',
        filePath,
        moveToPath,
        hunks
      })
      continue
    }

    if (current.startsWith(APPLY_PATCH_ADD_PREFIX)) {
      const filePath = parseManagedApplyPatchPath(current, APPLY_PATCH_ADD_PREFIX)
      if (!filePath) {
        return {
          success: false,
          operations: [],
          touchedPaths: [],
          message: 'Invalid "*** Add File" path in apply_patch payload.'
        }
      }

      index += 1
      const contentLines: string[] = []
      while (index < lastContentIndex && !isManagedApplyPatchOpStart(lines[index])) {
        const line = lines[index]
        if (line === '*** End of File') {
          index += 1
          continue
        }
        if (!line.startsWith('+')) {
          return {
            success: false,
            operations: [],
            touchedPaths: [],
            message: `Invalid line in "*** Add File" section: "${line}".`
          }
        }
        contentLines.push(line.slice(1))
        index += 1
      }

      operations.push({
        type: 'add',
        filePath,
        contentLines
      })
      continue
    }

    if (current.startsWith(APPLY_PATCH_DELETE_PREFIX)) {
      const filePath = parseManagedApplyPatchPath(current, APPLY_PATCH_DELETE_PREFIX)
      if (!filePath) {
        return {
          success: false,
          operations: [],
          touchedPaths: [],
          message: 'Invalid "*** Delete File" path in apply_patch payload.'
        }
      }

      index += 1
      while (index < lastContentIndex && !isManagedApplyPatchOpStart(lines[index])) {
        const line = lines[index]
        if (!line || line.trim().length === 0 || line === '*** End of File') {
          index += 1
          continue
        }
        return {
          success: false,
          operations: [],
          touchedPaths: [],
          message: `Unexpected content in "*** Delete File" section: "${line}".`
        }
      }

      operations.push({
        type: 'delete',
        filePath
      })
      continue
    }

    return {
      success: false,
      operations: [],
      touchedPaths: [],
      message: `Unexpected apply_patch line: "${current}".`
    }
  }

  if (operations.length === 0) {
    return {
      success: false,
      operations: [],
      touchedPaths: [],
      message: 'apply_patch payload did not include any operations.'
    }
  }

  const touchedPaths = Array.from(
    new Set(
      operations.flatMap((operation) =>
        operation.type === 'update' && operation.moveToPath
          ? [operation.filePath, operation.moveToPath]
          : [operation.filePath]
      )
    )
  )

  return {
    success: true,
    operations,
    touchedPaths
  }
}

function splitManagedPatchText(
  content: string
): { lines: string[]; hasTrailingNewline: boolean } {
  const normalized = normalizeManagedPatchInput(content)
  if (normalized.length === 0) {
    return {
      lines: [],
      hasTrailingNewline: false
    }
  }

  const hasTrailingNewline = normalized.endsWith('\n')
  const lines = normalized.split('\n')
  if (hasTrailingNewline) lines.pop()
  return {
    lines,
    hasTrailingNewline
  }
}

function joinManagedPatchLines(lines: string[], hasTrailingNewline: boolean): string {
  if (lines.length === 0) return ''
  const joined = lines.join('\n')
  return hasTrailingNewline ? `${joined}\n` : joined
}

function findManagedPatchSequence(
  source: string[],
  target: string[],
  startIndex: number
): number {
  if (target.length === 0) return Math.min(startIndex, source.length)
  const maxStart = source.length - target.length
  for (let index = Math.max(0, startIndex); index <= maxStart; index += 1) {
    let matched = true
    for (let offset = 0; offset < target.length; offset += 1) {
      if (source[index + offset] !== target[offset]) {
        matched = false
        break
      }
    }
    if (matched) return index
  }
  return -1
}

function buildManagedPatchCandidate(hunk: ManagedApplyPatchHunk, useSourceText: boolean): {
  sourcePattern: string[]
  replacement: string[]
} {
  const textForLine = (line: ManagedApplyPatchHunkLine): string =>
    useSourceText && line.type === 'context'
      ? line.sourceText ?? line.text
      : line.text

  return {
    sourcePattern: hunk.lines
      .filter((line) => line.type !== 'add')
      .map((line) => textForLine(line)),
    replacement: hunk.lines
      .filter((line) => line.type !== 'remove')
      .map((line) => textForLine(line))
  }
}

function buildManagedPatchCandidates(hunk: ManagedApplyPatchHunk): Array<{
  sourcePattern: string[]
  replacement: string[]
}> {
  const strict = buildManagedPatchCandidate(hunk, false)
  const copiedContext = buildManagedPatchCandidate(hunk, true)

  if (
    strict.sourcePattern.length === copiedContext.sourcePattern.length &&
    strict.replacement.length === copiedContext.replacement.length &&
    strict.sourcePattern.every((line, index) => line === copiedContext.sourcePattern[index]) &&
    strict.replacement.every((line, index) => line === copiedContext.replacement[index])
  ) {
    return [strict]
  }

  return [strict, copiedContext]
}

export function applyManagedPatchHunks(options: {
  content: string
  hunks: ManagedApplyPatchHunk[]
  filePath: string
}): string {
  const parsed = splitManagedPatchText(options.content)
  const lines = parsed.lines.slice()
  let cursor = 0

  for (const hunk of options.hunks) {
    const candidates = buildManagedPatchCandidates(hunk)
    let match:
      | {
          targetIndex: number
          sourcePattern: string[]
          replacement: string[]
        }
      | null = null

    for (const candidate of candidates) {
      let targetIndex = findManagedPatchSequence(lines, candidate.sourcePattern, cursor)
      if (targetIndex < 0) {
        targetIndex = findManagedPatchSequence(lines, candidate.sourcePattern, 0)
      }
      if (targetIndex >= 0) {
        match = {
          targetIndex,
          sourcePattern: candidate.sourcePattern,
          replacement: candidate.replacement
        }
        break
      }
    }

    if (!match) {
      throw new Error(
        `Failed to apply hunk "${hunk.header}" in ${options.filePath}: context did not match.`
      )
    }

    lines.splice(match.targetIndex, match.sourcePattern.length, ...match.replacement)
    cursor = match.targetIndex + match.replacement.length
  }

  return joinManagedPatchLines(lines, parsed.hasTrailingNewline)
}
