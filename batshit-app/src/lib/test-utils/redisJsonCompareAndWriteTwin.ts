/**
 * BL-1371: the default lane's twins of the facade's raw compare-and-set: `redis.json.getRaw`,
 * `setIfUnchanged` and `delIfUnchanged` (`$lib/server/redis.ts`, script in
 * `$lib/server/redisJsonCompareAndWrite.ts`). The shared fake (`vitest-setup.ts`) and the custom
 * fakes of the gateway service tests use them over their own stores.
 *
 * Bounded on purpose: these twins read and write exactly two path shapes, the root `$` and one
 * element of a top-level list `$.<field>[<n>]`, the two the gateway registry uses. Any other path
 * throws. They do not use or change how a fake's other JSON operations read paths.
 *
 * The answers keep RedisJSON's shapes: a missing key reads null; `$` reads `[<document>]`; an
 * element reads `[<element>]`, or `[]` when the list has no such element (or the field is not a
 * list). The text is `JSON.stringify` of that shape, so two reads of an unchanged value are equal
 * text and any write changes it, as on real Redis. A write after a passed compare that cannot
 * apply throws as the facade does (`UNWRITTEN`), and an element write into a missing key throws
 * RedisJSON's root error.
 */
import {
  jsonTextOf,
  readJsonCompareAndWriteAnswer,
  type JsonCompareAndWriteOperation
} from '$lib/server/redisJsonCompareAndWrite'

/** One fake's JSON documents. `read` answers `undefined` for a missing key. */
export interface JsonDocumentStore {
  read(key: string): unknown
  write(key: string, document: unknown): void
  remove(key: string): void
}

type CasPath = { kind: 'root' } | { kind: 'element'; field: string; index: number }

const ELEMENT_PATH = /^\$\.([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\]$/

function parseCasPath(path: string): CasPath {
  if (path === '$') return { kind: 'root' }
  const match = ELEMENT_PATH.exec(path)
  if (!match) {
    throw new Error(`The RedisJSON compare-and-write twin reads only "$" and "$.<field>[<n>]", not "${path}".`)
  }
  return { kind: 'element', field: match[1], index: Number(match[2]) }
}

function copyOf<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

function listAt(document: unknown, field: string): unknown[] | null {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null
  const list = (document as Record<string, unknown>)[field]
  return Array.isArray(list) ? list : null
}

function rawAt(store: JsonDocumentStore, key: string, path: string): string | null {
  const at = parseCasPath(path)
  const document = store.read(key)
  if (document === undefined) return null
  if (at.kind === 'root') return JSON.stringify([document])
  const list = listAt(document, at.field)
  return list && at.index < list.length ? JSON.stringify([list[at.index]]) : '[]'
}

function compareAndWrite(
  store: JsonDocumentStore,
  operation: JsonCompareAndWriteOperation,
  key: string,
  path: string,
  expectedRaw: string,
  value?: unknown
): boolean {
  const at = parseCasPath(path)
  const valueText = operation === 'SET' ? jsonTextOf(value) : ''
  const current = rawAt(store, key, path) ?? ''
  if (current !== expectedRaw) return readJsonCompareAndWriteAnswer('CHANGED', operation, key, path)

  const document = store.read(key)
  if (at.kind === 'root') {
    if (operation === 'SET') {
      store.write(key, JSON.parse(valueText))
      return readJsonCompareAndWriteAnswer('OK', operation, key, path)
    }
    if (document === undefined) return readJsonCompareAndWriteAnswer('UNWRITTEN', operation, key, path)
    store.remove(key)
    return readJsonCompareAndWriteAnswer('OK', operation, key, path)
  }

  if (document === undefined) {
    if (operation === 'DEL') return readJsonCompareAndWriteAnswer('UNWRITTEN', operation, key, path)
    // What `JSON.SET` answers for a path inside a key that does not exist.
    throw new Error('ERR new objects must be created at the root')
  }
  const next = copyOf(document) as Record<string, unknown>
  const list = listAt(next, at.field)
  if (!list || at.index >= list.length) return readJsonCompareAndWriteAnswer('UNWRITTEN', operation, key, path)
  if (operation === 'SET') list[at.index] = JSON.parse(valueText)
  else list.splice(at.index, 1)
  store.write(key, next)
  return readJsonCompareAndWriteAnswer('OK', operation, key, path)
}

/** The three twins over one store, as plain async functions (wrap them in `vi.fn` to spy). */
export function createJsonCompareAndWriteTwins(store: JsonDocumentStore) {
  return {
    getRaw: async (key: string, path: string): Promise<string | null> => rawAt(store, key, path),
    setIfUnchanged: async (key: string, path: string, expectedRaw: string, value: unknown): Promise<boolean> =>
      compareAndWrite(store, 'SET', key, path, expectedRaw, value),
    delIfUnchanged: async (key: string, path: string, expectedRaw: string): Promise<boolean> =>
      compareAndWrite(store, 'DEL', key, path, expectedRaw)
  }
}

/** The twins over a plain map of JSON documents (the gateway service tests' custom fakes). */
export function createJsonCompareAndWriteTwinsForMap(documents: Map<string, unknown>) {
  return createJsonCompareAndWriteTwins({
    read: (key) => (documents.has(key) ? documents.get(key) : undefined),
    write: (key, document) => {
      documents.set(key, document)
    },
    remove: (key) => {
      documents.delete(key)
    }
  })
}
