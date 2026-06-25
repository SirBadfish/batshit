export const PROJECT_SECURITY_EXCLUSIONS = [
  '**/.git/**',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.crt',
  '**/*.p12',
  '**/id_rsa*',
  '**/id_dsa*',
  '**/id_ecdsa*',
  '**/id_ed25519*',
  '**/.ssh/**',
  '**/secrets/**',
  '**/credentials/**',
  '**/.aws/**',
  '**/.kube/**',
  '**/docker-compose.override.yml'
] as const

export const PROJECT_DEFAULT_EXCLUSIONS = [
  '**/node_modules/**',
  '**/.venv/**',
  '**/venv/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.cache/**',
  '**/*.log',
  '**/__pycache__/**',
  '**/.DS_Store',
  '**/target/**',
  '**/bin/**',
  '**/obj/**',
  '**/*.class',
  '**/*.pyc'
] as const

const LEGACY_ENABLED_DEFAULT_EXCLUSIONS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.cache/**',
  '**/*.log',
  '**/__pycache__/**',
  '**/.DS_Store',
  '**/target/**',
  '**/bin/**',
  '**/obj/**',
  '**/*.class',
  '**/*.pyc'
] as const

const LEGACY_EXCLUSION_NORMALIZATION_MAP = new Map<string, string>([
  ['.git/**', '**/.git/**'],
  ['.env', '**/.env'],
  ['.env.*', '**/.env.*'],
  ['node_modules/**', '**/node_modules/**'],
  ['dist/**', '**/dist/**'],
  ['build/**', '**/build/**'],
  ['coverage/**', '**/coverage/**'],
  ['.next/**', '**/.next/**'],
  ['.nuxt/**', '**/.nuxt/**'],
  ['.cache/**', '**/.cache/**'],
  ['*.log', '**/*.log']
])

export function normalizeProjectExclusions(patterns: string[] | null | undefined): string[] {
  if (!Array.isArray(patterns)) return []

  const normalized = new Set<string>()
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue
    const trimmed = pattern.trim()
    if (!trimmed) continue
    normalized.add(LEGACY_EXCLUSION_NORMALIZATION_MAP.get(trimmed) ?? trimmed)
  }

  const looksLikeDefaultsEnabled = LEGACY_ENABLED_DEFAULT_EXCLUSIONS.every((pattern) =>
    normalized.has(pattern)
  )
  if (looksLikeDefaultsEnabled) {
    for (const pattern of PROJECT_DEFAULT_EXCLUSIONS) {
      normalized.add(pattern)
    }
  }

  return Array.from(normalized)
}
