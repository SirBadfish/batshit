// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from './sha256'

const nodeHash = (text: string) => createHash('sha256').update(Buffer.from(new TextEncoder().encode(text))).digest('hex')

describe('sha256Hex (BL-474 step 2: the server and the page bind a decision to the same bytes)', () => {
  it('matches the standard test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  })

  it('equals node:crypto on text outside ASCII, block edges, and long text', () => {
    const cases = [
      'Hej! Här är en bild: <img src="https://bilder.example.se/örn.png"> 🦅 — ok',
      '日本語のテキスト と 絵文字 🧪🖤',
      'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65),
      'é'.repeat(1000),
      `${'lorem ipsum '.repeat(50_000)}end`
    ]
    for (const text of cases) expect(sha256Hex(text)).toBe(nodeHash(text))
  })

  it('reads a lone surrogate as U+FFFD, as UTF-8 storage keeps it', () => {
    expect(sha256Hex('a\uD800b')).toBe(sha256Hex('a�b'))
  })
})
