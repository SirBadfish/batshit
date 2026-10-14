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

/**
 * BL-285 (2026-09-27): a Worker's CLI runtime id, and so its managed profile folder
 * (`batshit_agent_subagent_cli-<slot>`). Workers used `buildCliSubagentRuntimeId` too, so a
 * Subagent slugged `worker_<agent>_<n>` shared that Worker slot's folder. The "-" is a
 * character no Subagent slug holds (the sanitizer folds it into "_"), and no Primary Agent id
 * may start with `subagent_cli` (`agentIdRules.ts`), so the folder is only ever this Worker
 * slot's. Worker slots are throwaway: each run prepares its profile again.
 */
export function buildCliWorkerRuntimeId(workerSlot: string): string {
  return `subagent_cli-${normalizeSubagentSlugValue(workerSlot, 'worker')}`
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
