/** BL-494: prompt transcript sizes, never renderer/storage JSON sizes. */
export const TOOL_RESULT_LARGE_TOKENS = 10_000
export const TOOL_RESULT_TOO_LARGE_TOKENS = 25_000

export type ToolResultSizeGuard = 'too_large' | 'large' | null

/** Known prompt estimates only. Zero/invalid legacy estimates need transcript enrichment. */
export function resolveToolResultPromptTokens(zipData: any): number | null {
  const candidates = [
    zipData?.promptTokens,
    zipData?.aiTokens,
    zipData?.metadata?.promptTokens,
    zipData?.metadata?.aiTokens,
    ...(zipData?.metadata?.tokenBasis === 'ai_expanded'
      ? [zipData?.tokens, zipData?.metadata?.tokens]
      : [])
  ]
  return candidates.find((value) => typeof value === 'number' && Number.isFinite(value) && value > 0) ?? null
}

export function classifyToolResultSize(tokens: number): ToolResultSizeGuard {
  return tokens >= TOOL_RESULT_TOO_LARGE_TOKENS ? 'too_large'
    : tokens >= TOOL_RESULT_LARGE_TOKENS ? 'large' : null
}

export const TOOL_RESULT_SIZE_REASON_TEXT = {
  too_large: 'too large to open: fetch it in parts',
  large: 'large: hold it or fetch it'
} as const

export function describeTooLargeToolResult(tokens: number): string {
  return `Too large for the prompt (about ${Math.ceil(tokens).toLocaleString('en-US')} tokens). The agent reads it in parts.`
}
