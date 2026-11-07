/**
 * Runtime-scoped sections for admin-editable Batshit system prompts.
 *
 * Before SA-096 the packaged prompts listed every runtime's tool names, call shapes, and
 * examples at once, so an API agent was taught call shapes for managed CLI and n8n, and every
 * Bad/Good example used a tool name that agent did not have. Prompts mark sections that belong
 * to a single runtime and the compiler drops the rest.
 *
 * Syntax (HTML comments so the raw prompt still reads as valid Markdown in the Admin editor):
 *
 *   <!-- runtime:api -->
 *   ...content only API Primary Agents should see...
 *   <!-- /runtime -->
 *
 * Scope names are the user-facing primary-agent types, because that is the vocabulary the
 * Admin prompt editor and the product docs use. `api` is the one live scope. `cli` (the Claude
 * Code CLI Primary lane, removed in SA-139 R4) and `n8n` (SA-106) are retired: saved custom
 * prompts may still mark sections with them, so they parse, and their sections never compile.
 *
 * Parsing is strict on purpose. An unclosed block, a stray close marker, or an unknown scope
 * name throws instead of silently shipping the wrong content to a model. Per the Batshit
 * creed a bad admin edit should fail loudly rather than drift.
 */

export type PromptRuntimeScope = 'api'
type StoredPromptRuntimeScope = PromptRuntimeScope | 'cli' | 'n8n'

const VALID_SCOPES: readonly PromptRuntimeScope[] = ['api']
const RETIRED_SCOPES = ['cli', 'n8n'] as const
const ACCEPTED_STORED_SCOPES: readonly StoredPromptRuntimeScope[] = [
  ...VALID_SCOPES,
  ...RETIRED_SCOPES
]

const OPEN_MARKER = /^[ \t]*<!--[ \t]*runtime:([a-zA-Z0-9_,\s-]+?)[ \t]*-->[ \t]*$/
const CLOSE_MARKER = /^[ \t]*<!--[ \t]*\/runtime[ \t]*-->[ \t]*$/

function parseScopeList(raw: string, lineNumber: number): StoredPromptRuntimeScope[] {
  const parts = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)

  if (parts.length === 0) {
    throw new Error(
      `Prompt runtime scope marker on line ${lineNumber} lists no runtimes. ` +
        `Expected one or more of: ${VALID_SCOPES.join(', ')}.`
    )
  }

  for (const part of parts) {
    if (!ACCEPTED_STORED_SCOPES.includes(part as StoredPromptRuntimeScope)) {
      throw new Error(
        `Prompt runtime scope marker on line ${lineNumber} names an unknown runtime "${part}". ` +
          `Expected one or more of: ${ACCEPTED_STORED_SCOPES.join(', ')}.`
      )
    }
  }

  return parts as StoredPromptRuntimeScope[]
}

/**
 * Removes runtime-scoped sections that do not apply to the active runtime, and strips the
 * markers from sections that do apply. Prompts without any markers pass through untouched.
 *
 * Throws on malformed markers so a broken admin edit surfaces immediately.
 */
export function applyPromptRuntimeScope(prompt: string, scope: PromptRuntimeScope): string {
  if (!prompt) return prompt
  if (!prompt.includes('<!--')) return prompt

  const lines = prompt.split('\n')
  const kept: string[] = []

  let openScopes: StoredPromptRuntimeScope[] | null = null
  let openLineNumber = 0
  let keepingCurrentBlock = false
  // Set when a non-matching block was just dropped. Dropping a block leaves the blank line
  // above it adjacent to the blank line below it, so exactly one of those is absorbed at the
  // seam. Blank lines elsewhere are left alone — a blanket collapse would also rewrite blank
  // lines inside fenced code blocks, which are author content.
  let justDroppedBlock = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const lineNumber = index + 1

    const openMatch = line.match(OPEN_MARKER)
    if (openMatch) {
      if (openScopes) {
        throw new Error(
          `Prompt runtime scope marker on line ${lineNumber} opens while the block from ` +
            `line ${openLineNumber} is still open. Nested runtime blocks are not supported.`
        )
      }
      openScopes = parseScopeList(openMatch[1], lineNumber)
      openLineNumber = lineNumber
      keepingCurrentBlock = openScopes.includes(scope)
      continue
    }

    if (CLOSE_MARKER.test(line)) {
      if (!openScopes) {
        throw new Error(
          `Prompt runtime scope close marker on line ${lineNumber} has no matching open marker.`
        )
      }
      justDroppedBlock = !keepingCurrentBlock
      openScopes = null
      keepingCurrentBlock = false
      continue
    }

    if (openScopes && !keepingCurrentBlock) continue

    if (justDroppedBlock) {
      justDroppedBlock = false
      const isBlank = line.trim().length === 0
      const lastKeptIsBlank = kept.length > 0 && kept[kept.length - 1].trim().length === 0
      if (isBlank && lastKeptIsBlank) continue
    }

    kept.push(line)
  }

  if (openScopes) {
    throw new Error(
      `Prompt runtime scope block opened on line ${openLineNumber} is never closed. ` +
        `Add a <!-- /runtime --> marker.`
    )
  }

  return kept.join('\n')
}

const SESSION_OPEN_MARKER = /^[ \t]*<!--[ \t]*session:([a-zA-Z0-9_-]+)[ \t]*-->[ \t]*$/
const SESSION_CLOSE_MARKER = /^[ \t]*<!--[ \t]*\/session[ \t]*-->[ \t]*$/
const VALID_SESSION_KINDS = ['infinite'] as const

/**
 * Session-scoped sections (decision 11, 2026-10-24): text marked
 *
 *   <!-- session:infinite -->
 *   ...content only an Infinite Session should see...
 *   <!-- /session -->
 *
 * is kept (markers stripped) in an Infinite Session and dropped everywhere else. It is a
 * separate marker kind from `runtime:`, so a runtime block may sit inside a session block;
 * run this pass first, then `applyPromptRuntimeScope`. Parsing is strict for the same reason
 * as the runtime pass: a bad Admin edit throws instead of shipping the wrong text.
 */
export function applyPromptSessionScope(
  prompt: string,
  session: { infiniteSession: boolean }
): string {
  if (!prompt) return prompt
  if (!prompt.includes('<!--')) return prompt

  const lines = prompt.split('\n')
  const kept: string[] = []

  let openLineNumber = 0
  let keepingCurrentBlock = false
  // The same one-blank-line seam rule as the runtime pass.
  let justDroppedBlock = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const lineNumber = index + 1

    const openMatch = line.match(SESSION_OPEN_MARKER)
    if (openMatch) {
      if (openLineNumber) {
        throw new Error(
          `Prompt session scope marker on line ${lineNumber} opens while the block from ` +
            `line ${openLineNumber} is still open. Nested session blocks are not supported.`
        )
      }
      const kind = openMatch[1].toLowerCase()
      if (!(VALID_SESSION_KINDS as readonly string[]).includes(kind)) {
        throw new Error(
          `Prompt session scope marker on line ${lineNumber} names an unknown session kind "${kind}". ` +
            `Expected one of: ${VALID_SESSION_KINDS.join(', ')}.`
        )
      }
      openLineNumber = lineNumber
      keepingCurrentBlock = session.infiniteSession
      continue
    }

    if (SESSION_CLOSE_MARKER.test(line)) {
      if (!openLineNumber) {
        throw new Error(
          `Prompt session scope close marker on line ${lineNumber} has no matching open marker.`
        )
      }
      justDroppedBlock = !keepingCurrentBlock
      openLineNumber = 0
      keepingCurrentBlock = false
      continue
    }

    if (openLineNumber && !keepingCurrentBlock) continue

    if (justDroppedBlock) {
      justDroppedBlock = false
      const isBlank = line.trim().length === 0
      const lastKeptIsBlank = kept.length > 0 && kept[kept.length - 1].trim().length === 0
      if (isBlank && lastKeptIsBlank) continue
    }

    kept.push(line)
  }

  if (openLineNumber) {
    throw new Error(
      `Prompt session scope block opened on line ${openLineNumber} is never closed. ` +
        `Add a <!-- /session --> marker.`
    )
  }

  return kept.join('\n')
}

/**
 * Model-facing broker tool names for a runtime: API agents get the `native_`-prefixed Vercel AI
 * SDK tools.
 */
export function brokerToolNamesForScope(scope: PromptRuntimeScope): {
  search: string
  use: string
} {
  switch (scope) {
    case 'api':
      return { search: 'native_batshit_tool_search', use: 'native_batshit_tool_use' }
  }
}
