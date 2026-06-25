import { redis } from '$lib/server/redis'
import type { RedisJSON } from '@redis/json'
import type { ExecutionSnapshot } from '$lib/types/executionViewer'

const EXECUTION_VIEWER_MAX_PATCH_STRING_CHARS = 120_000
const EXECUTION_VIEWER_STRING_HEAD_CHARS = 80_000
const EXECUTION_VIEWER_STRING_TAIL_CHARS = 20_000
const EXECUTION_VIEWER_MAX_SNAPSHOTS = 10
const DATA_IMAGE_URL_REGEX =
  /data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)/gi

function approxBase64Bytes(value: string): number {
  return Math.max(0, Math.floor(value.replace(/\s+/g, '').length * 3 / 4))
}

function isLikelyBase64Payload(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 256) return false
  if (trimmed.startsWith('data:')) return true
  return /^[a-z0-9+/=\r\n]+$/i.test(trimmed)
}

function redactDataImageUrls(value: string): string {
  if (!value || !value.toLowerCase().includes('data:image/')) return value
  return value.replace(
    DATA_IMAGE_URL_REGEX,
    (_full, mediaType: string, base64Data: string) =>
      `[redacted ${mediaType} data URL (${approxBase64Bytes(base64Data).toLocaleString()} bytes)]`
  )
}

class ExecutionViewerService {
  private getKey(sessionId: string) {
    return `session:${sessionId}:execution_log`
  }

  private buildTruncationMarker(omittedChars: number): string {
    return `\n\n[Execution Viewer stored preview truncated ${omittedChars.toLocaleString()} characters. Full output remains available in chat/zips or the source runtime.]`
  }

  private boundDebugPayload<T>(value: T): T {
    const seen = new WeakSet<object>()

    const visit = (node: unknown, key?: string): unknown => {
      if (typeof node === 'string') {
        const redacted = redactDataImageUrls(node)
        if (
          key &&
          /(base64|localbase64|b64|b64_json|image_data)/i.test(key) &&
          isLikelyBase64Payload(redacted)
        ) {
          return `[redacted base64 payload (${approxBase64Bytes(node).toLocaleString()} bytes)]`
        }

        if (redacted.length <= EXECUTION_VIEWER_MAX_PATCH_STRING_CHARS) {
          return redacted
        }

        const omitted = Math.max(
          0,
          redacted.length - EXECUTION_VIEWER_STRING_HEAD_CHARS - EXECUTION_VIEWER_STRING_TAIL_CHARS
        )
        return `${redacted.slice(0, EXECUTION_VIEWER_STRING_HEAD_CHARS)}${this.buildTruncationMarker(omitted)}\n\n${redacted.slice(-EXECUTION_VIEWER_STRING_TAIL_CHARS)}`
      }

      if (!node || typeof node !== 'object') {
        return node
      }

      if (seen.has(node as object)) {
        return '[Execution Viewer omitted circular reference]'
      }
      seen.add(node as object)

      if (Array.isArray(node)) {
        return node.map((entry) => visit(entry, key))
      }

      const output: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        output[key] = visit(child, key)
      }
      return output
    }

    return visit(value) as T
  }

  private prepareSnapshotForStorage(snapshot: ExecutionSnapshot): ExecutionSnapshot {
    return this.boundDebugPayload(structuredClone(snapshot))
  }

  private preparePatchForStorage(patch: Partial<ExecutionSnapshot>): Partial<ExecutionSnapshot> {
    return this.boundDebugPayload(structuredClone(patch))
  }

  private parseRedisJsonPathArray<T>(raw: unknown): T[] | null {
    if (raw == null) return null
    if (Array.isArray(raw)) return raw as T[]
    if (typeof raw !== 'string') return null

    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed as T[] : null
    } catch {
      return null
    }
  }

  private async getSnapshotIds(client: any, key: string): Promise<string[] | null> {
    if (typeof client.sendCommand === 'function') {
      try {
        const raw = await client.sendCommand(['JSON.GET', key, '$[*].id'])
        return this.parseRedisJsonPathArray<string>(raw)
      } catch {
        // Fall through to the client JSON helper when direct RedisJSON path
        // commands are unavailable or temporarily fail.
      }
    }

    const data = await client.json.get(key)
    if (!Array.isArray(data)) return null
    return (data as unknown as ExecutionSnapshot[])
      .map((entry) => (typeof entry?.id === 'string' ? entry.id : ''))
      .filter(Boolean)
  }

  private async getSnapshotAt(
    client: any,
    key: string,
    index: number
  ): Promise<ExecutionSnapshot | null> {
    if (typeof client.sendCommand === 'function') {
      try {
        const raw = await client.sendCommand(['JSON.GET', key, `$[${index}]`])
        const parsed = this.parseRedisJsonPathArray<ExecutionSnapshot>(raw)
        return parsed?.[0] ?? null
      } catch {
        // Fall through to the client JSON helper when direct RedisJSON path
        // commands are unavailable or temporarily fail.
      }
    }

    const data = await client.json.get(key)
    if (!Array.isArray(data)) return null
    return (data as unknown as ExecutionSnapshot[])[index] ?? null
  }

  private async setSnapshotAt(
    client: any,
    key: string,
    index: number,
    snapshot: ExecutionSnapshot
  ): Promise<void> {
    if (typeof client.sendCommand === 'function') {
      try {
        await client.sendCommand(['JSON.SET', key, `$[${index}]`, JSON.stringify(snapshot)])
        return
      } catch {
        // Fall through to full-array replacement as a compatibility fallback.
      }
    }

    const data = await client.json.get(key)
    if (!Array.isArray(data)) return
    const entries = structuredClone(data as unknown as ExecutionSnapshot[])
    entries[index] = snapshot
    await client.json.set(key, '$', entries as unknown as RedisJSON)
  }

  private async appendSnapshot(
    client: any,
    key: string,
    snapshot: ExecutionSnapshot
  ): Promise<void> {
    if (typeof client.sendCommand === 'function') {
      try {
        await client.sendCommand(['JSON.ARRAPPEND', key, '$', JSON.stringify(snapshot)])
        return
      } catch {
        // Fall through to the client JSON helper so existing entries are preserved.
      }
    }

    const data = await client.json.get(key)
    if (!Array.isArray(data)) {
      await client.json.set(key, '$', [snapshot] as unknown as RedisJSON)
      return
    }

    const entries = structuredClone(data as unknown as ExecutionSnapshot[])
    entries.push(snapshot)
    await client.json.set(key, '$', entries as unknown as RedisJSON)
  }

  private async trimSnapshots(client: any, key: string): Promise<void> {
    if (typeof client.sendCommand === 'function') {
      try {
        await client.sendCommand([
          'JSON.ARRTRIM',
          key,
          '$',
          String(-EXECUTION_VIEWER_MAX_SNAPSHOTS),
          '-1'
        ])
        return
      } catch {
        // Fall through to full-array replacement for Redis clients/fakes that
        // do not expose JSON.ARRTRIM.
      }
    }

    const data = await client.json.get(key)
    if (!Array.isArray(data) || data.length <= EXECUTION_VIEWER_MAX_SNAPSHOTS) return
    await client.json.set(
      key,
      '$',
      data.slice(-EXECUTION_VIEWER_MAX_SNAPSHOTS) as unknown as RedisJSON
    )
  }

  private buildLlmCallFingerprint(call: any): string {
    const safe = {
      runtime: call?.runtime ?? null,
      requestPayload: call?.requestPayload ?? null,
      responsePayload: call?.responsePayload ?? null,
      rawResponsePayload: call?.rawResponsePayload ?? null,
      finishReason: call?.finishReason ?? null,
      toolCallsCount:
        typeof call?.toolCallsCount === 'number' ? call.toolCallsCount : null,
      toolResultsCount:
        typeof call?.toolResultsCount === 'number' ? call.toolResultsCount : null,
      usage: call?.usage ?? null
    }
    try {
      return JSON.stringify(safe)
    } catch {
      return `${safe.runtime ?? 'unknown'}:${safe.finishReason ?? 'none'}:${Date.now()}`
    }
  }

  private mergeLlmCalls(existingValue: unknown, incomingValue: unknown): any[] | null {
    const existing = Array.isArray(existingValue) ? existingValue : []
    const incoming = Array.isArray(incomingValue) ? incomingValue : []
    if (existing.length === 0 && incoming.length === 0) return null

    const existingAreN8n =
      existing.length > 0 &&
      existing.every((call) => call && typeof call === 'object' && call.runtime === 'n8n')
    const incomingAreN8n =
      incoming.length > 0 &&
      incoming.every((call) => call && typeof call === 'object' && call.runtime === 'n8n')

    // n8n hydration rebuilds synthetic call rows after the stream closes. When a fuller
    // n8n call list arrives, replace the earlier synthetic rows instead of stacking them.
    if (existingAreN8n && incomingAreN8n) {
      return incoming.map((call, index) => ({
        ...call,
        index: index + 1,
      }))
    }

    const merged: any[] = []
    const seen = new Set<string>()

    for (const call of [...existing, ...incoming]) {
      if (!call || typeof call !== 'object') continue
      const fingerprint = this.buildLlmCallFingerprint(call)
      if (seen.has(fingerprint)) continue
      seen.add(fingerprint)
      merged.push({ ...call })
    }

    return merged.map((call, index) => ({
      ...call,
      index: index + 1
    }))
  }

  async recordSnapshot(snapshot: ExecutionSnapshot): Promise<void> {
    const key = this.getKey(snapshot.sessionId)
    const entry = this.prepareSnapshotForStorage(snapshot)

    await redis.execute(async (client) => {
      const ids = await this.getSnapshotIds(client, key)
      if (!ids) {
        await client.json.set(key, '$', [entry] as unknown as RedisJSON)
        await this.trimSnapshots(client, key)
        return
      }

      const lastMatchingIndex = ids.lastIndexOf(entry.id)
      if (lastMatchingIndex >= 0) {
        const current = await this.getSnapshotAt(client, key, lastMatchingIndex)
        if (!current) {
          await this.appendSnapshot(client, key, entry)
          await this.trimSnapshots(client, key)
          return
        }
        await this.setSnapshotAt(client, key, lastMatchingIndex, {
          ...current,
          ...entry,
          runtime: entry.runtime
            ? { ...(current.runtime ?? {}), ...entry.runtime }
            : current.runtime
        })
        await this.trimSnapshots(client, key)
      } else {
        await this.appendSnapshot(client, key, entry)
        await this.trimSnapshots(client, key)
      }
    })
  }

  async getSnapshots(sessionId: string): Promise<ExecutionSnapshot[]> {
    const key = this.getKey(sessionId)

    return await redis.execute(async (client) => {
      const data = await client.json.get(key)
      if (!data) {
        return []
      }

      const entries = Array.isArray(data) ? (data as unknown as ExecutionSnapshot[]) : []

      return entries
        .map((entry) => ({ ...entry }))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    })
  }

  async clearSnapshots(sessionId: string): Promise<void> {
    const key = this.getKey(sessionId)
    await redis.execute(async (client) => {
      await client.del(key)
    })
  }

  async updateSnapshot(
    sessionId: string,
    snapshotId: string,
    patch: Partial<ExecutionSnapshot>
  ): Promise<void> {
    const key = this.getKey(sessionId)
    const boundedPatch = this.preparePatchForStorage(patch)

    await redis.execute(async (client) => {
      const ids = await this.getSnapshotIds(client, key)
      if (!ids) return
      const index = ids.lastIndexOf(snapshotId)
      if (index === -1) {
        return
      }

      const current = await this.getSnapshotAt(client, key, index)
      if (!current) return

      const mergedLlmCalls = this.mergeLlmCalls(current.llmCalls, boundedPatch.llmCalls)

      const nextLlmSummary = (() => {
        const base =
          boundedPatch.llmSummary && typeof boundedPatch.llmSummary === 'object'
            ? { ...boundedPatch.llmSummary }
            : current.llmSummary && typeof current.llmSummary === 'object'
              ? { ...current.llmSummary }
              : null
        if (!base || !Array.isArray(mergedLlmCalls)) return base

        const callsCountValue = mergedLlmCalls.length
        base.callsCount = {
          ...(base.callsCount ?? {}),
          value: callsCountValue,
          confidence:
            base.callsCount?.confidence ??
            (callsCountValue > 0 ? 'exact' : 'near'),
          source: base.callsCount?.source ?? 'execution viewer merge'
        }
        return base
      })()

      const next: ExecutionSnapshot = {
        ...current,
        ...boundedPatch,
        ...(mergedLlmCalls ? { llmCalls: mergedLlmCalls } : {}),
        ...(nextLlmSummary ? { llmSummary: nextLlmSummary } : {}),
        runtime: boundedPatch.runtime
          ? { ...(current.runtime ?? {}), ...boundedPatch.runtime }
          : current.runtime
      }

      await this.setSnapshotAt(client, key, index, next)
    })
  }
}

export const executionViewerService = new ExecutionViewerService()
