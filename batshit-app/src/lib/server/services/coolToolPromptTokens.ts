import {
  estimateCoolToolAiTokens,
  estimateMalformedCoolToolAiTokens,
  parseCoolToolPayload,
  shouldPreferRawSidecarForAiExpansion
} from '$lib/utils/coolToolAiContent'
import { isConcreteZipId } from '$lib/utils/zipReferenceSafety'
import { resolveToolResultPromptTokens } from '$lib/utils/toolResultSizeGuard'

type ZipDataLike = Record<string, any>

function coercePositiveNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.ceil(value)
}

function rawSidecarZipId(zipData: ZipDataLike, payload: Record<string, any> | null): string | null {
  const candidates = [
    zipData.metadata?.rawSidecarZipId,
    payload?.rawSidecar?.zipId,
    payload?.metadata?.rawSidecarZipId
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && isConcreteZipId(candidate)) return candidate
  }

  return null
}

function storageTokens(zipData: ZipDataLike): number {
  return (
    coercePositiveNumber(zipData.metadata?.storageTokens) ??
    coercePositiveNumber(zipData.tokens) ??
    (typeof zipData.content === 'string' ? Math.ceil(zipData.content.length / 4) : 0)
  )
}

export async function enrichCoolToolPromptTokens(
  zipData: ZipDataLike,
  resolveZip: (zipId: string) => Promise<ZipDataLike | null | undefined>
): Promise<ZipDataLike> {
  if (!zipData || zipData.type !== 'cool_tool') return zipData

  const existing = resolveToolResultPromptTokens(zipData)
  if (existing !== null) return zipData

  const mainPayload = parseCoolToolPayload(zipData.content)
  let payloadContent = zipData.content

  const sidecarId = rawSidecarZipId(zipData, mainPayload)
  if (sidecarId && shouldPreferRawSidecarForAiExpansion(mainPayload)) {
    const rawZip = await resolveZip(sidecarId).catch(() => null)
    if (rawZip?.type === 'tool_raw' && typeof rawZip.content === 'string') {
      payloadContent = rawZip.content
    }
  }

  const promptPayload = parseCoolToolPayload(payloadContent)
  if (!promptPayload && typeof payloadContent !== 'string') return zipData

  const promptTokens = promptPayload
    ? estimateCoolToolAiTokens(zipData.id || '', zipData, promptPayload)
    : estimateMalformedCoolToolAiTokens(zipData.id || '', payloadContent)

  return {
    ...zipData,
    tokens: promptTokens,
    metadata: {
      ...(zipData.metadata || {}),
      tokens: promptTokens,
      promptTokens,
      aiTokens: promptTokens,
      tokenBasis: 'ai_expanded',
      storageTokens: storageTokens(zipData),
      storageChars:
        typeof zipData.metadata?.storageChars === 'number'
          ? zipData.metadata.storageChars
          : typeof zipData.content === 'string'
            ? zipData.content.length
            : undefined
    }
  }
}
