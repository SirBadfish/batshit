export const DEFAULT_CONTEXT_GUARD_THRESHOLD = 0.8
export const CONTEXT_GUARD_CLASSIFIER_MARKER = 'Batshit context guard'

const DISABLED_VALUES = new Set(['off', 'false', 'disabled', 'none', '0'])

/** Shared policy parser for every managed CLI context guard. */
export function resolveManagedContextGuardThreshold(
  env: NodeJS.ProcessEnv,
  variableName: string,
): number | null {
  const raw = (env[variableName] ?? '').trim().toLowerCase()
  if (!raw) return DEFAULT_CONTEXT_GUARD_THRESHOLD
  if (DISABLED_VALUES.has(raw)) return null

  const parsed = Number(raw)
  if (Number.isFinite(parsed) && parsed >= 0.5 && parsed < 1) return parsed

  throw new Error(
    `${variableName} must be a number from 0.5 (inclusive) to 1 (exclusive), or one of: off, false, disabled, none, 0. Received ${JSON.stringify(raw)}.`,
  )
}
