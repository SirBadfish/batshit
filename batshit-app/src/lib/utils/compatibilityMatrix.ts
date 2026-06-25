import type {
  CompatibilityConstraint,
  CompatibilityMatrixEntry,
  CompatibilityMatrixScope,
  MatrixConnectionId
} from '$lib/types/compatibilityMatrix'

function normalize(value?: string | null) {
  return value?.toLowerCase().trim() ?? ''
}

export function buildMatrixScope(options: {
  connection: MatrixConnectionId
  provider?: string | null
  model?: string | null
}): CompatibilityMatrixScope {
  return {
    connection: options.connection,
    provider: options.provider ?? undefined,
    model: options.model ?? undefined
  }
}

export function resolveMatrixFor(
  entries: CompatibilityMatrixEntry[],
  scope: CompatibilityMatrixScope
): CompatibilityMatrixEntry[] {
  const connection = normalize(scope.connection)
  const provider = normalize(scope.provider)
  const model = normalize(scope.model)

  const exact = entries.filter((entry) => {
    if (normalize(entry.scope.connection) !== connection) return false
    if (normalize(entry.scope.provider) !== provider) return false
    if (normalize(entry.scope.model) !== model) return false
    return Boolean(entry.scope.model)
  })

  const providerLevel = entries.filter((entry) => {
    if (normalize(entry.scope.connection) !== connection) return false
    if (normalize(entry.scope.provider) !== provider) return false
    return !entry.scope.model
  })

  const connectionLevel = entries.filter((entry) => {
    if (normalize(entry.scope.connection) !== connection) return false
    return !entry.scope.provider && !entry.scope.model
  })

  return [...exact, ...providerLevel, ...connectionLevel]
}

export function summarizeMatrixSupport(entries: CompatibilityMatrixEntry[]) {
  const allow = new Set<string>()
  const deny = new Map<string, string | null>()
  const constraints: Record<string, CompatibilityConstraint> = {}
  let hasAllow = false

  for (const entry of entries) {
    if (Array.isArray(entry.allow)) {
      hasAllow = true
      entry.allow.forEach((item) => allow.add(item))
    }
    if (entry.deny) {
      for (const [key, reason] of Object.entries(entry.deny)) {
        deny.set(key, reason ?? null)
      }
    }
    if (entry.constraints) {
      for (const [key, value] of Object.entries(entry.constraints)) {
        constraints[key] = {
          ...(constraints[key] ?? {}),
          ...(value ?? {})
        }
      }
    }
  }

  return { allow, deny, hasAllow, constraints }
}

export function isParameterAllowed(
  paramName: string,
  support: ReturnType<typeof summarizeMatrixSupport>
) {
  if (support.deny.has(paramName)) return false
  if (support.hasAllow) {
    return support.allow.has(paramName)
  }
  return true
}
