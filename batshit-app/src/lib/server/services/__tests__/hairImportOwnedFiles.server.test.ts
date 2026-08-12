import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import {
  createHairImportTexturePng,
  strictJsonBytes
} from '../hairImportOwnedFiles.server'

function chunks(bytes: Uint8Array) {
  const values: Array<{ type: string; data: Uint8Array }> = []
  let offset = 8
  while (offset < bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset)
    const length = view.getUint32(0, false)
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8))
    values.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length) })
    offset += 12 + length
  }
  return values
}

describe('Hair import owned-file helpers', () => {
  it('creates deterministic RGBA PNGs for neutral value and highlight masks', () => {
    const neutral = createHairImportTexturePng('neutral-value', 4, 3)
    const repeated = createHairImportTexturePng('neutral-value', 4, 3)
    const highlight = createHairImportTexturePng('highlight-mask', 4, 3)

    expect(neutral).toEqual(repeated)
    expect([...neutral.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(neutral).not.toEqual(highlight)

    const raw = inflateSync(Buffer.concat(chunks(neutral).filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data)))
    expect(raw.byteLength).toBe(3 * (1 + 4 * 4))
    expect(raw[1]).toBe(128)
    expect(raw[4]).toBe(255)
  })

  it('serializes only JSON objects for immutable receipts', () => {
    expect(new TextDecoder().decode(strictJsonBytes({ b: 2, a: 1 }))).toBe('{"a":1,"b":2}\n')
    expect(() => strictJsonBytes(null)).toThrow(/one JSON object/)
    expect(() => strictJsonBytes([])).toThrow(/one JSON object/)
  })

  it('rejects unbounded generated texture dimensions', () => {
    expect(() => createHairImportTexturePng('neutral-value', 1, 64)).toThrow(/between 2 and 256/)
    expect(() => createHairImportTexturePng('neutral-value', 257, 64)).toThrow(/between 2 and 256/)
  })
})
