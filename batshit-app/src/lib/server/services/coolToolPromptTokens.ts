import {
  estimateCoolToolAiTokens,
  buildCoolToolAiContent,
  estimateMalformedCoolToolAiTokens,
  parseCoolToolPayload,
  shouldPreferRawSidecarForAiExpansion
} from '$lib/utils/coolToolAiContent'
import { isConcreteZipId } from '$lib/utils/zipReferenceSafety'
import { resolveToolResultPromptTokens } from '$lib/utils/toolResultSizeGuard'
import { createHash } from 'node:crypto'

type ZipDataLike = Record<string, any>

/** Canonical saved transcript with strict original-sidecar custody for persistent skill reads. */
export function originalCoolToolReadDigest(payload: Record<string, any>): string {
  // Bind original data/producer, independent of later cosmetic transcript formatting.
  return createHash('sha256').update(JSON.stringify({
    toolName: payload.originalToolName ?? payload.toolName, operationKind: payload.operationKind,
    toolProvider: payload.toolProvider, toolSource: payload.toolSource,
    utility: [payload.metadata?.apiUtilityControlId, payload.metadata?.apiUtilityRef],
    args: payload.toolArgs ?? payload.toolInput ?? payload.input,
    result: payload.toolResult ?? payload.observation ?? payload.result ?? payload.output
  })).digest('hex')
}

export async function readOriginalCoolToolEvidence(zipData: ZipDataLike, resolveZip: (zipId: string) => Promise<ZipDataLike | null>): Promise<{ text: string; digest: string }> {
  const main = parseCoolToolPayload(zipData.content)
  if (!main) throw new Error('The original tool-result payload is unreadable.')
  let payload = main
  if (shouldPreferRawSidecarForAiExpansion(main)) {
    const id = rawSidecarZipId(zipData, main)
    if (id) {
      const raw = await resolveZip(id)
      if (!raw || raw.type !== 'tool_raw' || raw.metadata?.sessionId !== zipData.metadata?.sessionId ||
          raw.metadata?.messageId !== zipData.metadata?.messageId) throw new Error('The original tool-result sidecar cannot be verified.')
      const parsed = parseCoolToolPayload(raw.content)
      if (!parsed) throw new Error('The original tool-result sidecar payload is unreadable.')
      payload = parsed
    } else if (main.rawSidecar?.status === 'stored' || main.storage?.truncated === true || main.metadata?.truncated === true) {
      throw new Error('The original tool-result sidecar is missing.')
    }
    // contentTruncated alone may mean a complete admitted window with more FILE text
    // after it. Without storage truncation or an advertised sidecar, main is that window.
  }
  return { text: buildCoolToolAiContent(zipData.id || '', zipData, payload), digest: originalCoolToolReadDigest(payload) }
}

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
