import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { Unzip, UnzipInflate } from 'fflate/node'
import { AgentPluginError } from './agentPlugins'

const MAX_BYTES = 32 * 1024 * 1024, MAX_FILE = 2 * 1024 * 1024, MAX_ENTRIES = 2048
const invalid = (message: string) => new AgentPluginError('PLUGIN_ARCHIVE_INVALID', message, 400)
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** One captured archive, no filesystem extraction and no path-based recursive source reads. */
export async function capturePluginArchiveFiles(source: string): Promise<Map<string, Buffer>> {
  if (!path.isAbsolute(source) || path.extname(source).toLowerCase() !== '.zip') throw invalid('Choose an absolute path to a complete plugin ZIP file as seen by Batshit.')
  const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY)
  let bytes: Buffer
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES) throw invalid('The plugin ZIP must be a regular, unlinked file no larger than 32 MB.')
    bytes = Buffer.alloc(before.size)
    let position = 0
    while (position < bytes.length) {
      const read = await handle.read(bytes, position, bytes.length - position, position)
      if (!read.bytesRead) throw invalid('The plugin ZIP was truncated while being read.')
      position += read.bytesRead
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, before.size)).bytesRead) throw invalid('The plugin ZIP grew while being read.')
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size) throw invalid('The plugin ZIP changed while being read. Nothing was imported.')
  } finally { await handle.close() }
  return readPluginArchive(bytes)
}

export function readPluginArchive(bytes: Buffer): Map<string, Buffer> {
  if (bytes.length > MAX_BYTES || bytes.length < 22) throw invalid('The plugin ZIP is invalid or too large.')
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) throw invalid('Use a complete single-volume plugin ZIP.')
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), centralStart = bytes.readUInt32LE(end + 16)
  if (!count || count > MAX_ENTRIES || count !== bytes.readUInt16LE(end + 8) || centralStart + centralSize !== end) throw invalid('The plugin ZIP directory is incomplete or exceeds supported limits.')
  const inventory = new Map<string, { size: number; crc: number; compression: number }>()
  const portableNames = new Set<string>()
  let offset = centralStart, total = 0
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw invalid('The plugin ZIP directory is invalid.')
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32)
    const next = offset + 46 + nameLength + extra + comment
    if (next > end) throw invalid('The plugin ZIP directory is truncated.')
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength), name = nameBytes.toString('utf8')
    const portableName = name.replace(/\/$/, '').normalize('NFC').toLowerCase()
    if (portableNames.has(portableName)) throw invalid('The plugin ZIP contains paths that collide on a supported filesystem.')
    portableNames.add(portableName)
    const size = bytes.readUInt32LE(offset + 24), compressed = bytes.readUInt32LE(offset + 20), local = bytes.readUInt32LE(offset + 42)
    const mode = bytes.readUInt32LE(offset + 38) >>> 16, kind = mode & 0xf000, compression = bytes.readUInt16LE(offset + 10)
    if (!name || !Buffer.from(name).equals(nameBytes) || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(part => part === '..' || part === '.') || inventory.has(name)) throw invalid('The plugin ZIP contains an unsafe or duplicate path.')
    if (kind && kind !== 0x8000 && kind !== 0x4000) throw invalid('Plugin ZIP symlinks and special files are not supported.')
    if (bytes.readUInt16LE(offset + 8) & 1 || ![0, 8].includes(compression) || bytes.readUInt16LE(offset + 34) !== 0) throw invalid('Encrypted or unsupported plugin ZIP entries are not supported.')
    if (size > MAX_FILE || (total += size) > MAX_BYTES) throw invalid('The expanded plugin ZIP exceeds supported size limits.')
    if (local + 30 > centralStart || bytes.readUInt32LE(local) !== 0x04034b50) throw invalid('The plugin ZIP file header is invalid.')
    const localNameLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), dataStart = local + 30 + localNameLength + localExtra
    if (dataStart + compressed > centralStart || bytes.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== name || bytes.readUInt16LE(local + 8) !== compression || bytes.readUInt16LE(local + 6) & 1) throw invalid('The plugin ZIP headers disagree.')
    inventory.set(name, { size, crc: bytes.readUInt32LE(offset + 16), compression })
    offset = next
  }
  if (offset !== end) throw invalid('The plugin ZIP has an inconsistent directory.')
  const captured = new Map<string, Buffer>(), seen = new Set<string>()
  let expanded = 0
  const reader = new Unzip(file => {
    const expected = inventory.get(file.name)
    if (!expected || seen.has(file.name) || file.compression !== expected.compression) throw invalid('The plugin ZIP has an unlisted or duplicate file.')
    seen.add(file.name)
    const chunks: Buffer[] = []
    let length = 0
    file.ondata = (error, data, final) => {
      if (error) throw error instanceof AgentPluginError ? error : invalid('A plugin ZIP file could not be read.')
      length += data.length; expanded += data.length
      if (length > expected.size || length > MAX_FILE || expanded > MAX_BYTES) { file.terminate(); throw invalid('The expanded plugin ZIP exceeds its declared size.') }
      chunks.push(Buffer.from(data))
      if (final) {
        const content = Buffer.concat(chunks)
        if (length !== expected.size || crc32(content) !== expected.crc) throw invalid('A plugin ZIP file failed its integrity check.')
        if (!file.name.endsWith('/')) captured.set(file.name, content)
      }
    }
    file.start()
  })
  reader.register(UnzipInflate)
  try {
    for (let start = 0; start < bytes.length; start += 1024) reader.push(bytes.subarray(start, Math.min(start + 1024, bytes.length)), start + 1024 >= bytes.length)
  } catch (error) { if (error instanceof AgentPluginError) throw error; throw invalid('The plugin ZIP could not be read.') }
  if (seen.size !== inventory.size || captured.size !== [...inventory.keys()].filter(name => !name.endsWith('/')).length) throw invalid('The plugin ZIP is incomplete.')
  if (captured.has('plugin.json')) return captured
  const candidates = [...captured.keys()].filter(name => /^[^/]+\/plugin\.json$/.test(name))
  if (candidates.length !== 1) throw invalid('The plugin ZIP must contain one root plugin.json.')
  const prefix = candidates[0].slice(0, -'plugin.json'.length)
  if ([...captured.keys()].some(name => !name.startsWith(prefix))) throw invalid('The plugin ZIP must contain exactly one plugin folder.')
  return new Map([...captured].map(([name, content]) => [name.slice(prefix.length), content]))
}
