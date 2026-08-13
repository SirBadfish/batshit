/**
 * Runtime-scoped sections for admin-editable Batshit system prompts.
 *
 * Batshit compiles one prompt body for three primary-agent runtimes. Before SA-096 the
 * packaged prompts listed every runtime's tool names, call shapes, and examples at once,
 * so an API agent was taught call shapes for managed CLI and n8n, and every Bad/Good
 * example used a tool name that agent did not have.
 *
 * `runtimeFlavor` is already known at compile time, so prompts can mark sections that
 * belong to a single runtime and let the compiler drop the rest.
 *
 * Syntax (HTML comments so the raw prompt still reads as valid Markdown in the Admin editor):
 *
 *   <!-- runtime:api -->
 *   ...content only API Primary Agents should see...
 *   <!-- /runtime -->
 *
 *   <!-- runtime:cli,n8n -->
 *   ...content shared by managed CLI and n8n agents...
 *   <!-- /runtime -->
 *
 * Scope names are the user-facing primary-agent types (`api`, `cli`, `n8n`), not the
 * internal runtime flavors, because that is the vocabulary the Admin prompt editor and the
 * product docs use.
 *
 * Parsing is strict on purpose. An unclosed block, a stray close marker, or an unknown scope
 * name throws instead of silently shipping the wrong content to a model. Per the Batshit
 * creed a bad admin edit should fail loudly rather than drift.
 */

export type PromptRuntimeScope = 'api' | 'cli' | 'n8n'

export type PromptRuntimeFlavor = 'codex' | 'claude' | 'vercel' | 'n8n'

const VALID_SCOPES: readonly PromptRuntimeScope[] = ['api', 'cli', 'n8n']

const OPEN_MARKER = /^[ \t]*<!--[ \t]*runtime:([a-zA-Z0-9_,\s-]+?)[ \t]*-->[ \t]*$/
const CLOSE_MARKER = /^[ \t]*<!--[ \t]*\/runtime[ \t]*-->[ \t]*$/

/**
 * Maps an internal runtime flavor to the user-facing primary-agent type used in prompt scopes.
 * `vercel` is the API/direct Vercel AI SDK lane; `codex` and `claude` are both managed CLI.
 */
export function runtimeFlavorToScope(runtimeFlavor: PromptRuntimeFlavor): PromptRuntimeScope {
  if (runtimeFlavor === 'n8n') return 'n8n'
  if (runtimeFlavor === 'vercel') return 'api'
  return 'cli'
}

function parseScopeList(raw: string, lineNumber: number): PromptRuntimeScope[] {
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
    if (!VALID_SCOPES.includes(part as PromptRuntimeScope)) {
      throw new Error(
        `Prompt runtime scope marker on line ${lineNumber} names an unknown runtime "${part}". ` +
          `Expected one or more of: ${VALID_SCOPES.join(', ')}.`
      )
    }
  }

  return parts as PromptRuntimeScope[]
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

  let openScopes: PromptRuntimeScope[] | null = null
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

/**
 * Model-facing broker tool names for a runtime. API agents get the `native_`-prefixed Vercel
 * AI SDK tools; managed CLI and n8n agents get the bridge/node names.
 */
export function brokerToolNamesForScope(scope: PromptRuntimeScope): {
  search: string
  use: string
} {
  if (scope === 'api') {
    return { search: 'native_batshit_tool_search', use: 'native_batshit_tool_use' }
  }
  return { search: 'batshit_tool_search', use: 'batshit_tool_use' }
}
