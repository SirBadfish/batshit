/**
 * Saved copies of MCP tool server tool lists (2026-09-18).
 *
 * Asking a tool server for its tool list opens a fresh MCP client (or spawns a STDIO server)
 * and takes 1-11 s; every send asked every tool server its agent can reach, and nothing kept
 * the answer. Josh's rule: "a copy should be saved unless the user updates the tool settings."
 *
 * - **One copy per user, gateway, and exactly what the lookup used.** The caller names the
 *   lookup's inputs (the URL after the runtime rewrite, a fingerprint of the token, a STDIO
 *   server's resolved launch), so any change to any of them is a miss by itself, even a
 *   change made outside the gateway service (a restore, another Batshit process on the same
 *   Redis, a new API key value). Secrets arrive already hashed (`fingerprintSecret`).
 * - **A good list is kept five minutes**, because a tool server can change its own list (the
 *   Docker catalog, an n8n workflow, a remote server). **A failure is kept thirty seconds**, so
 *   a server that comes back is seen soon; it is still reported as a failure every time.
 * - **Callers that arrive while the same lookup runs share it.**
 * - **A clear wins over a lookup already running**: a lookup that started before a clear
 *   answers its own callers but never saves (the schedule due cache's generation pattern).
 * - **Filtering is the caller's job, after the copy**: which gateways an agent may reach is
 *   decided before a lookup and which tools it may see after, so a copy can never change what
 *   an agent may see (tool discovery is an authorization contract).
 * - **In-process only.** No Redis key, so nothing to back up, restore, or sweep; each Batshit
 *   process keeps its own copies.
 */

import { createHash } from 'node:crypto'

import type { MCPGateway } from '$lib/types/database'
import type { ToolWithName } from './mcpGatewayTypes'

/** How long a good tool list is used before the tool server is asked again. */
export const MCP_TOOL_LIST_SAVED_MS = 5 * 60_000

/** How long a failed lookup is remembered, so a server that comes back is seen soon. */
export const MCP_TOOL_LIST_FAILURE_SAVED_MS = 30_000

export type ToolListLookup =
  | { ok: true; tools: ToolWithName[] }
  | { ok: false; error: string }

/** `live`: this read asked the tool server. `saved`: a saved copy. `joined`: shared a lookup already running. */
export type ToolListSource = 'live' | 'saved' | 'joined'

export interface ToolListAnswer {
  lookup: ToolListLookup
  source: ToolListSource
  /** When the tool server gave this answer (ms since the epoch). */
  fetchedAt: number
}

export interface ToolListKey {
  userId: string
  gatewayId: string
  /** Everything the lookup used. Secrets must already be hashed with `fingerprintSecret`. */
  inputs: Record<string, unknown>
}

export interface McpToolListCache {
  /**
   * The saved answer for `key`, or the answer of `lookup`. `fresh` (the Refresh button) throws
   * the gateway's copies and running lookups away first, then asks.
   */
  read(
    key: ToolListKey,
    lookup: () => Promise<ToolListLookup>,
    options?: { fresh?: boolean }
  ): Promise<ToolListAnswer>
  /** The user changed this gateway's settings. */
  clearGateway(userId: string, gatewayId: string): void
  /** The user's gateways or keys were replaced (a restore). */
  clearUser(userId: string): void
  clearAll(): void
  /** Copies held right now, expired ones included until the next save sweeps them. */
  size(): number
}

/** SHA-256 of a secret, so a key can tell two tokens apart without holding either. */
export function fingerprintSecret(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** JSON with object keys sorted, so the same inputs always make the same key. Array order counts. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([name, entry]) => `${JSON.stringify(name)}:${stableStringify(entry)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const SEPARATOR = '\u0000'

function gatewayScope(userId: string, gatewayId: string): string {
  return `${userId}${SEPARATOR}${gatewayId}`
}

function keyId(key: ToolListKey): string {
  const inputs = createHash('sha256').update(stableStringify(key.inputs), 'utf8').digest('hex')
  return `${gatewayScope(key.userId, key.gatewayId)}${SEPARATOR}${inputs}`
}

/** The saved list must not change when a caller changes the array it was handed. */
function handOut(lookup: ToolListLookup): ToolListLookup {
  return lookup.ok ? { ok: true, tools: [...lookup.tools] } : lookup
}

type SavedCopy = {
  userId: string
  gatewayId: string
  lookup: ToolListLookup
  fetchedAt: number
  expiresAt: number
}

type RunningLookup = {
  userId: string
  gatewayId: string
  done: Promise<{ lookup: ToolListLookup; fetchedAt: number }>
}

export function createMcpToolListCache(options: {
  now?: () => number
  savedMs?: number
  failureSavedMs?: number
} = {}): McpToolListCache {
  const now = options.now ?? (() => Date.now())
  const savedMs = options.savedMs ?? MCP_TOOL_LIST_SAVED_MS
  const failureSavedMs = options.failureSavedMs ?? MCP_TOOL_LIST_FAILURE_SAVED_MS

  const copies = new Map<string, SavedCopy>()
  const running = new Map<string, RunningLookup>()
  // Bumped by every clear, so a lookup that started before it cannot save its older answer.
  let allGeneration = 0
  const userGenerations = new Map<string, number>()
  const gatewayGenerations = new Map<string, number>()

  const generationOf = (userId: string, gatewayId: string) =>
    `${allGeneration}:${userGenerations.get(userId) ?? 0}:${gatewayGenerations.get(gatewayScope(userId, gatewayId)) ?? 0}`

  const forget = (matches: (entry: { userId: string; gatewayId: string }) => boolean) => {
    for (const [id, copy] of copies) if (matches(copy)) copies.delete(id)
    for (const [id, lookup] of running) if (matches(lookup)) running.delete(id)
  }

  const sweepExpired = (at: number) => {
    for (const [id, copy] of copies) if (copy.expiresAt <= at) copies.delete(id)
  }

  const clearGateway = (userId: string, gatewayId: string) => {
    const scope = gatewayScope(userId, gatewayId)
    gatewayGenerations.set(scope, (gatewayGenerations.get(scope) ?? 0) + 1)
    forget((entry) => entry.userId === userId && entry.gatewayId === gatewayId)
  }

  return {
    async read(key, lookup, readOptions = {}) {
      const id = keyId(key)
      if (readOptions.fresh) {
        clearGateway(key.userId, key.gatewayId)
      } else {
        const copy = copies.get(id)
        if (copy && copy.expiresAt > now()) {
          return { lookup: handOut(copy.lookup), source: 'saved', fetchedAt: copy.fetchedAt }
        }
        const shared = running.get(id)
        if (shared) {
          const answer = await shared.done
          return { lookup: handOut(answer.lookup), source: 'joined', fetchedAt: answer.fetchedAt }
        }
      }

      const generation = generationOf(key.userId, key.gatewayId)
      const done = lookup().then((answer) => {
        const fetchedAt = now()
        if (generationOf(key.userId, key.gatewayId) === generation) {
          sweepExpired(fetchedAt)
          copies.set(id, {
            userId: key.userId,
            gatewayId: key.gatewayId,
            lookup: answer,
            fetchedAt,
            expiresAt: fetchedAt + (answer.ok ? savedMs : failureSavedMs)
          })
        }
        return { lookup: answer, fetchedAt }
      })
      const entry: RunningLookup = { userId: key.userId, gatewayId: key.gatewayId, done }
      running.set(id, entry)
      try {
        const answer = await done
        return { lookup: handOut(answer.lookup), source: 'live', fetchedAt: answer.fetchedAt }
      } finally {
        if (running.get(id) === entry) running.delete(id)
      }
    },

    clearGateway,

    clearUser(userId) {
      userGenerations.set(userId, (userGenerations.get(userId) ?? 0) + 1)
      forget((entry) => entry.userId === userId)
    },

    clearAll() {
      allGeneration += 1
      copies.clear()
      running.clear()
    },

    size() {
      return copies.size
    }
  }
}

/** The one cache every discovery path shares. */
export const mcpToolListCache = createMcpToolListCache()

// What a lookup or a Test writes back about itself; changing only these is not the user
// changing the tool settings. Everything else is, including fields added later.
const RECORD_KEEPING_FIELDS = new Set(['discoveredTools', 'lastDiscovery', 'updated_at'])
const STDIO_RECORD_KEEPING_FIELDS = new Set(['lastTestStatus', 'lastTestAt', 'lastError', 'toolCount'])

function withoutRecordKeeping(gateway: MCPGateway): Record<string, unknown> {
  const settings: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(gateway)) {
    if (RECORD_KEEPING_FIELDS.has(name)) continue
    if (name === 'stdioConfig' && value && typeof value === 'object') {
      settings[name] = Object.fromEntries(
        Object.entries(value).filter(([field]) => !STDIO_RECORD_KEEPING_FIELDS.has(field))
      )
      continue
    }
    settings[name] = value
  }
  return settings
}

/**
 * True when a gateway write is the user changing its tool settings: anything but the record
 * keeping a lookup or a Test writes back. A new or deleted gateway is a change.
 */
export function gatewayToolSettingsChanged(
  before: MCPGateway | null | undefined,
  after: MCPGateway | null | undefined
): boolean {
  if (!before || !after) return true
  return stableStringify(withoutRecordKeeping(before)) !== stableStringify(withoutRecordKeeping(after))
}
