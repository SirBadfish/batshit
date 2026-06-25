import { sanitizeId } from './idSanitizer'

export type SubagentSlugRecord = {
  slug?: string | null
  id?: string | null
  displayName?: string | null
  display_name?: string | null
  name?: string | null
  description?: string | null
}

export function normalizeSubagentSlugValue(value: unknown, fallback = 'subagent'): string {
  const source = typeof value === 'string' ? value.trim() : ''
  return sanitizeId(source || fallback) || fallback
}

export function resolveSubagentSlug(
  subagent: SubagentSlugRecord | null | undefined,
  fallback = 'subagent'
): string {
  return normalizeSubagentSlugValue(
    subagent?.slug ??
      subagent?.id ??
      subagent?.displayName ??
      subagent?.display_name ??
      subagent?.name ??
      subagent?.description ??
      fallback,
    fallback
  )
}

export function buildCliSubagentRuntimeId(subagentSlug: string): string {
  return `subagent_cli_${normalizeSubagentSlugValue(subagentSlug)}`
}

export function buildSubagentSlugCollisionError(
  slug: string,
  firstLabel: string,
  secondLabel: string
): Error {
  return new Error(
    `Subagent slug '${slug}' is already taken by '${firstLabel}' and '${secondLabel}'. Choose another subagent slug or delete/rename the original.`
  )
}
