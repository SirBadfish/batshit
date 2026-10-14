/**
 * BL-1397: the default lane's twins of `redis.json.moveLegacyN8nToken` and `deleteN8nToken`
 * (scripts in `$lib/server/n8nCredentialScripts.ts`), over one fake's JSON documents. Answers go
 * through the scripts' own readers.
 *
 * Bounded on purpose: the key and the registry are read only at `$`, an element only at
 * `$.gateways[<n>]`, and a copy only at `$.gateways[<n>].metadata.authToken`; any other path
 * throws. Like the scripts, every check runs before the first write, and a write that cannot apply
 * part way answers `PARTIAL` with the earlier writes kept (Lua does not undo them).
 */
import {
  readLegacyN8nTokenMoveAnswer,
  readN8nTokenDeleteAnswer,
  type LegacyN8nTokenMoveAnswer,
  type N8nTokenDeleteAnswer
} from '$lib/server/n8nCredentialScripts'
import type { JsonDocumentStore } from '$lib/test-utils/redisJsonCompareAndWriteTwin'

const ELEMENT_PATH = /^\$\.gateways\[(\d+)\]$/
const COPY_PATH = /^\$\.gateways\[(\d+)\]\.metadata\.authToken$/

function copyOf<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

function rootRaw(store: JsonDocumentStore, key: string): string {
  const document = store.read(key)
  return document === undefined ? '' : JSON.stringify([document])
}

function gatewaysOf(document: unknown): unknown[] | null {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null
  const list = (document as Record<string, unknown>).gateways
  return Array.isArray(list) ? list : null
}

function indexOf(pattern: RegExp, path: string): number {
  const match = pattern.exec(path)
  if (!match) throw new Error(`The n8n credential twin does not read "${path}".`)
  return Number(match[1])
}

function copyHolder(document: unknown, index: number): Record<string, unknown> | null {
  const element = gatewaysOf(document)?.[index]
  if (!element || typeof element !== 'object') return null
  const metadata = (element as Record<string, unknown>).metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  return typeof (metadata as Record<string, unknown>).authToken === 'string'
    ? (metadata as Record<string, unknown>)
    : null
}

export function createN8nCredentialScriptTwins(store: JsonDocumentStore) {
  const moveLegacyN8nToken = async (
    keyKey: string,
    registryKey: string,
    expectedKeyRaw: string,
    elementPath: string,
    expectedElementRaw: string,
    newKeyDocument: unknown | null
  ): Promise<LegacyN8nTokenMoveAnswer> => {
    const index = indexOf(ELEMENT_PATH, elementPath)
    if (rootRaw(store, keyKey) !== expectedKeyRaw) return readLegacyN8nTokenMoveAnswer(['CHANGED'])
    const registry = store.read(registryKey)
    const list = registry === undefined ? null : gatewaysOf(registry)
    const elementRaw = registry === undefined ? '' : list && index < list.length ? JSON.stringify([list[index]]) : '[]'
    if (elementRaw !== expectedElementRaw) return readLegacyN8nTokenMoveAnswer(['CHANGED'])
    if (!copyHolder(registry, index)) return readLegacyN8nTokenMoveAnswer(['INVALID', 'copy'])

    if (newKeyDocument !== null) {
      if (expectedKeyRaw !== '') return readLegacyN8nTokenMoveAnswer(['INVALID', 'key exists'])
      if (store.read(keyKey) !== undefined) return readLegacyN8nTokenMoveAnswer(['FAILED', 'key'])
      store.write(keyKey, copyOf(newKeyDocument))
    }
    const next = copyOf(registry)
    delete copyHolder(next, index)!.authToken
    store.write(registryKey, next)
    return readLegacyN8nTokenMoveAnswer(['OK'])
  }

  const deleteN8nToken = async (
    keyKey: string,
    registryKey: string,
    expectedKeyRaw: string,
    expectedRegistryRaw: string,
    copyPaths: string[]
  ): Promise<N8nTokenDeleteAnswer> => {
    const indexes = copyPaths.map((path) => indexOf(COPY_PATH, path))
    if (rootRaw(store, keyKey) !== expectedKeyRaw) return readN8nTokenDeleteAnswer(['KEY_CHANGED'])
    if (rootRaw(store, registryKey) !== expectedRegistryRaw) return readN8nTokenDeleteAnswer(['CHANGED'])
    const registry = store.read(registryKey)
    for (let n = 0; n < indexes.length; n += 1) {
      if (!copyHolder(registry, indexes[n])) return readN8nTokenDeleteAnswer(['INVALID', copyPaths[n]])
    }
    let cleared = 0
    for (const index of indexes) {
      const next = copyOf(store.read(registryKey))
      const holder = copyHolder(next, index)
      if (!holder) return readN8nTokenDeleteAnswer(['PARTIAL', cleared])
      delete holder.authToken
      store.write(registryKey, next)
      cleared += 1
    }
    if (expectedKeyRaw !== '') {
      if (store.read(keyKey) === undefined) return readN8nTokenDeleteAnswer(['PARTIAL', cleared])
      store.remove(keyKey)
    }
    return readN8nTokenDeleteAnswer(['OK', cleared])
  }

  return { moveLegacyN8nToken, deleteN8nToken }
}
