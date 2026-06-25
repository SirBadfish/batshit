export type MatrixConnectionId = 'direct' | 'openrouter' | 'vercel-gateway' | 'n8n'

export interface CompatibilityConstraint {
  min?: number
  max?: number
  allowed?: string[]
  note?: string
}

export interface CompatibilityMatrixScope {
  connection: MatrixConnectionId
  provider?: string
  model?: string
}

export interface CompatibilityMatrixEntry {
  scope: CompatibilityMatrixScope
  allow?: string[]
  deny?: Record<string, string | null>
  constraints?: Record<string, CompatibilityConstraint>
}

export interface CompatibilityMatrixSnapshot {
  version: number
  fetchedAt: string
  entries: CompatibilityMatrixEntry[]
}
