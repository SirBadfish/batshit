/** Privacy-safe evidence for the Local AI context denominator, never credentials or URLs. */
export interface LocalContextBudgetEvidence {
  providerId: string
  modelId: string
  source: 'loaded' | 'requested' | 'preset' | 'unknown-until-loaded'
  checkedAt: number
  expiresAt: number
  note: string
}
