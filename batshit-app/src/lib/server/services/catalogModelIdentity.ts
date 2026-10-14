/**
 * BL-68: reviewed identity rules for the hosted model catalog.
 *
 * The catalog merges one model's rows from different sources into one row. Two
 * rows are the same model only when a rule here says so, in exact terms, for a
 * named connection. Nothing here is fuzzy matching, and every rule is pinned by
 * `catalogModelIdentity.test.ts`. Add a rule only with the provider's own
 * documentation behind it, and a test for the ids it must NOT touch.
 */

export type CatalogIdentityRule = 'anthropic-snapshot-date'

const ANTHROPIC_DIRECT_CONNECTION = 'direct:anthropic'
/** A trailing `-YYYYMMDD` snapshot date. */
const SNAPSHOT_DATE = /-((?:19|20)\d\d)(\d\d)(\d\d)$/
/** A trailing `-<major>-<minor>` version, which the gateway spells `-<major>.<minor>`. */
const TRAILING_VERSION = /-(\d+)-(\d+)$/

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Anthropic's own model list names each model by its dated snapshot
 * (`claude-haiku-4-5-20251001`); Anthropic documents the undated alias
 * (`claude-haiku-4-5`) as pointing at that snapshot, and the gateway and
 * OpenRouter list the same model under the alias in dotted form
 * (`anthropic/claude-haiku-4.5`). For Anthropic's direct connection only, a dated
 * id maps to that dotted alias, so the direct row merges into the priced one.
 *
 * Undated ids are left alone: the rows that merge today (Opus 4.6 and later)
 * keep merging exactly as they do. A preset still sends the dated id; this name
 * is only for matching.
 */
export function resolveReviewedCatalogIdentity(entry: {
  connectionId?: string | null
  name: string
}): { name: string; rule: CatalogIdentityRule } | null {
  if (entry.connectionId !== ANTHROPIC_DIRECT_CONNECTION) return null
  const name = entry.name.trim()
  if (!name.startsWith('claude-')) return null
  const date = SNAPSHOT_DATE.exec(name)
  if (!date) return null
  if (!isCalendarDate(Number(date[1]), Number(date[2]), Number(date[3]))) return null
  const alias = name.slice(0, date.index)
  return { name: alias.replace(TRAILING_VERSION, '-$1.$2'), rule: 'anthropic-snapshot-date' }
}

/**
 * OpenAI serves these only on its legacy `/v1/completions` endpoint. Batshit's
 * direct OpenAI connection speaks Chat Completions and Responses, so it cannot
 * run them, and the catalog must not offer them as chat models there.
 * OpenRouter serves `gpt-3.5-turbo-instruct` as chat, so its row stays.
 */
const OPENAI_COMPLETIONS_ONLY_MODEL_IDS: ReadonlySet<string> = new Set([
  'babbage-002',
  'davinci-002',
  'gpt-3.5-turbo-instruct',
  'gpt-3.5-turbo-instruct-0914'
])

export function isOpenAICompletionsOnlyModel(modelId: string): boolean {
  return OPENAI_COMPLETIONS_ONLY_MODEL_IDS.has(modelId.trim().toLowerCase())
}
