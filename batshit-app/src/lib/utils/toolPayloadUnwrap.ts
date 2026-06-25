import {
  isDynamicMcpUseToolName
} from './toolNameNormalization'

export type DynamicMcpUnwrapResult = {
  toolName: string
  params?: Record<string, any> | null
  result?: unknown
  executionTimeMs?: number
}

export type DynamicMcpStepUnwrapResult = DynamicMcpUnwrapResult & {
  wrapperToolName: string
}

export function parseJsonIfLikely(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

export function unwrapToolTextArray(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  const textItems = value.every(
    (item) => item && typeof item === 'object' && 'text' in item
  )
  if (!textItems) return value
  const joined = value
    .map((item: any) => (typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n')
  if (!joined) return value
  return parseJsonIfLikely(joined)
}

const DEFAULT_SINGLE_PROPERTY_KEYS = ['result', 'output', 'content'] as const

export function numericKeyObjectToArray(value: unknown): unknown {
  if (!value || Array.isArray(value) || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const numericKeys = Object.keys(record).filter((key) => /^\d+$/.test(key))
  if (numericKeys.length === 0) return value
  return numericKeys.sort((a, b) => Number(a) - Number(b)).map((key) => record[key])
}

export function unwrapSinglePropertyRecord(
  value: unknown,
  keys: readonly string[] = DEFAULT_SINGLE_PROPERTY_KEYS
): unknown {
  if (!value || Array.isArray(value) || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 1) return value
  for (const key of keys) {
    if (key in record) return record[key]
  }
  return value
}

export function normalizeToolPayload(
  value: unknown,
  options?: {
    numericKeyObjects?: boolean
    textArrays?: boolean
    singlePropertyKeys?: readonly string[] | false
  }
): unknown {
  let normalized = parseJsonIfLikely(value)

  if (options?.numericKeyObjects !== false) {
    normalized = numericKeyObjectToArray(normalized)
  }

  if (options?.textArrays !== false) {
    normalized = unwrapToolTextArray(normalized)
  }

  if (options?.singlePropertyKeys !== false) {
    normalized = unwrapSinglePropertyRecord(
      normalized,
      options?.singlePropertyKeys ?? DEFAULT_SINGLE_PROPERTY_KEYS
    )
  }

  return normalized
}

export function unwrapStructuredToolValue(value: unknown): unknown {
  if (!value) return value
  const parsed = parseJsonIfLikely(value)

  if (Array.isArray(parsed) && parsed.length === 1) {
    const first = parsed[0] as any
    if (typeof first === 'string') return unwrapStructuredToolValue(first)
    if (first?.text) return unwrapStructuredToolValue(first.text)
  }

  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, any>
    if (record.result) return unwrapStructuredToolValue(record.result)
    if (record.output) return unwrapStructuredToolValue(record.output)
    if (record.toolResult) return unwrapStructuredToolValue(record.toolResult)
    if (record.tool_result) return unwrapStructuredToolValue(record.tool_result)
    if (record.data) return unwrapStructuredToolValue(record.data)
    if (record.content) return unwrapStructuredToolValue(record.content)
  }

  return parsed
}

export function unwrapSubagentToolResult(raw: unknown): unknown {
  if (raw == null) return raw

  const seen = new WeakSet<object>()

  const unwrapValue = (value: any, depth = 0): any => {
    if (value == null || depth > 6) return value

    if (typeof value === 'string') {
      const parsed = parseJsonIfLikely(value)
      if (parsed !== value) return unwrapValue(parsed, depth + 1)
      return value
    }

    if (Array.isArray(value)) {
      if (value.length === 1) return unwrapValue(value[0], depth + 1)

      const allTextBlocks = value.every(
        (item) => item && typeof item === 'object' && typeof item.text === 'string'
      )
      if (allTextBlocks) {
        return unwrapValue(value.map((item: any) => item.text).join(''), depth + 1)
      }

      const firstWithPayload = value.find(
        (item) =>
          item &&
          typeof item === 'object' &&
          ('output' in item || 'result' in item || 'content' in item)
      )
      if (firstWithPayload) return unwrapValue(firstWithPayload, depth + 1)

      return value
    }

    if (typeof value === 'object') {
      const obj = value as Record<string, any>
      if (seen.has(obj)) return obj
      seen.add(obj)

      if (
        typeof obj.text === 'string' &&
        obj.output === undefined &&
        obj.result === undefined &&
        obj.content === undefined
      ) {
        return unwrapValue(obj.text, depth + 1)
      }

      const direct = obj.output ?? obj.result ?? obj.content ?? obj.value
      if (direct !== undefined) {
        const normalized = unwrapValue(direct, depth + 1)
        if (
          normalized &&
          typeof normalized === 'object' &&
          (normalized.output || normalized.result || normalized.content)
        ) {
          return unwrapValue(normalized, depth + 1)
        }

        return {
          ...obj,
          output: normalized
        }
      }

      return obj
    }

    return value
  }

  const unwrapped = unwrapValue(Array.isArray(raw) && raw.length === 1 ? raw[0] : raw)
  if (unwrapped == null) return raw
  if (typeof unwrapped === 'string') return { output: unwrapped }
  return unwrapped
}

export function looksLikeDynamicMcpPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Record<string, any>
  const hasResult = 'result' in payload || 'output' in payload
  const hasName =
    'toolName' in payload ||
    'tool_name' in payload ||
    'name' in payload ||
    'tool' in payload
  const hasTiming = 'executionTimeMs' in payload || 'executionTime' in payload
  return hasResult && (hasTiming || hasName)
}

export function extractDynamicMcpPayload(value: unknown): Record<string, any> | null {
  const parsed = parseJsonIfLikely(value)
  const candidates = Array.isArray(parsed) ? parsed : [parsed]

  for (const candidate of candidates) {
    const parsedCandidate = parseJsonIfLikely(candidate)
    if (looksLikeDynamicMcpPayload(parsedCandidate)) {
      return parsedCandidate as Record<string, any>
    }
  }

  return null
}

export function extractDynamicMcpParams(value: unknown): Record<string, any> | null {
  const parsed = parseJsonIfLikely(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  if ('params' in parsed) {
    const paramsCandidate = parseJsonIfLikely((parsed as any).params)
    if (typeof paramsCandidate === 'string' && paramsCandidate.includes('[Circular]')) {
      return null
    }
    if (paramsCandidate && typeof paramsCandidate === 'object' && !Array.isArray(paramsCandidate)) {
      return paramsCandidate as Record<string, any>
    }
  }

  if ('arguments' in parsed) {
    return extractDynamicMcpParams((parsed as any).arguments)
  }

  const hasWrapperKeys =
    'toolName' in parsed ||
    'tool' in parsed ||
    'userId' in parsed ||
    'user_id' in parsed
  if (hasWrapperKeys) {
    const cleaned: Record<string, any> = { ...(parsed as any) }
    delete cleaned.toolName
    delete cleaned.tool
    delete cleaned.userId
    delete cleaned.user_id
    if (
      Object.keys(cleaned).length === 1 &&
      typeof cleaned.params === 'string' &&
      cleaned.params.includes('[Circular]')
    ) {
      return null
    }
    return Object.keys(cleaned).length > 0 ? cleaned : null
  }

  return null
}

export function extractDynamicMcpToolNameFromArgs(value: unknown): string | undefined {
  const parsed = parseJsonIfLikely(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined

  const candidates = [
    (parsed as any).toolName,
    (parsed as any).tool,
    (parsed as any).params?.toolName,
    (parsed as any).params?.tool,
    (parsed as any).arguments?.toolName,
    (parsed as any).arguments?.tool,
    (parsed as any).arguments?.params?.toolName,
    (parsed as any).arguments?.params?.tool
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate
    }
  }

  return undefined
}

export function unwrapDynamicMcpUsePayload(options: {
  wrapperToolName: string | undefined
  rawArgs?: unknown
  rawResult?: unknown
  normalizeResult?: (value: unknown) => unknown
}): DynamicMcpUnwrapResult | null {
  const { wrapperToolName, rawArgs, rawResult, normalizeResult } = options
  if (!isDynamicMcpUseToolName(wrapperToolName)) return null

  const payload = extractDynamicMcpPayload(rawResult)
  if (!payload) return null

  const executedToolName =
    payload.toolName ||
    payload.tool_name ||
    payload.name ||
    payload.tool ||
    extractDynamicMcpToolNameFromArgs(rawArgs)

  const params =
    extractDynamicMcpParams(rawArgs) ||
    extractDynamicMcpParams(payload.input) ||
    null

  let result = payload.result ?? payload.output
  result = normalizeResult ? normalizeResult(result) : unwrapToolTextArray(result)

  return {
    toolName: executedToolName || wrapperToolName || 'tool',
    params,
    result,
    executionTimeMs: payload.executionTimeMs ?? payload.executionTime
  }
}

export function unwrapDynamicMcpStep(
  step: any,
  options?: { normalizeResult?: (value: unknown) => unknown }
): DynamicMcpStepUnwrapResult | null {
  const wrapperToolName = step?.toolName || step?.tool || step?.action?.tool
  const rawResult =
    step?.toolResult ??
    step?.output ??
    step?.result ??
    step?.toolOutput ??
    step?.observation

  const unwrapped = unwrapDynamicMcpUsePayload({
    wrapperToolName,
    rawArgs: step?.toolArgs ?? step?.toolInput ?? step?.input,
    rawResult,
    normalizeResult: options?.normalizeResult
  })

  if (!unwrapped) return null

  return {
    ...unwrapped,
    wrapperToolName
  }
}
