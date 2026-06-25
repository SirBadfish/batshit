// Token counting utilities

/**
 * Estimates token count for a given text
 * Uses the rough approximation of 1 token ≈ 4 characters
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Format token count for display
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) {
    return tokens.toString()
  } else if (tokens < 1000000) {
    return `${(tokens / 1000).toFixed(1)}k`
  } else {
    return `${(tokens / 1000000).toFixed(2)}M`
  }
}

/**
 * Calculate token cost based on model pricing
 */
export function calculateCost(tokens: number, pricePerMillion: number): number {
  return (tokens / 1000000) * pricePerMillion
}

/**
 * Format cost for display
 */
export function formatCost(cost: number): string {
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`
  } else if (cost < 1) {
    return `$${cost.toFixed(3)}`
  } else {
    return `$${cost.toFixed(2)}`
  }
}