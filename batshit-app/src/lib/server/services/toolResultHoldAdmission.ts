import { redis } from '$lib/server/redis'
import { classifyToolResultSize, resolveToolResultPromptTokens } from '$lib/utils/toolResultSizeGuard'
import { enrichCoolToolPromptTokens } from './coolToolPromptTokens'

/** The Hold guard measures the expanded model transcript, never the stored renderer JSON. */
export async function tooLargeCoolToolHoldTokens(zipData: any): Promise<number | null> {
  if (zipData?.type !== 'cool_tool') return null
  const enriched = await enrichCoolToolPromptTokens(zipData, (zipId) => redis.getZip(zipId))
  const tokens = resolveToolResultPromptTokens(enriched)
  return tokens !== null && classifyToolResultSize(tokens) === 'too_large' ? tokens : null
}
